import json
import tempfile
import threading
import unittest
from pathlib import Path

from snooze.jobs import JobRegistry, validate_assignment
from snooze.credit_ledger import CreditDenied


def task(task_id="task-1", *, account="account-a", session_id=None, depends=None, scope=None, priority=None):
    value = {
        "taskId": task_id, "dependsOn": depends or [], "scopeKeys": [scope or f"path:src/{task_id}.txt"],
        "instructions": f"Do bounded work for {task_id}",
        "execution": {"mode": "existing-session", "sessionId": session_id or f"session-{account}", "accountId": account},
        "output": {"kind": "text", "maxBytes": 1024, "format": "plain", "expectedMarker": "DONE"},
    }
    if priority is not None:
        value["priority"] = priority
    return value


def fresh_task(task_id="fresh-1", *, account="account-a", workspace="workspace-a", stack="stack-a", provider="claude"):
    return {
        "taskId": task_id, "dependsOn": [], "scopeKeys": [f"path:src/{task_id}.txt"],
        "instructions": f"Do bounded work for {task_id}",
        "execution": {"mode": "fresh", "accountId": account, "workspaceId": workspace, "stackId": stack, "provider": provider},
        "output": {"kind": "text", "maxBytes": 1024, "format": "plain", "expectedMarker": "DONE"},
    }


def assignment(assignment_id="job-1", key="key-1", tasks=None, *, accounts=None, max_workers=3, project="project-a"):
    return {
        "schemaVersion": 1, "assignmentId": assignment_id, "idempotencyKey": key,
        "projectId": project, "eligibleAccountIds": accounts or ["account-a"], "maxWorkers": max_workers,
        "tasks": tasks or [task()],
    }


def usage(cost=0.0, prompts=0, budget=0.0, maximum=1.0, funding="plan", tier="standard"):
    return {"reportedSessionCostUsd": cost, "promptCount": prompts, "budgetUsed": budget,
            "maxBudget": maximum, "fundingSource": funding, "sandboxTier": tier}


class JobRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "private" / "jobs.sqlite3"
        self.registry = JobRegistry(self.db)
        self.register("account-a")

    def register(self, account, *, enabled=True, authorized=True, health="healthy", quota="available", sessions=None, capacity=1):
        return self.registry.register_account({
            "accountId": account, "enabled": enabled, "authorized": authorized, "health": health,
            "quota": quota, "allowUnknownQuota": False,
            "localCapacity": capacity,
            "registeredSessions": sessions if sessions is not None else [{"id": f"session-{account}", "model": "unknown", "workspace": "workspace-a"}],
        })

    def tearDown(self):
        self.temp.cleanup()

    def complete_one(self, assignment_id="job-1", now=10):
        operation = self.registry.claim_operation("node-1", now=now)
        self.assertEqual(operation["kind"], "chat_session")
        self.registry.record_result(operation["operationId"], {"workerId": "node-1", "outcome": "accepted"}, now=now + 1)
        observation = self.registry.claim_operation("node-1", now=now + 3)
        self.assertEqual(observation["kind"], "observe_session")
        self.registry.record_result(observation["operationId"], {"workerId": "node-1", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": "DONE result", "assistantAt": now + 2,
            "reportedModel": "model-a", "sessionId": operation["sessionId"]}}, now=now + 4)

    def test_submission_is_durable_and_idempotent(self):
        body = assignment()
        first = self.registry.submit(body, now=10)
        reopened = JobRegistry(self.db)
        self.register("account-a")
        retry = reopened.submit(body, now=11)
        self.assertEqual(first, retry)
        self.assertEqual(reopened.get_assignment("job-1")["state"], "queued")
        changed = assignment(assignment_id="job-2")
        with self.assertRaisesRegex(ValueError, "Idempotency"):
            reopened.submit(changed)

    def test_single_account_and_ordinary_task_without_input_hash_are_valid(self):
        body = assignment(accounts=["account-a"])
        self.assertNotIn("inputSha256", validate_assignment(body)["tasks"][0])
        self.registry.submit(body, now=1)
        operation = self.registry.claim_operation("node-1", now=2)
        self.assertEqual(operation["selectedAccountId"], "account-a")
        self.assertEqual(operation["input"]["instructions"], "Do bounded work for task-1")
        self.assertEqual(operation["input"]["sessionId"], "session-account-a")

    def test_fresh_execution_requires_explicit_eligible_account_stack_and_provider(self):
        body = assignment(tasks=[fresh_task()], accounts=["account-a"])
        self.assertEqual(validate_assignment(body)["tasks"][0]["execution"]["mode"], "fresh")
        for invalid in (
            {"mode": "fresh", "workspaceId": "workspace-a", "stackId": "stack-a", "provider": "claude"},
            {"mode": "fresh", "accountId": "account-a", "workspaceId": "workspace-a", "provider": "claude"},
            {"mode": "fresh", "accountId": "account-a", "workspaceId": "workspace-a", "stackId": "stack-a"},
            {"mode": "fresh", "accountId": "account-b", "workspaceId": "workspace-a", "stackId": "stack-a", "provider": "claude"},
            {"mode": "fresh", "accountId": "account-a", "workspaceId": "workspace-a", "stackId": "stack-a", "provider": "unknown"},
            {"mode": "fresh", "accountId": "account-a", "workspaceId": "workspace-a", "stackId": "stack-a", "provider": "claude", "sessionId": "session-a"},
        ):
            body = assignment(tasks=[fresh_task()], accounts=["account-a"])
            body["tasks"][0]["execution"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_assignment(body)

    def test_multi_account_fresh_tasks_preserve_each_task_account_and_workspace_binding(self):
        self.register("account-a", sessions=[])
        self.register("account-b", sessions=[])
        tasks = [
            fresh_task("fresh-a", account="account-a", workspace="workspace-a", stack="stack-a"),
            fresh_task("fresh-b", account="account-b", workspace="workspace-b", stack="stack-b"),
        ]
        self.registry.submit(assignment(tasks=tasks, accounts=["account-a", "account-b"], max_workers=2), now=1)
        first = self.registry.claim_operation("worker-a", now=2)
        second = self.registry.claim_operation("worker-b", now=3)
        self.assertEqual((first["selectedAccountId"], first["input"]["workspaceId"], first["input"]["stackId"]),
                         ("account-a", "workspace-a", "stack-a"))
        self.assertEqual((second["selectedAccountId"], second["input"]["workspaceId"], second["input"]["stackId"]),
                         ("account-b", "workspace-b", "stack-b"))
        snapshot = self.registry.get_assignment("job-1")
        self.assertEqual([(row["requestedProvider"], row["workspaceId"], row["modelRequested"]) for row in snapshot["tasks"]],
                         [("claude", "workspace-a", "not_reported"), ("claude", "workspace-b", "not_reported")])

    def test_fresh_lifecycle_pins_account_and_creates_session_only_after_launch(self):
        # A fresh provider task must not depend on a pre-registered session.
        self.register("account-a", sessions=[])
        self.registry.submit(assignment(tasks=[fresh_task()], accounts=["account-a"]), now=1)
        with self.registry.connection() as db:
            self.assertIsNone(db.execute("SELECT session_id FROM job_tasks WHERE assignment='job-1'").fetchone()[0])

        create = self.registry.claim_operation("worker", now=2)
        self.assertEqual((create["kind"], create["selectedAccountId"], create["sessionId"]),
                         ("create_task", "account-a", None))
        self.assertEqual(create["input"]["title"], "ROTOXY — fresh-1")
        self.assertEqual(create["input"]["workspaceId"], "workspace-a")
        self.assertEqual(create["input"]["stackId"], "stack-a")
        self.assertEqual(create["input"]["provider"], "claude")
        self.assertEqual(create["input"]["instructions"], "Do bounded work for fresh-1")
        self.registry.record_result(create["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-1"}}, now=3)

        patch = self.registry.claim_operation("worker", now=4)
        self.assertEqual(patch["kind"], "patch_task")
        self.assertIsNone(patch["sessionId"])
        self.assertEqual(patch["providerTaskId"], "ls-task-1")
        self.assertEqual(patch["input"]["providerTaskId"], "ls-task-1")
        self.assertEqual(patch["input"]["instructions"], "Do bounded work for fresh-1")
        self.registry.record_result(patch["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-1", "status": "instructions_verified"}}, now=5)

        verify = self.registry.claim_operation("worker", now=6)
        self.assertEqual(verify["kind"], "verify_task_packet")
        self.assertIsNone(verify["sessionId"])
        self.assertEqual(verify["input"]["providerTaskId"], "ls-task-1")
        self.registry.record_result(verify["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-1", "status": "instructions_verified"}}, now=7)

        launch = self.registry.claim_operation("worker", now=8)
        self.assertEqual(launch["kind"], "launch_task")
        self.assertIsNone(launch["sessionId"])
        self.assertEqual(launch["input"]["providerTaskId"], "ls-task-1")
        self.registry.record_result(launch["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-1", "sessionId": "fresh-session-1",
                                               "reportedModel": "claude-sonnet-4-6"}}, now=9)
        with self.registry.connection() as db:
            row = db.execute("SELECT session_id,reported_model FROM job_tasks WHERE assignment='job-1'").fetchone()
            self.assertEqual((row["session_id"], row["reported_model"]), ("fresh-session-1", "claude-sonnet-4-6"))

        observe = self.registry.claim_operation("worker", now=11)
        self.assertEqual(observe["kind"], "observe_session")
        self.assertEqual(observe["sessionId"], "fresh-session-1")
        self.assertEqual(observe["input"]["sessionId"], "fresh-session-1")
        self.assertEqual(observe["input"]["expectedMarker"], "DONE")

    def test_cancel_releases_only_durable_fresh_prelaunch_packet_refusal(self):
        self.register("account-a", sessions=[])
        self.registry.submit(assignment(tasks=[fresh_task()], accounts=["account-a"]), now=1)
        create = self.registry.claim_operation("worker", now=2)
        self.registry.record_result(create["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-refused"}}, now=3)
        patch = self.registry.claim_operation("worker", now=4)
        self.registry.record_result(patch["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-refused"}}, now=5)
        verify = self.registry.claim_operation("worker", now=6)
        self.assertEqual(verify["kind"], "verify_task_packet")
        self.registry.record_result(verify["operationId"], {"workerId": "worker", "outcome": "rejected",
                                    "errorClass": "instruction_roundtrip_unverified"}, now=7)
        self.assertEqual(self.registry.get_assignment("job-1")["tasks"][0]["state"], "blocked")

        self.registry.submit(assignment("job-2", "key-2", [fresh_task("fresh-2")], accounts=["account-a"]), now=8)
        self.assertIsNone(self.registry.claim_operation("worker", now=9), "the retained refusal still owns the account until explicitly cancelled")
        held = self.registry.get_assignment("job-1")
        self.registry.cancel_assignment("job-1", expected_revision=held["revision"], now=10)
        with self.registry.connection() as db:
            released = db.execute("SELECT state,released_at,attempt_id FROM job_tasks WHERE assignment='job-1'").fetchone()
            attempt = db.execute("SELECT state,released_at FROM attempts WHERE id=?", (released["attempt_id"],)).fetchone()
            launch_count = db.execute("SELECT COUNT(*) FROM operations WHERE assignment='job-1' AND kind='launch_task'").fetchone()[0]
        self.assertEqual((released["state"], released["released_at"]), ("cancelled", 10))
        self.assertEqual((attempt["state"], attempt["released_at"]), ("cancelled", 10))
        self.assertEqual(launch_count, 0)
        next_operation = self.registry.claim_operation("worker", now=11)
        self.assertEqual((next_operation["kind"], next_operation["selectedAccountId"]), ("create_task", "account-a"))

    def test_cancel_does_not_release_ambiguous_fresh_verification(self):
        self.register("account-a", sessions=[])
        self.registry.submit(assignment(tasks=[fresh_task()], accounts=["account-a"]), now=1)
        create = self.registry.claim_operation("worker", now=2)
        self.registry.record_result(create["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-ambiguous"}}, now=3)
        patch = self.registry.claim_operation("worker", now=4)
        self.registry.record_result(patch["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-ambiguous"}}, now=5)
        verify = self.registry.claim_operation("worker", now=6)
        self.registry.record_result(verify["operationId"], {"workerId": "worker", "outcome": "ambiguous",
                                    "errorClass": "worker_result_unavailable"}, now=7)
        held = self.registry.get_assignment("job-1")
        self.registry.cancel_assignment("job-1", expected_revision=held["revision"], now=8)
        with self.registry.connection() as db:
            row = db.execute("SELECT state,released_at FROM job_tasks WHERE assignment='job-1'").fetchone()
        self.assertEqual((row["state"], row["released_at"]), ("ambiguous", None))

    def test_cancel_after_fresh_launch_claim_retains_slot_and_marks_launch_ambiguous(self):
        self.register("account-b", sessions=[])
        self.registry.submit(assignment("job-b", "key-b", [fresh_task("fresh-b", account="account-b")], accounts=["account-b"]), now=1)
        create = self.registry.claim_operation("worker", now=2)
        self.registry.record_result(create["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-dispatched"}}, now=3)
        patch = self.registry.claim_operation("worker", now=4)
        self.registry.record_result(patch["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-dispatched"}}, now=5)
        verify = self.registry.claim_operation("worker", now=6)
        self.registry.record_result(verify["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-dispatched"}}, now=7)
        launch = self.registry.claim_operation("worker", now=8)
        self.assertEqual(launch["kind"], "launch_task")
        held = self.registry.get_assignment("job-b")
        self.registry.cancel_assignment("job-b", expected_revision=held["revision"], now=9)
        with self.registry.connection() as db:
            row = db.execute("SELECT state,released_at FROM job_tasks WHERE assignment='job-b'").fetchone()
            op_state = db.execute("SELECT state,error_class FROM operations WHERE id=?", (launch["operationId"],)).fetchone()
        self.assertEqual((row["state"], row["released_at"]), ("cancel_pending", None))
        self.assertEqual((op_state["state"], op_state["error_class"]), ("ambiguous", "CancelledAfterDispatch"))

    def test_expired_fresh_launch_lease_is_ambiguous_and_never_claimed_again(self):
        self.register("account-a", sessions=[])
        self.registry.submit(assignment(tasks=[fresh_task()], accounts=["account-a"]), now=1)
        create = self.registry.claim_operation("worker-a", now=2)
        self.registry.record_result(create["operationId"], {"workerId": "worker-a", "outcome": "accepted",
                                   "result": {"providerTaskId": "ls-task-1"}}, now=3)
        patch = self.registry.claim_operation("worker-a", now=4)
        self.registry.record_result(patch["operationId"], {"workerId": "worker-a", "outcome": "accepted",
                                   "result": {"providerTaskId": "ls-task-1"}}, now=5)
        verify = self.registry.claim_operation("worker-a", now=6)
        self.registry.record_result(verify["operationId"], {"workerId": "worker-a", "outcome": "accepted",
                                   "result": {"providerTaskId": "ls-task-1"}}, now=7)
        launch = self.registry.claim_operation("worker-a", lease_seconds=5, now=8)
        self.assertEqual((launch["kind"], launch["input"]["providerTaskId"]), ("launch_task", "ls-task-1"))
        self.assertIsNone(self.registry.claim_operation("worker-b", now=9), "a live launch lease cannot be claimed twice")
        self.assertIsNone(self.registry.claim_operation("worker-restart", now=14), "an expired launch remains ambiguous, never reissued")
        with self.registry.connection() as db:
            launch_rows = db.execute("SELECT state FROM operations WHERE assignment='job-1' AND kind='launch_task'").fetchall()
        self.assertEqual([row["state"] for row in launch_rows], ["ambiguous"])
        self.assertEqual(self.registry.get_assignment("job-1")["tasks"][0]["state"], "ambiguous")

    def test_fresh_launch_result_without_session_does_not_advance(self):
        self.registry.submit(assignment(tasks=[fresh_task()], accounts=["account-a"]), now=1)
        create = self.registry.claim_operation("worker", now=2)
        self.registry.record_result(create["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-2"}}, now=3)
        patch = self.registry.claim_operation("worker", now=4)
        self.registry.record_result(patch["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-2"}}, now=5)
        verify = self.registry.claim_operation("worker", now=6)
        self.registry.record_result(verify["operationId"], {"workerId": "worker", "outcome": "accepted",
                                    "result": {"providerTaskId": "ls-task-2"}}, now=7)
        launch = self.registry.claim_operation("worker", now=8)
        with self.assertRaisesRegex(ValueError, "sessionId"):
            self.registry.record_result(launch["operationId"], {"workerId": "worker", "outcome": "accepted",
                                                "result": {"providerTaskId": "ls-task-2"}}, now=9)
        with self.registry.connection() as db:
            self.assertIsNone(db.execute("SELECT session_id FROM job_tasks WHERE assignment='job-1'").fetchone()[0])

    def test_blocked_preflight_exposes_safe_failure_class_without_prompt_data(self):
        self.registry.submit(assignment(), now=1)
        operation = self.registry.claim_operation("node-1", now=2)
        self.registry.record_result(operation["operationId"], {
            "workerId": "node-1", "outcome": "rejected", "errorClass": "session_not_sendable",
        }, now=3)
        task_view = self.registry.get_assignment("job-1")["tasks"][0]
        self.assertEqual(task_view["state"], "blocked")
        self.assertEqual(task_view["errorClass"], "session_not_sendable")
        self.assertNotIn("instructions", task_view)

    def test_dag_is_bounded_and_cycles_are_rejected(self):
        tasks = [task("task-1", depends=["task-2"]), task("task-2", depends=["task-1"])]
        with self.assertRaisesRegex(ValueError, "cycle"):
            validate_assignment(assignment(tasks=tasks))
        too_many = [task(f"task-{i}") for i in range(101)]
        with self.assertRaisesRegex(ValueError, "1 to 100"):
            validate_assignment(assignment(tasks=too_many))

    def test_assistant_requires_fresh_timestamp_marker_and_bounded_text(self):
        self.registry.submit(assignment(), now=1)
        chat = self.registry.claim_operation("node-1", now=2)
        self.assertEqual(chat["kind"], "chat_session")
        self.assertIn("dispatchAt", chat["input"])
        self.registry.record_result(chat["operationId"], {"workerId": "node-1", "outcome": "accepted"}, now=3)
        observe = self.registry.claim_operation("node-1", now=5)
        stale = {"workerId": "node-1", "outcome": "accepted", "result": {"status": "complete", "assistantText": "DONE old", "assistantAt": 1, "sessionId": "session-account-a"}}
        self.registry.record_result(observe["operationId"], stale, now=6)
        self.assertEqual(self.registry.get_assignment("job-1")["tasks"][0]["state"], "awaiting_output")
        observe = self.registry.claim_operation("node-1", now=8)
        fresh = {"workerId": "node-1", "outcome": "accepted", "result": {"status": "complete", "assistantText": "DONE verified", "assistantAt": 7, "reportedModel": "model-a", "sessionId": "session-account-a"}}
        self.registry.record_result(observe["operationId"], fresh, now=9)
        self.assertEqual(self.registry.get_assignment("job-1")["tasks"][0]["state"], "complete")
        output = self.registry.assignment_results("job-1")["results"][0]
        self.assertEqual(output["text"], "DONE verified")

    def test_validated_dependency_unlocks_child(self):
        body = assignment(tasks=[task("first"), task("second", depends=["first"])])
        self.registry.submit(body, now=1)
        self.complete_one(now=2)
        nxt = self.registry.claim_operation("node-1", now=7)
        self.assertEqual(nxt["kind"], "chat_session")
        self.assertEqual(nxt["input"]["sessionId"], "session-account-a")

    def test_final_dependent_task_completes_parent_once_and_survives_restart(self):
        body = assignment(tasks=[task("first"), task("second", depends=["first"])])
        self.registry.submit(body, now=1)
        final_result = None
        for base in (2, 7):
            chat = self.registry.claim_operation("worker", now=base)
            self.assertEqual(chat["kind"], "chat_session")
            self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=base + 1)
            observe = self.registry.claim_operation("worker", now=base + 3)
            self.assertEqual(observe["kind"], "observe_session")
            final_result = {"workerId": "worker", "outcome": "accepted", "result": {
                "status": "complete", "assistantText": "DONE", "assistantAt": base + 2,
                "sessionId": "session-account-a"}}
            self.registry.record_result(observe["operationId"], final_result, now=base + 4)
        snapshot = self.registry.get_assignment("job-1")
        self.assertEqual((snapshot["state"], snapshot["revision"]), ("complete", 2))
        self.assertTrue(all(task_row["dispatchAt"] is not None and task_row["releasedAt"] is not None for task_row in snapshot["tasks"]))
        self.assertTrue(all(task_row["providerStatus"] == "complete" for task_row in snapshot["tasks"]))
        reopened = JobRegistry(self.db)
        self.assertEqual((reopened.get_assignment("job-1")["state"], reopened.get_assignment("job-1")["revision"]), ("complete", 2))
        self.assertIn("assignment_complete", [event["kind"] for event in self.registry.events()["events"]])
        # A duplicate receipt is idempotent and cannot bump the parent revision.
        with self.registry.connection() as db:
            last_operation = db.execute("SELECT id FROM operations WHERE kind='observe_session' AND state='accepted' ORDER BY created_at DESC LIMIT 1").fetchone()["id"]
        self.registry.record_result(last_operation, final_result, now=20)
        self.assertEqual(self.registry.get_assignment("job-1")["revision"], 2)

    def test_usage_delta_uses_durable_attempt_scoped_baseline_and_latest_receipt(self):
        self.registry.submit(assignment(), now=1)
        chat = self.registry.claim_operation("worker", now=2)
        # A prior generation's usage receipt must never be folded into this attempt.
        with self.registry.connection(write=True) as db:
            db.execute("INSERT INTO operations(id,assignment,task_id,attempt_id,generation,account,kind,input,state,result,created_at,due_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                       ("old-generation", "job-1", "task-1", "old-attempt", 0, "account-a", "chat_session",
                        json.dumps({"sessionId": "session-account-a"}), "accepted",
                        json.dumps({"outcome": "accepted", "result": {"reportedModel": "model-a", "usage": usage(9, 900)}}), 1, 1))
        baseline = {"workerId": "worker", "outcome": "accepted", "result": {"reportedModel": "model-a", "usage": usage(.1, 10, .1)}}
        self.registry.record_result(chat["operationId"], baseline, now=3)
        observation = self.registry.claim_operation("worker", now=5)
        pending = {"workerId": "worker", "outcome": "accepted", "result": {"status": "running", "sessionId": "session-account-a",
                   "reportedModel": "model-a", "usage": usage(.14, 14, .14)}}
        self.registry.record_result(observation["operationId"], pending, now=6)
        latest = self.registry.claim_operation("worker", now=8)
        final = {"workerId": "worker", "outcome": "accepted", "result": {"status": "complete", "assistantText": "DONE usage",
                 "assistantAt": 7, "sessionId": "session-account-a", "reportedModel": "model-a", "usage": usage(.18, 20, .18)}}
        self.registry.record_result(latest["operationId"], final, now=9)
        snapshot = self.registry.get_assignment("job-1")["tasks"][0]
        self.assertEqual(snapshot["usage"]["reportedSessionCostUsd"], .18)
        self.assertEqual(snapshot["usage"]["reportedCostDeltaUsd"], .08)
        self.assertEqual(snapshot["usage"]["promptCountDelta"], 10)
        self.assertEqual(snapshot["usage"]["reportedModel"], "model-a")
        self.assertEqual(snapshot["usage"]["observedAt"], 9)
        self.assertEqual(snapshot["usage"]["source"], "lightsprint-session-status")
        self.assertTrue(snapshot["usage"]["provisional"])
        self.assertEqual(snapshot["usage"]["budgetUnit"], "unknown")
        with self.registry.connection() as db:
            stored = json.loads(db.execute("SELECT result FROM operations WHERE id=?", (latest["operationId"],)).fetchone()["result"])
            self.assertEqual(stored["observedAt"], 9)
        reopened = JobRegistry(self.db)
        self.assertEqual(reopened.get_assignment("job-1")["tasks"][0]["usage"], snapshot["usage"])
        self.assertTrue(reopened.record_result(latest["operationId"], final, now=99)["replayed"])
        self.assertEqual(reopened.get_assignment("job-1")["tasks"][0]["usage"]["observedAt"], 9)

    def test_usage_contract_rejects_arbitrary_nonfinite_and_invalid_counters(self):
        self.registry.submit(assignment(), now=1)
        chat = self.registry.claim_operation("worker", now=2)
        valid = usage(0, 0, 0, 1)
        invalid = [
            {**valid, "extra": "not allowed"},
            {key: value for key, value in valid.items() if key != "sandboxTier"},
            {**valid, "reportedSessionCostUsd": -1},
            {**valid, "reportedSessionCostUsd": float("nan")},
            {**valid, "promptCount": True},
            {**valid, "promptCount": -1},
            {**valid, "maxBudget": 0},
            {**valid, "fundingSource": "x" * 65},
        ]
        for item in invalid:
            with self.subTest(item=item):
                with self.assertRaises(ValueError):
                    self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted", "result": {"usage": item}}, now=3)
        self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted", "result": {"usage": None}}, now=3)
        observation = self.registry.claim_operation("worker", now=5)
        self.registry.record_result(observation["operationId"], {"workerId": "worker", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": "DONE", "assistantAt": 4, "sessionId": "session-account-a"}}, now=6)
        self.assertNotIn("usage", self.registry.get_assignment("job-1")["tasks"][0])

    def test_usage_rollbacks_and_model_or_session_mismatches_suppress_deltas(self):
        def complete_with_usage(identifier, observed_usage, model, session="session-account-a"):
            self.registry.submit(assignment(identifier, identifier + "-key", [task(identifier)]), now=1)
            chat = self.registry.claim_operation("worker", now=2)
            self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted", "result": {
                "reportedModel": "model-a", "usage": usage(.5, 20, .5)}}, now=3)
            observe = self.registry.claim_operation("worker", now=5)
            self.registry.record_result(observe["operationId"], {"workerId": "worker", "outcome": "accepted", "result": {
                "status": "complete", "assistantText": "DONE", "assistantAt": 4, "sessionId": session,
                "reportedModel": model, "usage": observed_usage}}, now=6)
            return self.registry.get_assignment(identifier)["tasks"][0]

        rolled_back = complete_with_usage("rollback", usage(.4, 25, .4), "model-a")
        self.assertEqual(rolled_back["usage"]["reportedSessionCostUsd"], .4)
        self.assertNotIn("reportedCostDeltaUsd", rolled_back["usage"])
        self.assertEqual(rolled_back["usage"]["promptCountDelta"], 5)
        changed_model = complete_with_usage("model-change", usage(.7, 30, .7), "model-b")
        self.assertNotIn("reportedCostDeltaUsd", changed_model["usage"])
        self.assertNotIn("promptCountDelta", changed_model["usage"])
        wrong_session = complete_with_usage("session-change", usage(.8, 40, .8), "model-a", "other-session")
        self.assertNotIn("usage", wrong_session)

    def test_scope_conflict_across_jobs_blocks_second_until_release(self):
        self.registry.submit(assignment(), now=1)
        first = self.registry.claim_operation("node-1", now=2)
        self.registry.submit(assignment("job-2", "key-2", [task("other", scope="path:src/task-1.txt/child")]), now=3)
        self.registry.record_result(first["operationId"], {"workerId": "node-1", "outcome": "accepted"}, now=4)
        observe = self.registry.claim_operation("node-1", now=5)
        self.registry.record_result(observe["operationId"], {"workerId": "node-1", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": "DONE", "assistantAt": 4, "sessionId": "session-account-a"}}, now=6)
        self.assertEqual(self.registry.claim_operation("node-1", now=7)["kind"], "chat_session")

    def test_existing_snooze_attempt_reserves_overlapping_scope(self):
        self.register("account-b")
        with self.registry.connection(write=True) as db:
            db.execute("INSERT INTO attempts(id,task,project,account,generation,idempotency_key,state,scopes,started_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)",
                       ("snooze-attempt", "existing-task", "project-a", "other-account", 1, "existing-key", "running",
                        '["path:src/task-1.txt/subtree"]', 1, "{}"))
        self.registry.submit(assignment(accounts=["account-b"], tasks=[task("new", account="account-b", scope="path:src/task-1.txt")]), now=2)
        self.assertIsNone(self.registry.claim_operation("node-1", now=3))

    def test_account_is_revalidated_immediately_before_claim(self):
        self.registry.submit(assignment(), now=1)
        with self.registry.connection(write=True) as db:
            self.registry._queue_one_ready(db, 1.5)
        self.register("account-a", enabled=False)
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            self.registry.claim_operation("node-1", now=2)

    def test_unknown_quota_requires_explicit_acknowledgement(self):
        self.register("account-b", quota="unknown")
        with self.assertRaisesRegex(RuntimeError, "quota"):
            self.registry.submit(assignment(accounts=["account-b"], tasks=[task(account="account-b")]), now=1)
        self.registry.register_account({"accountId": "account-b", "enabled": True, "authorized": True,
            "health": "healthy", "quota": "unknown", "allowUnknownQuota": True,
            "registeredSessions": [{"id": "session-account-b", "model": "unknown", "workspace": "workspace-a"}]})
        self.registry.submit(assignment("job-b", "key-b", [task(account="account-b")], accounts=["account-b"]), now=2)

    def test_thirty_five_tasks_share_nine_accounts_with_three_worker_ceiling(self):
        accounts = [f"acct-{i}" for i in range(9)]
        for account in accounts:
            self.register(account)
        tasks = [task(f"task-{i}", account=accounts[i % len(accounts)]) for i in range(35)]
        self.registry.submit(assignment("many", "many-key", tasks, accounts=accounts, max_workers=3), now=1)
        now, active, peak, completed = 2, 0, 0, 0
        seen_accounts = set()
        while completed < len(tasks) and now < 1000:
            op = self.registry.claim_operation("worker", now=now)
            now += 1
            if op is None:
                continue
            seen_accounts.add(op["selectedAccountId"])
            if op["kind"] == "chat_session":
                active += 1
                peak = max(peak, active)
                self.registry.record_result(op["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=now)
            else:
                self.registry.record_result(op["operationId"], {"workerId": "worker", "outcome": "accepted", "result": {
                    "status": "complete", "assistantText": "DONE", "assistantAt": now - 2, "sessionId": op["sessionId"]}}, now=now)
                active -= 1
                completed += 1
        self.assertEqual(completed, 35)
        self.assertEqual(seen_accounts, set(accounts))
        self.assertLessEqual(peak, 3)

    def test_expired_chat_is_ambiguous_and_never_duplicated(self):
        self.registry.submit(assignment(), now=1)
        op = self.registry.claim_operation("node-1", lease_seconds=5, now=2)
        self.assertIsNone(self.registry.claim_operation("node-2", now=8))
        with self.registry.connection() as db:
            self.assertEqual(db.execute("SELECT state FROM operations WHERE id=?", (op["operationId"],)).fetchone()[0], "ambiguous")
        self.assertEqual(self.registry.get_assignment("job-1")["tasks"][0]["state"], "ambiguous")

    def test_one_session_is_exclusive_across_accounts_projects_and_restart(self):
        shared = [{"id": "shared-session", "model": "model-a", "workspace": "workspace-a"}]
        self.register("account-a", sessions=shared, capacity=4)
        self.register("account-b", sessions=shared, capacity=4)
        self.registry.submit(assignment("job-a", "key-a", [task("a", account="account-a", session_id="shared-session")], project="project-a"), now=1)
        self.registry.submit(assignment("job-b", "key-b", [task("b", account="account-b", session_id="shared-session")], accounts=["account-b"], project="project-b"), now=1)
        self.registry.submit(assignment("job-c", "key-c", [task("c", account="account-a", session_id="shared-session")], project="project-c"), now=1)
        # Both claims race through separate SQLite connections; only one may reserve the session.
        barrier = threading.Barrier(4)
        outcomes = []
        def claim(worker):
            barrier.wait()
            outcomes.append((worker, self.registry.claim_operation(worker, lease_seconds=1, now=2)))
        workers = [threading.Thread(target=claim, args=(f"worker-{n}",)) for n in range(3)]
        for worker in workers: worker.start()
        barrier.wait()
        for worker in workers: worker.join(timeout=3)
        self.assertTrue(all(not worker.is_alive() for worker in workers))
        claimed = [(worker, item) for worker, item in outcomes if item]
        self.assertEqual(len(claimed), 1)
        # Expiration makes the remote result ambiguous; restart must retain the session lock.
        self.assertIsNone(self.registry.claim_operation("worker-restart", lease_seconds=1, now=5))
        restarted = JobRegistry(self.db)
        self.assertIsNone(restarted.claim_operation("worker-restart", now=6))
        with restarted.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM job_tasks WHERE session_id='shared-session' AND state='ambiguous'").fetchone()[0], 1)

    def test_completed_reservation_releases_session_and_busy_registration_is_immutable(self):
        shared = [{"id": "shared-session", "model": "model-a", "workspace": "workspace-a"}]
        self.register("account-a", sessions=shared, capacity=3)
        self.register("account-b", sessions=shared, capacity=3)
        self.registry.submit(assignment("job-a", "key-a", [task("a", account="account-a", session_id="shared-session")]), now=1)
        first = self.registry.claim_operation("worker", now=2)
        changed = [{"id": "shared-session", "model": "model-b", "workspace": "workspace-a"}]
        with self.assertRaisesRegex(ValueError, "registered session while it is reserved"):
            self.register("account-a", sessions=changed, capacity=3)
        self.registry.record_result(first["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=3)
        observe = self.registry.claim_operation("worker", now=5)
        self.registry.record_result(observe["operationId"], {"workerId": "worker", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": "DONE", "assistantAt": 4, "sessionId": "shared-session"}}, now=6)
        self.registry.submit(assignment("job-b", "key-b", [task("b", account="account-b", session_id="shared-session")], accounts=["account-b"], project="project-b"), now=7)
        self.assertEqual(self.registry.claim_operation("worker", now=8)["kind"], "chat_session")

    def test_pause_control_blocks_previously_queued_claim(self):
        self.registry.submit(assignment(), now=1)
        self.registry.set_control("pause_dispatch", True, expected_revision=1)
        self.assertIsNone(self.registry.claim_operation("node-1", now=2))
        self.registry.set_control("pause_dispatch", False, expected_revision=2)
        self.assertEqual(self.registry.claim_operation("node-1", now=3)["kind"], "chat_session")

    def test_project_controls_are_isolated_revision_fenced_and_persisted(self):
        self.register("account-b")
        self.registry.submit(assignment("project-a-job", "project-a-key", project="project-a"), now=1)
        self.registry.submit(assignment("project-b-job", "project-b-key", accounts=["account-b"],
                                         tasks=[task("task-b", account="account-b")], project="project-b"), now=2)
        initial = self.registry.get_project_control("project-a")
        self.assertEqual((initial["state"], initial["revision"]), ("running", 1))
        paused = self.registry.set_project_control("project-a", "pause_dispatch", None, 1, now=3)
        self.assertEqual((paused["state"], paused["revision"]), ("paused", 2))
        operation = self.registry.claim_operation("worker", now=4)
        self.assertEqual(operation["selectedAccountId"], "account-b", "project A pause must not pause project B")
        self.assertIsNone(self.registry.claim_operation("worker-2", now=5))

        reopened = JobRegistry(self.db)
        self.assertEqual(reopened.get_project_control("project-a")["state"], "paused")
        with self.assertRaisesRegex(RuntimeError, "Stale project control revision"):
            reopened.set_project_control("project-a", "resume_dispatch", None, 1, now=6)
        resumed = reopened.set_project_control("project-a", "resume_dispatch", None, 2, now=7)
        self.assertEqual((resumed["state"], resumed["revision"]), ("running", 3))
        stopped = reopened.set_project_control("project-a", "emergency_stop", None, 3, now=8)
        self.assertEqual((stopped["state"], stopped["revision"]), ("emergency_stopped", 4))
        self.assertIsNone(reopened.claim_operation("worker-3", now=9))
        self.assertEqual(reopened.set_project_control("project-a", "resume_dispatch", None, 4, now=10)["state"], "running")
        self.assertEqual(reopened.claim_operation("worker-4", now=11)["selectedAccountId"], "account-a")

    def test_project_pause_and_concurrency_updates_do_not_cancel_active_provider_operations(self):
        self.register("account-b")
        tasks = [task("active-a"), task("active-b", account="account-b")]
        self.registry.submit(assignment("active-job", "active-key", tasks, accounts=["account-a", "account-b"],
            max_workers=3, project="active-project") | {"scheduling": {"profile": "throughput"}}, now=1)
        active = self.registry.claim_operation("worker", now=2)
        self.assertEqual(active["kind"], "chat_session")
        configured = self.registry.set_project_control("active-project", "set_concurrency", 1, 1, now=3)
        self.assertEqual(configured["activeTaskCount"], 1)
        self.assertIsNone(self.registry.claim_operation("worker-2", now=3.5), "reduced concurrency holds additional task dispatch")
        paused = self.registry.set_project_control("active-project", "pause_dispatch", None, 2, now=4)
        self.assertEqual(paused["activeTaskCount"], 1)
        with self.registry.connection() as db:
            self.assertEqual(db.execute("SELECT state FROM operations WHERE id=?", (active["operationId"],)).fetchone()[0], "claimed")
        self.assertIsNone(self.registry.claim_operation("worker-2", now=5))
        with self.registry.connection() as db:
            self.assertEqual(db.execute("SELECT state FROM operations WHERE id=?", (active["operationId"],)).fetchone()[0], "claimed")
        reopened = JobRegistry(self.db)
        self.assertEqual(reopened.get_project_control("active-project")["maxConcurrency"], 1)
        self.assertEqual(reopened.get_project_control("active-project")["activeTaskCount"], 1)

    def test_profiles_bound_dispatch_by_local_capacity_and_persist_across_restart(self):
        self.register("account-b")
        self.registry.set_control("set_concurrency", 8, expected_revision=1)
        tasks = [task("economy-a"), task("economy-b", account="account-b")]
        self.registry.submit(assignment("economy", "economy-key", tasks, accounts=["account-a", "account-b"],
                                         max_workers=32, project="economy-project") | {"scheduling": {"profile": "economy"}}, now=1)
        first = self.registry.claim_operation("worker", now=2)
        self.assertEqual(first["kind"], "chat_session")
        self.assertIsNone(self.registry.claim_operation("worker-2", now=3))

        # Complete the first chat/output cycle so throughput starts without live work.
        self.registry.record_result(first["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=3)
        observation = self.registry.claim_operation("worker", now=5)
        self.registry.record_result(observation["operationId"], {"workerId": "worker", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": "DONE", "assistantAt": 4, "sessionId": first["sessionId"]}}, now=6)
        second_economy = self.registry.claim_operation("worker", now=7)
        self.assertEqual(second_economy["kind"], "chat_session")
        self.registry.record_result(second_economy["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=8)
        observation = self.registry.claim_operation("worker", now=10)
        self.registry.record_result(observation["operationId"], {"workerId": "worker", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": "DONE", "assistantAt": 9, "sessionId": second_economy["sessionId"]}}, now=11)

        throughput_tasks = [task("throughput-a"), task("throughput-b", account="account-b")]
        self.registry.submit(assignment("throughput", "throughput-key", throughput_tasks,
            accounts=["account-a", "account-b"], max_workers=32, project="throughput-project") |
            {"scheduling": {"profile": "throughput"}}, now=12)
        first = self.registry.claim_operation("worker-1", now=13)
        second = self.registry.claim_operation("worker-2", now=14)
        self.assertEqual({first["selectedAccountId"], second["selectedAccountId"]}, {"account-a", "account-b"})
        self.assertIsNone(self.registry.claim_operation("worker-3", now=15))

        restarted = JobRegistry(self.db)
        self.assertEqual(restarted.get_assignment("throughput")["scheduling"], {"profile": "throughput"})
        with restarted.connection() as db:
            self.assertEqual(db.execute("SELECT max_workers FROM bridge_control WHERE id=1").fetchone()[0], 8)

    def test_ready_task_priority_respects_dependencies(self):
        self.register("account-b")
        tasks = [task("low", priority=0), task("high", account="account-b", priority=10),
                 task("dependent", depends=["low"], priority=100)]
        self.registry.submit(assignment("priority", "priority-key", tasks, accounts=["account-a", "account-b"],
            max_workers=3) | {"scheduling": {"profile": "throughput"}}, now=1)
        first = self.registry.claim_operation("worker-1", now=2)
        self.assertEqual(first["sessionId"], "session-account-b")
        second = self.registry.claim_operation("worker-2", now=3)
        self.assertEqual(second["sessionId"], "session-account-a")
        self.assertEqual(self.registry.get_assignment("priority")["scheduling"]["profile"], "throughput")
        self.assertEqual({item["taskId"]: item["priority"] for item in self.registry.get_assignment("priority")["tasks"]},
                         {"low": 0, "high": 10, "dependent": 100})

    def test_legacy_null_priority_does_not_block_the_scheduler(self):
        self.registry.submit(assignment())
        # Simulate a record written by a prior release, before null priority
        # was rejected by validation. Runtime scheduling must preserve its
        # default ordering and remain able to claim it.
        with self.registry.connection(write=True) as db:
            stored = json.loads(db.execute("SELECT body FROM job_tasks WHERE assignment=? AND task_id=?", ("job-1", "task-1")).fetchone()["body"])
            stored["priority"] = None
            db.execute("UPDATE job_tasks SET body=? WHERE assignment=? AND task_id=?", (json.dumps(stored), "job-1", "task-1"))
        operation = self.registry.claim_operation("node-1", now=1)
        self.assertEqual(operation["sessionId"], "session-account-a")

    def test_scheduler_policy_and_priority_reject_unknown_or_unsafe_fields(self):
        body = assignment() | {"scheduling": {"profile": "custom", "maxConcurrency": 2}}
        self.assertEqual(validate_assignment(body)["scheduling"]["maxConcurrency"], 2)
        for bad in ({"profile": "fastest"}, {"profile": "custom"},
                    {"profile": "economy", "maxConcurrency": 2},
                    {"profile": "custom", "maxConcurrency": 33, "unbounded": True}):
            with self.assertRaises(ValueError):
                validate_assignment(assignment() | {"scheduling": bad})
        for priority in (True, 101, -101, 1.5):
            with self.assertRaises(ValueError):
                validate_assignment(assignment(tasks=[task(priority=priority)]))
        with self.assertRaises(ValueError):
            self.registry.set_control("set_concurrency", 33, expected_revision=1)

    def test_throughput_profile_still_obeys_strict_credit_reservation(self):
        class DenyAdmission:
            def reserve(self, **_kwargs):
                raise CreditDenied("insufficient verified credit")

            def release_known_refusal(self, *_args, **_kwargs):
                raise AssertionError("credit-denied work was not dispatched")

        self.registry.credit_admission = DenyAdmission()
        body = assignment() | {"scheduling": {"profile": "throughput"}}
        self.registry.submit(body, now=1)
        self.assertIsNone(self.registry.claim_operation("worker", now=2))
        self.assertEqual(self.registry.get_assignment("job-1")["state"], "held")
        with self.registry.connection() as db:
            self.assertEqual(db.execute("SELECT state FROM job_tasks WHERE assignment='job-1'").fetchone()[0], "blocked")
            self.assertEqual(db.execute("SELECT state FROM operations WHERE assignment='job-1'").fetchone()[0], "rejected")

    def test_cancel_fences_generation_and_retains_remote_ownership(self):
        self.register("account-b", sessions=[{"id": "session-account-a", "model": "unknown", "workspace": "workspace-a"}], capacity=4)
        self.registry.submit(assignment(), now=1)
        op = self.registry.claim_operation("node-1", now=2)
        self.registry.cancel_assignment("job-1", expected_revision=1, now=3)
        with self.assertRaises(RuntimeError):
            self.registry.record_result(op["operationId"], {"workerId": "node-1", "outcome": "rejected", "errorClass": "session_not_sendable"}, now=4)
        with self.registry.connection() as db:
            row = db.execute("SELECT state,generation,released_at FROM job_tasks WHERE assignment='job-1'").fetchone()
            operation_state = db.execute("SELECT state FROM operations WHERE id=?", (op["operationId"],)).fetchone()[0]
            attempt = db.execute("SELECT released_at FROM attempts WHERE id=?", (op["attemptId"],)).fetchone()
        self.assertEqual((row["state"], row["generation"], row["released_at"]), ("cancel_pending", 2, None))
        self.assertEqual(operation_state, "ambiguous")
        self.assertIsNone(attempt["released_at"])
        self.registry.submit(assignment("job-b", "key-b", [task("next", account="account-b", session_id="session-account-a")], accounts=["account-b"], project="project-b"), now=4)
        self.assertIsNone(self.registry.claim_operation("node-2", now=5))

    def test_stale_generation_preflight_rejection_cannot_release_attempt(self):
        self.registry.submit(assignment(), now=1)
        op = self.registry.claim_operation("worker", now=2)
        with self.registry.connection(write=True) as db:
            db.execute("UPDATE job_tasks SET generation=generation+1 WHERE assignment='job-1' AND task_id='task-1'")
        with self.assertRaisesRegex(RuntimeError, "Stale operation generation"):
            self.registry.record_result(op["operationId"], {
                "workerId": "worker", "outcome": "rejected", "errorClass": "session_not_sendable",
            }, now=3)
        with self.registry.connection() as db:
            attempt = db.execute("SELECT released_at FROM attempts WHERE id=?", (op["attemptId"],)).fetchone()
            operation = db.execute("SELECT state FROM operations WHERE id=?", (op["operationId"],)).fetchone()
        self.assertIsNone(attempt["released_at"])
        self.assertEqual(operation["state"], "claimed")

    def test_only_explicit_chat_preflight_rejections_release_reservation(self):
        safe_classes = (
            "account_identity_mismatch", "invalid_operation_input",
            "worker_stopping_or_lease_insufficient", "session_not_sendable", "account_unavailable_or_stopping",
        )
        now = 1
        for index, error_class in enumerate(safe_classes):
            job_id = f"preflight-{index}"
            self.registry.submit(assignment(job_id, f"key-{index}", [task(f"task-{index}")]), now=now)
            op = self.registry.claim_operation("worker", now=now + 1)
            with self.registry.connection() as db:
                operation_assignment = db.execute("SELECT assignment FROM operations WHERE id=?", (op["operationId"],)).fetchone()[0]
            self.assertEqual((operation_assignment, op["kind"]), (job_id, "chat_session"))
            self.registry.record_result(op["operationId"], {
                "workerId": "worker", "outcome": "rejected", "errorClass": error_class,
            }, now=now + 2)
            with self.registry.connection() as db:
                task_row = db.execute("SELECT state,released_at FROM job_tasks WHERE assignment=?", (job_id,)).fetchone()
                attempt = db.execute("SELECT released_at FROM attempts WHERE id=?", (op["attemptId"],)).fetchone()
            self.assertEqual(task_row["state"], "blocked")
            self.assertEqual(task_row["released_at"], now + 2)
            self.assertEqual(attempt["released_at"], now + 2)
            now += 10

        self.registry.submit(assignment("next-job", "next-key", [task("next-task")]), now=now)
        next_op = self.registry.claim_operation("worker", now=now + 1)
        with self.registry.connection() as db:
            operation_assignment = db.execute("SELECT assignment FROM operations WHERE id=?", (next_op["operationId"],)).fetchone()[0]
        self.assertEqual((operation_assignment, next_op["sessionId"]), ("next-job", "session-account-a"))

    def test_rejected_observation_after_chat_keeps_reservation(self):
        self.registry.submit(assignment(), now=1)
        chat = self.registry.claim_operation("worker", now=2)
        self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=3)
        observe = self.registry.claim_operation("worker", now=5)
        self.registry.record_result(observe["operationId"], {
            "workerId": "worker", "outcome": "rejected", "errorClass": "status_unavailable",
        }, now=6)
        with self.registry.connection() as db:
            task_row = db.execute("SELECT released_at FROM job_tasks WHERE assignment='job-1'").fetchone()
            attempt = db.execute("SELECT released_at FROM attempts WHERE id=?", (chat["attemptId"],)).fetchone()
        self.assertIsNone(task_row["released_at"])
        self.assertIsNone(attempt["released_at"])
        self.registry.submit(assignment("next-job", "next-key", [task("next-task")]), now=7)
        self.assertIsNone(self.registry.claim_operation("worker-2", now=8))

    def test_ambiguous_chat_result_keeps_reservation(self):
        self.registry.submit(assignment(), now=1)
        chat = self.registry.claim_operation("worker", now=2)
        self.registry.record_result(chat["operationId"], {
            "workerId": "worker", "outcome": "ambiguous", "errorClass": "chat_ambiguous",
        }, now=3)
        with self.registry.connection() as db:
            task_row = db.execute("SELECT released_at FROM job_tasks WHERE assignment='job-1'").fetchone()
            attempt = db.execute("SELECT released_at FROM attempts WHERE id=?", (chat["attemptId"],)).fetchone()
        self.assertIsNone(task_row["released_at"])
        self.assertIsNone(attempt["released_at"])
        self.registry.submit(assignment("next-job", "next-key", [task("next-task")]), now=4)
        self.assertIsNone(self.registry.claim_operation("worker-2", now=5))

    def test_account_unavailable_chat_rejection_is_not_safe_to_release(self):
        # This class is also a valid adapter rejection after sendMessage was attempted.
        self.registry.submit(assignment(), now=1)
        chat = self.registry.claim_operation("worker", now=2)
        self.registry.record_result(chat["operationId"], {
            "workerId": "worker", "outcome": "rejected", "errorClass": "account_unavailable",
        }, now=3)
        with self.registry.connection() as db:
            task_row = db.execute("SELECT released_at FROM job_tasks WHERE assignment='job-1'").fetchone()
            attempt = db.execute("SELECT released_at FROM attempts WHERE id=?", (chat["attemptId"],)).fetchone()
        self.assertIsNone(task_row["released_at"])
        self.assertIsNone(attempt["released_at"])
        self.registry.submit(assignment("next-job", "next-key", [task("next-task")]), now=4)
        self.assertIsNone(self.registry.claim_operation("worker-2", now=5))

    def test_private_results_and_owner_filtering(self):
        body = assignment()
        body["ownerPrincipalId"] = "alice"
        body["clientId"] = "client-a"
        self.registry.submit(body, now=1)
        self.assertIsNone(self.registry.get_assignment("job-1", "bob"))
        self.assertEqual(self.registry.get_assignment("job-1", "alice", "client-a")["assignmentId"], "job-1")
        self.assertIsNone(self.registry.get_assignment("job-1", "alice", "different-client"))
        with self.assertRaises(KeyError):
            self.registry.assignment_results("job-1", "bob")

    def test_shared_project_read_remains_project_bounded(self):
        body = assignment()
        body["ownerPrincipalId"] = "alice"
        body["clientId"] = "client-a"
        self.registry.submit(body, now=1)
        self.assertEqual(self.registry.get_assignment("job-1", "bob", "client-b", "project-a")["assignmentId"], "job-1")
        self.assertIsNone(self.registry.get_assignment("job-1", "bob", "client-b", "project-b"))
        self.assertEqual(self.registry.assignment_results("job-1", "bob", "client-b", "project-a")["assignmentId"], "job-1")
        with self.assertRaises(KeyError):
            self.registry.assignment_results("job-1", "bob", "client-b", "project-b")

    def test_snapshot_and_events_do_not_return_instructions(self):
        body = assignment()
        body["tasks"][0]["instructions"] = "private instruction content"
        self.registry.submit(body, now=9)
        serialized = str(self.registry.get_assignment("job-1")) + str(self.registry.events())
        self.assertNotIn("private instruction", serialized)

    def test_credential_like_instruction_is_rejected_before_persistence(self):
        body = assignment()
        body["tasks"][0]["instructions"] = "Bearer sensitive-value"
        with self.assertRaisesRegex(ValueError, "Credential-like"):
            self.registry.submit(body)

    def test_expired_mutation_lease_does_not_freeze_independent_task(self):
        """An expired lease makes the mutating task ambiguous; independent sibling must still run.

        Verified:
        - Independent task is claimable after lease expires (assignment stays queued).
        - Ambiguous task's session remains locked (ACTIVE_TASK_STATES includes ambiguous).
        - Completing the independent task does not mark the assignment complete while the
          ambiguous task is still unresolved.
        - After registry restart the ambiguous task is still ambiguous — no blind re-dispatch.
        """
        self.register("account-b")
        tasks = [task("task-a", account="account-a"), task("task-b", account="account-b")]
        body = assignment("job-1", "key-1", tasks, accounts=["account-a", "account-b"], max_workers=3)
        self.registry.submit(body, now=1)

        # Claim task-a with a short lease; do not record any result.
        op_a = self.registry.claim_operation("worker-a", lease_seconds=5, now=2)
        self.assertEqual(op_a["kind"], "chat_session")
        self.assertEqual(op_a["input"]["sessionId"], "session-account-a")

        # At now=8 the lease (expires at 7) is stale.  claim_operation processes the
        # expiry, marks task-a ambiguous, and must then queue + return task-b's op.
        op_b = self.registry.claim_operation("worker-b", lease_seconds=30, now=8)
        self.assertIsNotNone(op_b, "independent task-b must be claimable after task-a lease expires")
        self.assertEqual(op_b["kind"], "chat_session")
        self.assertEqual(op_b["input"]["sessionId"], "session-account-b")

        # task-a is ambiguous; assignment must NOT be held while task-b is in flight.
        snap = self.registry.get_assignment("job-1")
        task_states = {t["taskId"]: t["state"] for t in snap["tasks"]}
        self.assertEqual(task_states["task-a"], "ambiguous")
        self.assertIn(task_states["task-b"], ("reserved", "starting", "running", "awaiting_output"))
        self.assertNotEqual(snap["state"], "held", "assignment must remain queued while task-b is in flight")

        # session-account-a must still be locked by the ambiguous task.
        self.registry.submit(assignment("job-x", "key-x", [task("tx", account="account-a")]), now=9)
        self.assertIsNone(
            self.registry.claim_operation("worker-x", now=9),
            "session-account-a must be locked by the ambiguous task",
        )

        # Complete task-b; the ambiguous task keeps the assignment from completing.
        self.registry.record_result(op_b["operationId"], {"workerId": "worker-b", "outcome": "accepted"}, now=9)
        obs_b = self.registry.claim_operation("worker-b", now=11)
        self.assertEqual(obs_b["kind"], "observe_session")
        self.registry.record_result(obs_b["operationId"], {"workerId": "worker-b", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": "DONE", "assistantAt": 10,
            "sessionId": "session-account-b",
        }}, now=12)
        snap2 = self.registry.get_assignment("job-1")
        ambi_state = next(t["state"] for t in snap2["tasks"] if t["taskId"] == "task-a")
        self.assertEqual(ambi_state, "ambiguous")
        self.assertNotEqual(snap2["state"], "complete")

        # No duplicate dispatch of the ambiguous task after restart.
        restarted = JobRegistry(self.db)
        self.assertIsNone(restarted.claim_operation("worker-restart", now=13))
        with restarted.connection() as db:
            row = db.execute("SELECT state FROM job_tasks WHERE assignment='job-1' AND task_id='task-a'").fetchone()
        self.assertEqual(row["state"], "ambiguous")

    def test_ambiguous_result_independent_task_executes_dependent_waits_no_duplicate(self):
        """A worker-reported ambiguous result must not freeze independent siblings.

        Verified:
        - Independent task-b is claimable after task-a is explicitly marked ambiguous.
        - task-c, which depends on task-a, must NOT be dispatched (dep unsatisfied).
        - After task-b completes task-c is still blocked (task-a remains ambiguous).
        - task-a's session lock (ACTIVE_TASK_STATES) is retained throughout.
        - After registry restart task-a is still ambiguous — no blind re-dispatch.
        """
        self.register("account-b")
        tasks = [
            task("task-a", account="account-a"),
            task("task-b", account="account-b"),
            task("task-c", account="account-b", depends=["task-a"]),
        ]
        body = assignment("job-1", "key-1", tasks, accounts=["account-a", "account-b"], max_workers=3)
        self.registry.submit(body, now=1)

        # Dispatch task-a and let the worker report an ambiguous outcome.
        op_a = self.registry.claim_operation("worker-a", now=2)
        self.assertEqual(op_a["kind"], "chat_session")
        self.assertEqual(op_a["input"]["sessionId"], "session-account-a")
        self.registry.record_result(op_a["operationId"], {
            "workerId": "worker-a", "outcome": "ambiguous", "errorClass": "provider_timeout",
        }, now=3)

        # Independent task-b must be claimable; assignment must not be held.
        op_b = self.registry.claim_operation("worker-b", now=4)
        self.assertIsNotNone(op_b, "independent task-b must not be frozen by ambiguous task-a")
        self.assertEqual(op_b["kind"], "chat_session")
        self.assertEqual(op_b["input"]["sessionId"], "session-account-b")

        # task-c depends on task-a (ambiguous ≠ complete) → must not be dispatched.
        self.assertIsNone(
            self.registry.claim_operation("worker-c", now=5),
            "task-c must not run while its dependency task-a is ambiguous",
        )

        # Verify per-task states and session lock on task-a.
        snap = self.registry.get_assignment("job-1")
        task_states = {t["taskId"]: t["state"] for t in snap["tasks"]}
        self.assertEqual(task_states["task-a"], "ambiguous")
        self.assertIn(task_states["task-b"], ("reserved", "starting", "running", "awaiting_output"))
        self.assertEqual(task_states["task-c"], "queued")
        self.assertNotEqual(snap["state"], "held", "assignment must remain queued while task-b is in flight")

        # session-account-a is held by the ambiguous task.
        self.registry.submit(assignment("job-x", "key-x", [task("tx", account="account-a")]), now=5)
        self.assertIsNone(
            self.registry.claim_operation("worker-x", now=5),
            "session-account-a must remain locked by the ambiguous task",
        )

        # Complete task-b; task-c still cannot run because task-a is ambiguous.
        self.registry.record_result(op_b["operationId"], {"workerId": "worker-b", "outcome": "accepted"}, now=5)
        obs_b = self.registry.claim_operation("worker-b", now=7)
        self.assertEqual(obs_b["kind"], "observe_session")
        self.registry.record_result(obs_b["operationId"], {"workerId": "worker-b", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": "DONE", "assistantAt": 6,
            "sessionId": "session-account-b",
        }}, now=8)
        self.assertIsNone(
            self.registry.claim_operation("worker-c", now=9),
            "task-c must still wait while task-a is ambiguous",
        )
        snap2 = self.registry.get_assignment("job-1")
        task_states2 = {t["taskId"]: t["state"] for t in snap2["tasks"]}
        self.assertEqual(task_states2["task-a"], "ambiguous")
        self.assertEqual(task_states2["task-b"], "complete")
        self.assertEqual(task_states2["task-c"], "queued")

        # No duplicate dispatch of the ambiguous task after restart.
        restarted = JobRegistry(self.db)
        self.assertIsNone(restarted.claim_operation("worker-restart", now=10))
        with restarted.connection() as db:
            row = db.execute("SELECT state FROM job_tasks WHERE assignment='job-1' AND task_id='task-a'").fetchone()
        self.assertEqual(row["state"], "ambiguous")


    def test_large_bounded_output_within_contract_succeeds_over_contract_is_rejected(self):
        """assistantText up to 32 KiB passes record_result; text exceeding output.maxBytes blocks."""
        # --- Success path: 2900-byte text within a 5000-byte contract ---
        big_task = task("big-t")
        big_task["output"]["maxBytes"] = 5000
        self.registry.submit(assignment("big-job", "big-key", [big_task]), now=1)
        chat = self.registry.claim_operation("worker", now=2)
        self.assertEqual(chat["kind"], "chat_session")
        self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=3)
        observe = self.registry.claim_operation("worker", now=5)
        self.assertEqual(observe["kind"], "observe_session")
        large_text = "A" * 2900 + " DONE"  # 2905 bytes — above old 2048 scalar cap, within 5000-byte contract
        self.registry.record_result(observe["operationId"], {"workerId": "worker", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": large_text, "assistantAt": 4,
            "sessionId": "session-account-a"}}, now=6)
        self.assertEqual(self.registry.get_assignment("big-job")["tasks"][0]["state"], "complete")
        results = self.registry.assignment_results("big-job")["results"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["text"], large_text)

        # --- Rejection path: 1504-byte text exceeds 1024-byte contract ---
        small_task = task("small-t")
        small_task["output"]["maxBytes"] = 1024
        self.registry.submit(assignment("small-job", "small-key", [small_task]), now=7)
        chat2 = self.registry.claim_operation("worker", now=8)
        self.assertEqual(chat2["kind"], "chat_session")
        self.registry.record_result(chat2["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=9)
        observe2 = self.registry.claim_operation("worker", now=11)
        self.assertEqual(observe2["kind"], "observe_session")
        over_text = "B" * 1500 + " DONE"  # 1504 bytes — within record_result 32 KiB limit, over 1024-byte contract
        self.registry.record_result(observe2["operationId"], {"workerId": "worker", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": over_text, "assistantAt": 10,
            "sessionId": "session-account-a"}}, now=12)
        self.assertEqual(self.registry.get_assignment("small-job")["tasks"][0]["state"], "blocked")

    def test_ambiguous_task_dto_includes_reconciliation_hint_across_restart(self):
        """get_assignment must emit a machine-readable reconciliation object for ambiguous tasks."""
        self.registry.submit(assignment(), now=1)
        op = self.registry.claim_operation("worker", lease_seconds=5, now=2)
        self.assertEqual(op["kind"], "chat_session")
        # Lease expires at now=7; process expiry by calling claim at now=8.
        none_op = self.registry.claim_operation("worker-2", now=8)
        self.assertIsNone(none_op)

        snap = self.registry.get_assignment("job-1")
        task_dto = snap["tasks"][0]
        self.assertEqual(task_dto["state"], "ambiguous")

        rec = task_dto.get("reconciliation")
        self.assertIsNotNone(rec, "ambiguous task must carry a reconciliation object")
        self.assertTrue(rec["required"])
        self.assertFalse(rec["redispatchAllowed"])
        self.assertEqual(rec["nextAction"], "inspect_original_execution")
        self.assertIsNotNone(rec.get("operationId"), "operationId must be bound when known")
        self.assertEqual(rec["operationId"], op["operationId"])
        self.assertEqual(rec["attempt"], op["attemptId"])
        self.assertEqual(rec["generation"], op["generation"])
        self.assertEqual(rec["selectedAccountId"], op["selectedAccountId"])
        self.assertEqual(rec["sessionId"], op["sessionId"])

        # Reconciliation must not leak instructions, prompts, or credentials.
        serialized = str(rec)
        self.assertNotIn("instruction", serialized.lower())
        self.assertNotIn("bearer", serialized.lower())

        # Hint must survive a registry restart (reads from durable DB).
        restarted = JobRegistry(self.db)
        snap2 = restarted.get_assignment("job-1")
        rec2 = snap2["tasks"][0].get("reconciliation")
        self.assertIsNotNone(rec2, "reconciliation hint must persist across restart")
        self.assertEqual(rec2["operationId"], op["operationId"])
        self.assertEqual(rec2["attempt"], op["attemptId"])
        self.assertEqual(rec2["generation"], op["generation"])

    def test_two_sessions_same_account_capacity_two_run_concurrently_exclusive_per_session(self):
        """Two distinct registered sessions on one account (capacity 3) dispatch concurrently;
        a second task for an already-occupied session is blocked by the session lock."""
        sessions = [
            {"id": "session-c1", "model": "model-a", "workspace": "workspace-a"},
            {"id": "session-c2", "model": "model-a", "workspace": "workspace-a"},
            {"id": "session-c3", "model": "model-a", "workspace": "workspace-a"},
        ]
        self.register("account-c", sessions=sessions, capacity=3)

        # Two tasks on *different* sessions of the same account.
        self.registry.submit(assignment("cj-1", "ck-1", [task("ct-1", account="account-c", session_id="session-c1")],
                                        accounts=["account-c"]), now=1)
        self.registry.submit(assignment("cj-2", "ck-2", [task("ct-2", account="account-c", session_id="session-c2")],
                                        accounts=["account-c"]), now=2)

        op1 = self.registry.claim_operation("worker-1", now=3)
        self.assertIsNotNone(op1, "first session on account-c must be claimable")
        self.assertEqual(op1["selectedAccountId"], "account-c")
        op2 = self.registry.claim_operation("worker-2", now=4)
        self.assertIsNotNone(op2, "second session on same account must be claimable with capacity 3")
        self.assertEqual(op2["selectedAccountId"], "account-c")
        self.assertNotEqual(op1["sessionId"], op2["sessionId"],
                            "each task must hold its own session")
        self.assertEqual({op1["sessionId"], op2["sessionId"]}, {"session-c1", "session-c2"})

        # Submit a third task targeting session-c1 which is already occupied.
        self.registry.submit(assignment("cj-3", "ck-3", [task("ct-3", account="account-c", session_id="session-c1")],
                                        accounts=["account-c"]), now=5)
        self.assertIsNone(
            self.registry.claim_operation("worker-3", now=6),
            "session-c1 must remain exclusive while op1 is active (capacity would allow it)",
        )


    # ------------------------------------------------------------------ #
    # Explicit reconciliation (reconcile_task)                           #
    # ------------------------------------------------------------------ #

    def _make_ambiguous(self, assignment_id="job-1", lease_seconds=5, now_start=1):
        """Submit, dispatch, expire the lease so the task becomes ambiguous."""
        self.registry.submit(assignment(assignment_id, assignment_id + "-key"), now=now_start)
        chat_op = self.registry.claim_operation("worker", lease_seconds=lease_seconds, now=now_start + 1)
        self.assertEqual(chat_op["kind"], "chat_session")
        # Trigger expiry: now > dispatch_at + lease_seconds
        self.registry.claim_operation("worker2", now=now_start + 1 + lease_seconds + 1)
        return chat_op

    def test_reconcile_denied_for_cancelled_assignment(self):
        """reconcile_task must raise RuntimeError for a cancelled assignment."""
        chat_op = self._make_ambiguous(now_start=1)
        snap = self.registry.get_assignment("job-1")
        self.assertEqual(snap["tasks"][0]["state"], "ambiguous")
        self.registry.cancel_assignment("job-1", expected_revision=snap["revision"], now=20)
        snap2 = self.registry.get_assignment("job-1")
        self.assertEqual(snap2["state"], "cancelled")
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            self.registry.reconcile_task("job-1", "task-1", snap2["revision"])

    def test_reconcile_denied_for_owner_mismatch(self):
        """reconcile_task with wrong owner_principal_id must raise KeyError."""
        body = assignment()
        body["ownerPrincipalId"] = "alice"
        body["clientId"] = "client-a"
        self.registry.submit(body, now=1)
        self.registry.claim_operation("worker", lease_seconds=5, now=2)
        self.registry.claim_operation("worker2", now=9)
        snap = self.registry.get_assignment("job-1", "alice", "client-a")
        with self.assertRaises(KeyError):
            self.registry.reconcile_task(
                "job-1", "task-1", snap["revision"],
                owner_principal_id="bob", client_id="client-a",
            )
        # Correct owner succeeds
        result = self.registry.reconcile_task(
            "job-1", "task-1", snap["revision"],
            owner_principal_id="alice", client_id="client-a", now=15,
        )
        self.assertEqual(result["state"], "awaiting_output")

    def test_reconcile_denied_for_stale_revision(self):
        """reconcile_task with wrong expected_revision must raise RuntimeError."""
        self._make_ambiguous(now_start=1)
        with self.assertRaisesRegex(RuntimeError, "Stale"):
            self.registry.reconcile_task("job-1", "task-1", 9999)

    def test_reconcile_queues_one_observe_after_ambiguity_and_restart(self):
        """After lease expiry and registry restart, one observe is queued with original dispatchAt."""
        chat_op = self._make_ambiguous(now_start=1)
        # Restart
        restarted = JobRegistry(self.db)
        snap = restarted.get_assignment("job-1")
        self.assertEqual(snap["tasks"][0]["state"], "ambiguous")

        result = restarted.reconcile_task("job-1", "task-1", snap["revision"], now=20)
        self.assertEqual(result["state"], "awaiting_output")
        self.assertEqual(result["assignmentState"], "queued")
        self.assertEqual(result["assignmentId"], "job-1")
        self.assertEqual(result["taskId"], "task-1")
        self.assertEqual(result["attempt"], chat_op["attemptId"])
        self.assertEqual(result["sessionId"], chat_op["sessionId"])

        with restarted.connection() as db:
            obs_ops = db.execute(
                "SELECT kind, state, input FROM operations "
                "WHERE assignment='job-1' AND kind='observe_session'"
            ).fetchall()
        self.assertEqual(len(obs_ops), 1, "exactly one observe_session must be queued")
        self.assertEqual(obs_ops[0]["state"], "queued")

        # Original dispatchAt must be preserved (not replaced with reconcile timestamp)
        obs_input = json.loads(obs_ops[0]["input"])
        self.assertEqual(obs_input["dispatchAt"], chat_op["input"]["dispatchAt"],
                         "observe must carry the original dispatch timestamp")
        self.assertIn("instructionsHash", obs_input, "instructions hash must be present")

        # Task and assignment states
        snap2 = restarted.get_assignment("job-1")
        self.assertEqual(snap2["tasks"][0]["state"], "awaiting_output")
        self.assertEqual(snap2["state"], "queued")

        # Audit event emitted
        events = restarted.events()["events"]
        kinds = [e["kind"] for e in events]
        self.assertIn("reconciliation_queued", kinds)

    def test_reconcile_does_not_requeue_original_chat(self):
        """reconcile_task must never add a second chat_session operation."""
        self._make_ambiguous(now_start=1)
        snap = self.registry.get_assignment("job-1")
        self.registry.reconcile_task("job-1", "task-1", snap["revision"], now=20)
        with self.registry.connection() as db:
            chats = db.execute(
                "SELECT id FROM operations WHERE assignment='job-1' AND kind='chat_session'"
            ).fetchall()
        self.assertEqual(len(chats), 1, "exactly one chat_session must exist (the original)")

    def test_reconcile_retains_original_session_reservation(self):
        """After reconcile the original session remains locked; a competing task cannot claim it.

        After reconcile, job-1's task is ``awaiting_output`` (ACTIVE_TASK_STATES) and its
        session remains occupied.  The only claimable operation is job-1's reconcile observe;
        job-2's chat targeting the same session must be blocked for as long as job-1 holds it.
        """
        chat_op = self._make_ambiguous(now_start=1)
        snap = self.registry.get_assignment("job-1")
        self.registry.reconcile_task("job-1", "task-1", snap["revision"], now=20)

        # Competing assignment targeting the same session
        self.registry.submit(
            assignment("job-2", "key-2", [task("task-2", session_id=chat_op["sessionId"])]),
            now=21,
        )

        # The only claimable operation is job-1's reconcile observe (session is held by job-1)
        obs = self.registry.claim_operation("worker", now=22)
        self.assertIsNotNone(obs)
        self.assertEqual(obs["kind"], "observe_session")
        self.assertEqual(obs["sessionId"], chat_op["sessionId"])
        # Verify this is job-1's operation, not job-2's chat
        with self.registry.connection() as db:
            obs_row = db.execute("SELECT assignment FROM operations WHERE id=?", (obs["operationId"],)).fetchone()
        self.assertEqual(obs_row["assignment"], "job-1",
                         "claimed observe must belong to job-1 -- session is still exclusively reserved")

        # While job-1's observe is active (claimed) job-2's task still cannot grab the session
        self.assertIsNone(
            self.registry.claim_operation("worker-2", now=23),
            "original session must remain exclusively reserved while job-1 holds awaiting_output",
        )

    def test_reconcile_duplicate_rejected_while_observe_pending(self):
        """A second reconcile call while the first observe is still queued/claimed must be rejected."""
        self._make_ambiguous(now_start=1)
        snap = self.registry.get_assignment("job-1")
        self.registry.reconcile_task("job-1", "task-1", snap["revision"], now=20)
        snap2 = self.registry.get_assignment("job-1")
        with self.assertRaisesRegex(RuntimeError, "[Pp]ending observation"):
            self.registry.reconcile_task("job-1", "task-1", snap2["revision"], now=21)
        with self.registry.connection() as db:
            queued_obs = db.execute(
                "SELECT COUNT(*) FROM operations "
                "WHERE assignment='job-1' AND kind='observe_session' AND state='queued'"
            ).fetchone()[0]
        self.assertEqual(queued_obs, 1, "only one queued observe_session must exist after duplicate rejection")

    def test_reconcile_collects_upstream_result_after_exhausted_monitor(self):
        """After poll budget exhaustion the task is blocked; reconcile allows one fresh observe
        that succeeds when the upstream session completed while the monitor was waiting."""
        body = assignment()
        body["tasks"][0]["observationTimeoutSeconds"] = 665
        self.registry.submit(body, now=1)
        chat_op = self.registry.claim_operation("worker", now=2)
        self.assertEqual(chat_op["kind"], "chat_session")
        self.registry.record_result(
            chat_op["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=3,
        )

        # Drive 20 "running" observations to exhaust the poll budget.
        now = 5
        for i in range(20):
            obs = self.registry.claim_operation("worker", now=now)
            self.assertIsNotNone(obs, f"poll #{i + 1} must be claimable")
            self.assertEqual(obs["kind"], "observe_session")
            self.registry.record_result(
                obs["operationId"],
                {"workerId": "worker", "outcome": "accepted",
                 "result": {"status": "running", "sessionId": chat_op["sessionId"]}},
                now=now + 1,
            )
            now += 35  # advance past exponential backoff delays

        task_snap = self.registry.get_assignment("job-1")["tasks"][0]
        self.assertEqual(task_snap["state"], "blocked", "poll budget must be exhausted")

        snap = self.registry.get_assignment("job-1")
        self.assertEqual(snap["state"], "held", "assignment must be held after exhaustion")

        result = self.registry.reconcile_task("job-1", "task-1", snap["revision"], now=now)
        self.assertEqual(result["state"], "awaiting_output")
        self.assertEqual(result["assignmentState"], "queued")

        # Worker picks up the reconcile observation and finds the upstream has completed.
        obs = self.registry.claim_operation("worker", now=now + 1)
        self.assertIsNotNone(obs)
        self.assertEqual(obs["kind"], "observe_session")
        complete_at = now + 0.5
        self.registry.record_result(
            obs["operationId"],
            {"workerId": "worker", "outcome": "accepted",
             "result": {
                 "status": "complete",
                 "assistantText": "DONE late",
                 "assistantAt": complete_at,
                 "sessionId": chat_op["sessionId"],
                 "reportedModel": "model-a",
             }},
            now=now + 2,
        )
        snap2 = self.registry.get_assignment("job-1")
        self.assertEqual(snap2["tasks"][0]["state"], "complete",
                         "complete upstream result must succeed even after budget exhaustion")
        results = self.registry.assignment_results("job-1")["results"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["text"], "DONE late")
        self.assertEqual(snap2["state"], "complete")



    def test_running_worker_is_monitored_beyond_twenty_observations(self):
        self.registry.submit(assignment(), now=1)
        chat = self.registry.claim_operation("worker", now=2)
        self.registry.record_result(chat["operationId"], {"workerId":"worker", "outcome":"accepted"}, now=3)
        for index in range(25):
            now = 5 + index * 35
            obs = self.registry.claim_operation("worker", now=now)
            self.assertIsNotNone(obs)
            self.registry.record_result(obs["operationId"], {"workerId":"worker", "outcome":"accepted",
                "result":{"status":"running", "sessionId":chat["sessionId"]}}, now=now+1)
        self.assertEqual(self.registry.get_assignment("job-1")["tasks"][0]["state"], "awaiting_output")

    def test_monitor_deadline_holds_execution_without_releasing_or_relaunching(self):
        body = assignment()
        body["tasks"][0]["observationTimeoutSeconds"] = 60
        self.registry.submit(body, now=1)
        chat = self.registry.claim_operation("worker", now=2)
        self.registry.record_result(chat["operationId"], {"workerId":"worker", "outcome":"accepted"}, now=3)
        obs = self.registry.claim_operation("worker", now=100)
        self.registry.record_result(obs["operationId"], {"workerId":"worker", "outcome":"accepted",
            "result":{"status":"running", "sessionId":chat["sessionId"]}}, now=101)
        task_dto = self.registry.get_assignment("job-1")["tasks"][0]
        self.assertEqual(task_dto["state"], "blocked")
        self.assertIsNone(task_dto["releasedAt"])
        self.assertTrue(task_dto["reconciliation"]["required"])
        self.assertFalse(task_dto["reconciliation"]["redispatchAllowed"])
        self.assertIsNone(self.registry.claim_operation("worker", now=150))

    def test_monitor_deadline_contract_rejects_invalid_values(self):
        for value in [59,604801,True,1.5,"3600"]:
            body = assignment()
            body["tasks"][0]["observationTimeoutSeconds"] = value
            with self.assertRaisesRegex(ValueError,"observationTimeoutSeconds"):
                validate_assignment(body)

    def test_reconcile_rejects_released_reservation_and_invalid_revision(self):
        self._make_ambiguous()
        snap = self.registry.get_assignment("job-1")
        with self.assertRaises(ValueError):
            self.registry.reconcile_task("job-1","task-1",True,now=20)
        with self.registry.connection(write=True) as db:
            db.execute("UPDATE job_tasks SET released_at=10 WHERE assignment='job-1'")
        with self.assertRaisesRegex(RuntimeError,"retained execution"):
            self.registry.reconcile_task("job-1","task-1",snap["revision"],now=20)

    def test_reconcile_cli_does_not_create_a_missing_database(self):
        from snooze.reconcile_job import main
        from contextlib import redirect_stderr
        from io import StringIO
        missing = Path(self.temp.name) / "never-created"
        with redirect_stderr(StringIO()):
            rc = main(["--state-dir",str(missing),"--assignment-id","job-1","--task-id","task-1","--expected-revision","1"])
        self.assertEqual(rc,1)
        self.assertFalse(missing.exists())



    def test_reconcile_refuses_unapproved_or_unknown_assignment_state(self):
        self._make_ambiguous()
        snap = self.registry.get_assignment("job-1")
        for state, approved in [("error",1),("held",0)]:
            with self.registry.connection(write=True) as db:
                db.execute("UPDATE assignments SET state=?,approved=? WHERE id='job-1'",(state,approved))
            with self.assertRaisesRegex(RuntimeError,"not approved"):
                self.registry.reconcile_task("job-1","task-1",snap["revision"],now=20)

    def test_reconcile_refuses_changed_original_session_binding(self):
        self._make_ambiguous()
        snap = self.registry.get_assignment("job-1")
        with self.registry.connection(write=True) as db:
            row = db.execute("SELECT id,input FROM operations WHERE kind='chat_session'").fetchone()
            payload = json.loads(row["input"])
            payload["sessionId"] = "different-session"
            db.execute("UPDATE operations SET input=? WHERE id=?",(json.dumps(payload),row["id"]))
        with self.assertRaisesRegex(RuntimeError,"binding"):
            self.registry.reconcile_task("job-1","task-1",snap["revision"],now=20)

    def test_reconcile_cli_uses_existing_snooze_database(self):
        from snooze.reconcile_job import main
        from contextlib import redirect_stdout
        from io import StringIO
        self._make_ambiguous()
        snap = self.registry.get_assignment("job-1")
        target = self.db.parent / "snooze.sqlite3"
        import shutil
        shutil.copyfile(self.db,target)
        output = StringIO()
        with redirect_stdout(output):
            rc = main(["--state-dir",str(target.parent),"--assignment-id","job-1","--task-id","task-1","--expected-revision",str(snap["revision"])])
        self.assertEqual(rc,0)
        self.assertEqual(json.loads(output.getvalue())["taskState"],"awaiting_output")
        self.assertEqual(JobRegistry(target).get_assignment("job-1")["tasks"][0]["state"],"awaiting_output")


    # ------------------------------------------------------------------ #
    # Retained-blocked execution-lock semantics (repository=None)        #
    # ------------------------------------------------------------------ #

    def _make_retained_blocked(self, assignment_id="job-1", key="key-1"):
        """Submit, dispatch, then trigger observation timeout → blocked with dispatch_at set, released_at NULL."""
        body = assignment(assignment_id, key)
        body["tasks"][0]["observationTimeoutSeconds"] = 60
        self.registry.submit(body, now=1)
        chat = self.registry.claim_operation("worker", now=2)
        self.assertEqual(chat["kind"], "chat_session")
        self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=3)
        obs = self.registry.claim_operation("worker", now=100)
        self.assertEqual(obs["kind"], "observe_session")
        # dispatch_at=2; now-dispatch_at=99 >= observationTimeoutSeconds=60 → blocked, released_at stays NULL
        self.registry.record_result(obs["operationId"], {"workerId": "worker", "outcome": "accepted",
            "result": {"status": "running", "sessionId": chat["sessionId"]}}, now=101)
        return chat

    def test_retained_blocked_locks_session_and_scope(self):
        """A retained-blocked task (dispatch_at set, released_at NULL) must hold its session and scope."""
        chat = self._make_retained_blocked()
        with self.registry.connection() as db:
            row = db.execute("SELECT state,dispatch_at,released_at FROM job_tasks WHERE assignment='job-1'").fetchone()
        self.assertEqual(row["state"], "blocked")
        self.assertIsNotNone(row["dispatch_at"])
        self.assertIsNone(row["released_at"])

        # Same session: must be locked
        self.registry.submit(assignment("job-2", "key-2", [task("task-2")]), now=102)
        self.assertIsNone(self.registry.claim_operation("worker-2", now=103),
                          "retained-blocked task must hold the session lock")

        # Overlapping scope on a different account/session: must also be blocked
        self.register("account-b")
        self.registry.submit(
            assignment("job-3", "key-3", [task("task-3", account="account-b",
                                               scope="path:src/task-1.txt")], accounts=["account-b"]),
            now=102,
        )
        self.assertIsNone(self.registry.claim_operation("worker-3", now=103),
                          "retained-blocked task must hold its scope lock")

    def test_independent_session_eligible_within_capacity_when_retained_blocked(self):
        """A retained-blocked task consumes one capacity slot but a different session stays eligible."""
        sessions = [
            {"id": "session-s1", "model": "model-a", "workspace": "workspace-a"},
            {"id": "session-s2", "model": "model-a", "workspace": "workspace-a"},
        ]
        self.registry.register_account({
            "accountId": "account-a", "enabled": True, "authorized": True,
            "health": "healthy", "quota": "available", "allowUnknownQuota": False,
            "localCapacity": 2,
            "registeredSessions": sessions,
        })
        body = assignment(tasks=[task("t1", session_id="session-s1")])
        body["tasks"][0]["observationTimeoutSeconds"] = 60
        self.registry.submit(body, now=1)
        chat = self.registry.claim_operation("worker", now=2)
        self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=3)
        obs = self.registry.claim_operation("worker", now=100)
        self.registry.record_result(obs["operationId"], {"workerId": "worker", "outcome": "accepted",
            "result": {"status": "running", "sessionId": "session-s1"}}, now=101)
        # t1 is now retained-blocked on session-s1; slot 1 of 2 used

        self.registry.submit(
            assignment("job-2", "key-2", [task("t2", session_id="session-s2", scope="path:src/t2.txt")]),
            now=102,
        )
        op = self.registry.claim_operation("worker-2", now=103)
        self.assertIsNotNone(op, "task on independent session must be claimable within capacity")
        self.assertEqual(op["sessionId"], "session-s2")

    def test_predispatch_blocked_does_not_consume_occupancy_slot(self):
        """A credit-denied (pre-dispatch) blocked task sets released_at and must not occupy any slot."""
        class DenyAdmission:
            def reserve(self, **_kwargs):
                raise CreditDenied("insufficient credit")
            def release_known_refusal(self, *_args, **_kwargs):
                pass

        self.registry.credit_admission = DenyAdmission()
        self.registry.submit(assignment(), now=1)
        self.assertIsNone(self.registry.claim_operation("worker", now=2))
        with self.registry.connection() as db:
            row = db.execute("SELECT state,released_at FROM job_tasks WHERE assignment='job-1'").fetchone()
        self.assertEqual(row["state"], "blocked")
        self.assertIsNotNone(row["released_at"])  # pre-dispatch: slot was released

        # Same session must be claimable once credit restriction lifted
        self.registry.credit_admission = None
        self.registry.submit(assignment("job-2", "key-2", [task("task-2")]), now=3)
        op = self.registry.claim_operation("worker-2", now=4)
        self.assertIsNotNone(op, "pre-dispatch blocked must not occupy session or account slot")
        self.assertEqual(op["kind"], "chat_session")

    def test_max_workers_1_blocks_new_dispatch_while_retained_blocked_holds_slot(self):
        """Retained-blocked task counts toward global cap; a separate account's task must not dispatch."""
        self.register("account-b")
        # Set global cap=1 up front so it governs both dispatch and scheduling.
        self.registry.set_control("set_concurrency", 1, expected_revision=1)

        # Job-1 uses account-a; drive t1 to retained-blocked while global cap is already 1.
        body1 = assignment("job-1", "key-1", [task("t1")]) | {"scheduling": {"profile": "throughput"}}
        body1["tasks"][0]["observationTimeoutSeconds"] = 60
        self.registry.submit(body1, now=1)
        chat = self.registry.claim_operation("worker-a", now=2)  # cap=1, active_count→1; ok to dispatch
        self.assertEqual(chat["sessionId"], "session-account-a")
        self.registry.record_result(chat["operationId"], {"workerId": "worker-a", "outcome": "accepted"}, now=3)
        obs = self.registry.claim_operation("worker-a", now=100)
        self.registry.record_result(obs["operationId"], {"workerId": "worker-a", "outcome": "accepted",
            "result": {"status": "running", "sessionId": "session-account-a"}}, now=101)
        with self.registry.connection() as db:
            t1 = db.execute("SELECT state,released_at FROM job_tasks WHERE task_id='t1'").fetchone()
        self.assertEqual(t1["state"], "blocked")
        self.assertIsNone(t1["released_at"])  # retained: dispatch_at set, released_at NULL

        # Submit job-2 on account-b (different account/session, no scope conflict).
        # With t1 retained-blocked counting as 1, active_count=1 >= cap=1 → must not dispatch.
        self.registry.submit(
            assignment("job-2", "key-2", [task("t2", account="account-b")], accounts=["account-b"]),
            now=102,
        )
        self.assertIsNone(self.registry.claim_operation("worker-b", now=103),
                          "retained-blocked t1 must fill the cap=1 slot, blocking t2 dispatch")

    def test_predispatch_blocked_does_not_occupy_global_cap(self):
        """A credit-denied (pre-dispatch) blocked task leaves the global slot free."""
        class DenyAdmission:
            def reserve(self, **_kwargs):
                raise CreditDenied("insufficient credit")
            def release_known_refusal(self, *_args, **_kwargs):
                pass

        self.register("account-b")
        self.registry.set_control("set_concurrency", 1, expected_revision=1)
        self.registry.credit_admission = DenyAdmission()
        self.registry.submit(assignment(), now=1)
        self.assertIsNone(self.registry.claim_operation("worker", now=2))
        with self.registry.connection() as db:
            row = db.execute("SELECT state,released_at FROM job_tasks WHERE assignment='job-1'").fetchone()
        self.assertEqual(row["state"], "blocked")
        self.assertIsNotNone(row["released_at"])  # pre-dispatch: slot free

        # A different job can dispatch immediately because global cap is still open.
        self.registry.credit_admission = None
        self.registry.submit(assignment("job-2", "key-2",
            [task("t2", account="account-b")], accounts=["account-b"]), now=3)
        op = self.registry.claim_operation("worker-2", now=4)
        self.assertIsNotNone(op, "global cap must remain open after pre-dispatch block")
        self.assertEqual(op["kind"], "chat_session")

    def test_reconcile_observe_claimable_at_capacity(self):
        """observe_session for reconciliation must be claimable even when project capacity is exhausted."""
        self.register("account-b")
        body = assignment("job-1", "key-1", [task("t1")],
                          accounts=["account-a"], max_workers=1) | {"scheduling": {"profile": "economy"}}
        body["tasks"][0]["observationTimeoutSeconds"] = 60
        self.registry.submit(body, now=1)

        # Drive t1 to retained-blocked.
        chat = self.registry.claim_operation("worker", now=2)
        self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=3)
        obs = self.registry.claim_operation("worker", now=100)
        self.registry.record_result(obs["operationId"], {"workerId": "worker", "outcome": "accepted",
            "result": {"status": "running", "sessionId": chat["sessionId"]}}, now=101)

        # Inject a second reserved task in the same project to simulate capacity full.
        with self.registry.connection(write=True) as db:
            db.execute(
                "INSERT INTO assignments(id,project,idem,fingerprint,eligible,body,state,approved,revision,created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                ("filler-job", "project-a", "filler-idem", "fp2", '["account-b"]', '{}', "queued", 1, 1, 50),
            )
            db.execute(
                "INSERT INTO job_tasks(assignment,task_id,body,state,generation,selected_account,"
                "attempt_id,session_id,dispatch_at) VALUES(?,?,?,?,?,?,?,?,?)",
                ("filler-job", "filler-t", '{"scopeKeys":["path:filler.txt"],"dependsOn":[],"instructions":"",'
                 '"execution":{"mode":"existing-session","sessionId":"session-account-b","accountId":"account-b"},'
                 '"output":{"kind":"text","maxBytes":512,"format":"plain","expectedMarker":"OK"}}',
                 "reserved", 1, "account-b", "filler-attempt", "session-account-b", 50),
            )

        # With a reserved task in the project, project is "at capacity" (max_workers=1 for job-1, but
        # the global control cap matters for dispatch). Reconcile t1 and verify observe is claimable.
        snap = self.registry.get_assignment("job-1")
        self.registry.reconcile_task("job-1", "t1", snap["revision"], now=102)

        observe_op = self.registry.claim_operation("worker-reconcile", now=103)
        self.assertIsNotNone(observe_op,
                             "observe_session must be claimable at capacity for reconciliation")
        self.assertEqual(observe_op["kind"], "observe_session")
        self.assertEqual(observe_op["sessionId"], chat["sessionId"])

    def test_reconcile_rejects_if_different_task_occupies_session(self):
        """reconcile_task must raise RuntimeError when another live task already holds the session."""
        self._make_retained_blocked()
        snap = self.registry.get_assignment("job-1")
        self.assertEqual(snap["tasks"][0]["state"], "blocked")

        # Inject a live task on the same session (simulates a race that the fix prevents, but
        # reconcile must still guard against it defensively).
        task_body = json.dumps({
            "scopeKeys": ["path:other.txt"], "dependsOn": [], "instructions": "",
            "execution": {"mode": "existing-session", "sessionId": "session-account-a", "accountId": "account-a"},
            "output": {"kind": "text", "maxBytes": 512, "format": "plain", "expectedMarker": "OK"},
        })
        with self.registry.connection(write=True) as db:
            db.execute(
                "INSERT INTO assignments(id,project,idem,fingerprint,eligible,body,state,approved,revision,created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                ("other-job", "project-a", "other-idem", "fp", '["account-a"]', '{}', "queued", 1, 1, 100),
            )
            db.execute(
                "INSERT INTO job_tasks(assignment,task_id,body,state,generation,selected_account,"
                "attempt_id,session_id,dispatch_at) VALUES(?,?,?,?,?,?,?,?,?)",
                ("other-job", "other-task", task_body, "reserved", 1, "account-a",
                 "other-attempt", "session-account-a", 100),
            )

        with self.assertRaisesRegex(RuntimeError, "different live task"):
            self.registry.reconcile_task("job-1", "task-1", snap["revision"], now=102)

    # ------------------------------------------------------------------ #
    # Observation eligibility: quota/health bypass for observe_session    #
    # ------------------------------------------------------------------ #

    def test_exhausted_account_observe_bypasses_quota_gate(self):
        """observe_session is claimable for a quota-depleted account; chat_session dispatch is blocked."""
        self.registry.submit(assignment(), now=1)
        chat = self.registry.claim_operation("worker", now=2)
        self.assertEqual(chat["kind"], "chat_session")
        self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=3)
        # Account becomes quota-exhausted after the chat dispatch.
        self.register("account-a", quota="depleted")
        # observe_session must still be claimable despite depleted quota.
        obs = self.registry.claim_operation("worker", now=5)
        self.assertIsNotNone(obs, "observe_session must bypass quota gate for depleted account")
        self.assertEqual(obs["kind"], "observe_session")
        # chat_session submission for a depleted account is blocked.
        with self.assertRaisesRegex(RuntimeError, "quota"):
            self.registry.submit(assignment("job-2", "key-2", [task("task-2")]), now=4)

    def test_degraded_account_observe_bypasses_health_gate(self):
        """observe_session is claimable for a health-degraded account."""
        self.registry.submit(assignment(), now=1)
        chat = self.registry.claim_operation("worker", now=2)
        self.assertEqual(chat["kind"], "chat_session")
        self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=3)
        # Account health degrades after dispatch.
        self.register("account-a", health="degraded")
        obs = self.registry.claim_operation("worker", now=5)
        self.assertIsNotNone(obs, "observe_session must bypass health gate for degraded account")
        self.assertEqual(obs["kind"], "observe_session")

    def test_disabled_account_observe_is_denied(self):
        """A disabled account blocks observe_session."""
        self.registry.submit(assignment(), now=1)
        chat = self.registry.claim_operation("worker", now=2)
        self.assertEqual(chat["kind"], "chat_session")
        self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=3)
        self.register("account-a", enabled=False)
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            self.registry.claim_operation("worker", now=5)

    def test_unauthorized_account_observe_is_denied(self):
        """An unauthorized account blocks observe_session."""
        self.registry.submit(assignment(), now=1)
        chat = self.registry.claim_operation("worker", now=2)
        self.assertEqual(chat["kind"], "chat_session")
        self.registry.record_result(chat["operationId"], {"workerId": "worker", "outcome": "accepted"}, now=3)
        self.register("account-a", authorized=False)
        with self.assertRaisesRegex(RuntimeError, "authorized"):
            self.registry.claim_operation("worker", now=5)


if __name__ == "__main__":
    unittest.main()
