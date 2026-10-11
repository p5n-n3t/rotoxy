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
            "registeredSessions": sessions or [{"id": f"session-{account}", "model": "unknown", "workspace": "workspace-a"}],
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


if __name__ == "__main__":
    unittest.main()
