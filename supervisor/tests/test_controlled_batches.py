import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from snooze.credit_ledger import CreditDenied
from snooze.controlled_batches import _private_db, approve
from snooze.jobs import JobRegistry


class StrictDeny:
    def __init__(self): self.calls = 0
    def reserve(self, **_kwargs):
        self.calls += 1
        raise CreditDenied("verified credit unavailable")


def assignment():
    return {"schemaVersion": 1, "assignmentId": "batch-a", "idempotencyKey": "key-a", "projectId": "project-a",
        "eligibleAccountIds": ["account-a"], "maxWorkers": 1, "tasks": [{
            "taskId": "task-a", "dependsOn": [], "scopeKeys": ["path:src/a.py"], "instructions": "bounded work",
            "execution": {"mode": "existing-session", "sessionId": "session-a", "accountId": "account-a"},
            "output": {"kind": "text", "maxBytes": 512, "format": "plain", "expectedMarker": "DONE"}}]}


class ControlledBatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "private" / "jobs.sqlite3"
        self.credit = StrictDeny()
        self.registry = JobRegistry(self.path, credit_admission=self.credit)
        self.registry.register_account({"accountId": "account-a", "enabled": True, "authorized": True,
            "allowUnknownQuota": False, "health": "healthy", "quota": "available", "localCapacity": 1,
            "registeredSessions": [{"id": "session-a", "model": "reported", "workspace": "workspace-a"}]})
        self.registry.submit(assignment(), now=10)

    def tearDown(self): self.temp.cleanup()

    def queue(self):
        with self.registry.connection(write=True) as db:
            op_id = self.registry._queue_one_ready(db, 11)
        self.assertTrue(op_id)
        return op_id

    def grant(self, op_id, *, now=20, ttl=120, max_launches=1, accounts=None):
        return approve(self.registry, "batch-a", [op_id], accounts or ["account-a"], max_launches, ttl, True, now=now)

    def test_strict_credit_denial_still_holds_without_a_grant(self):
        self.queue()
        self.assertIsNone(self.registry.claim_operation("worker", now=12))
        with self.registry.connection() as db:
            op = db.execute("SELECT state,error_class,worker FROM operations").fetchone()
            task = db.execute("SELECT state FROM job_tasks").fetchone()
            assignment_row = db.execute("SELECT state FROM assignments").fetchone()
        self.assertEqual((op["state"], op["error_class"], op["worker"]), ("rejected", "CreditAdmissionDenied", None))
        self.assertEqual(task["state"], "blocked")
        self.assertEqual(assignment_row["state"], "held")
        self.assertEqual(self.credit.calls, 1)

    def test_exact_grant_is_consumed_atomically_only_after_strict_denial(self):
        op_id = self.queue()
        grant = self.grant(op_id)
        claimed = self.registry.claim_operation("worker", now=21)
        self.assertEqual(claimed["operationId"], op_id)
        self.assertEqual(self.credit.calls, 1)
        self.assertIsNone(self.registry.claim_operation("worker-2", now=22))
        with self.registry.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM controlled_batch_consumptions WHERE approval_id=?", (grant["approvalId"],)).fetchone()[0], 1)
        self.assertEqual([event["kind"] for event in self.registry.events()["events"]].count("controlled_batch_admitted"), 1)

    def test_concurrent_claimers_consume_one_approval_once(self):
        op_id = self.queue()
        grant = self.grant(op_id)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda worker: self.registry.claim_operation(worker, now=21), ["one", "two"]))
        self.assertEqual(sum(result is not None for result in results), 1)
        with self.registry.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM controlled_batch_consumptions WHERE approval_id=?", (grant["approvalId"],)).fetchone()[0], 1)
        self.assertEqual(self.credit.calls, 1)

    def test_mutated_operation_input_invalidates_approval_and_rolls_back_consumption(self):
        op_id = self.queue()
        self.grant(op_id)
        with self.registry.connection(write=True) as db:
            db.execute("UPDATE operations SET input=? WHERE id=?", (json.dumps({"sessionId": "foreign-session", "instructions": "changed"}), op_id))
        self.assertIsNone(self.registry.claim_operation("worker", now=21))
        with self.registry.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM controlled_batch_consumptions").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT state FROM operations WHERE id=?", (op_id,)).fetchone()[0], "rejected")

    def test_expiry_account_binding_and_launch_bounds(self):
        op_id = self.queue()
        with self.assertRaisesRegex(ValueError, "exactly match"):
            self.grant(op_id, accounts=["foreign-account"])
        with self.assertRaisesRegex(ValueError, "max launches"):
            self.grant(op_id, max_launches=2)
        grant = self.grant(op_id, now=20, ttl=30)
        self.assertIsNone(self.registry.claim_operation("worker", now=51))
        with self.registry.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM controlled_batch_consumptions WHERE approval_id=?", (grant["approvalId"],)).fetchone()[0], 0)

    def test_denied_held_operation_requeues_only_when_project_is_paused(self):
        op_id = self.queue()
        self.assertIsNone(self.registry.claim_operation("worker", now=12))
        with self.assertRaisesRegex(ValueError, "pause the project"):
            self.grant(op_id, now=20)
        control = self.registry.get_project_control("project-a")
        self.registry.set_project_control("project-a", "pause_dispatch", None, control["revision"], now=19)
        self.grant(op_id, now=20)
        control = self.registry.get_project_control("project-a")
        self.registry.set_project_control("project-a", "resume_dispatch", None, control["revision"], now=20)
        claimed = self.registry.claim_operation("worker", now=21)
        self.assertEqual(claimed["operationId"], op_id)

    def test_ambiguous_operation_cannot_be_requeued(self):
        no_credit = JobRegistry(self.path)
        op_id = self.queue()
        with no_credit.connection(write=True) as db:
            db.execute("UPDATE operations SET state='ambiguous',error_class='chat_ambiguous',worker=NULL,lease_until=NULL WHERE id=?", (op_id,))
            db.execute("UPDATE job_tasks SET state='ambiguous'")
            db.execute("UPDATE assignments SET state='held'")
        with self.assertRaisesRegex(ValueError, "operation state"):
            self.grant(op_id)

    def test_claim_transaction_rolls_back_if_consumption_commit_cannot_finish(self):
        op_id = self.queue()
        self.grant(op_id)
        event_writer = self.registry._event
        def fail_after_consumption(db, assignment_id, kind, data=None, now=None):
            if kind == "controlled_batch_admitted":
                raise RuntimeError("simulated process failure before claim commit")
            return event_writer(db, assignment_id, kind, data, now)
        self.registry._event = fail_after_consumption
        with self.assertRaisesRegex(RuntimeError, "simulated process failure"):
            self.registry.claim_operation("worker", now=21)
        with self.registry.connection() as db:
            self.assertEqual(db.execute("SELECT state FROM operations WHERE id=?", (op_id,)).fetchone()[0], "queued")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM controlled_batch_consumptions").fetchone()[0], 0)

    def test_grant_does_not_cover_a_new_generation(self):
        old_id = self.queue()
        self.grant(old_id)
        self.registry.claim_operation("worker", now=21)
        with self.registry.connection(write=True) as db:
            db.execute("UPDATE job_tasks SET generation=2,attempt_id='attempt-gen2',state='reserved',released_at=NULL WHERE assignment='batch-a' AND task_id='task-a'")
            db.execute("INSERT INTO operations(id,assignment,task_id,attempt_id,generation,account,kind,input,state,created_at,due_at) VALUES(?,?,?,?,?,?,?,?,'queued',?,?)",
                       ("operation-gen2", "batch-a", "task-a", "attempt-gen2", 2, "account-a", "chat_session", json.dumps({"sessionId":"session-a","instructions":"bounded work"}), 22, 22))
        self.assertIsNone(self.registry.claim_operation("worker-2", now=23))
        with self.registry.connection() as db:
            self.assertEqual(db.execute("SELECT state,error_class FROM operations WHERE id='operation-gen2'").fetchone()["error_class"], "CreditAdmissionDenied")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM controlled_batch_consumptions").fetchone()[0], 1)

    def test_cli_database_must_be_private_and_not_a_symlink(self):
        self.assertEqual(_private_db(str(self.path)), self.path)
        os.chmod(self.path, 0o644)
        with self.assertRaisesRegex(ValueError, "owner-only"):
            _private_db(str(self.path))
        os.chmod(self.path, 0o600)
        link = self.path.parent / "linked.sqlite3"
        link.symlink_to(self.path)
        with self.assertRaisesRegex(ValueError, "existing absolute"):
            _private_db(str(link))

    def test_local_cli_approves_only_existing_exact_rows(self):
        op_id = self.queue()
        completed = subprocess.run([sys.executable, "-m", "snooze.controlled_batches", "--jobs-db", str(self.path), "approve",
            "--assignment-id", "batch-a", "--operation-ids", op_id, "--accounts", "account-a",
            "--max-launches", "1", "--ttl-seconds", "120", "--ack-unknown-credit-cost"],
            env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1])}, capture_output=True, text=True, timeout=5)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        receipt = json.loads(completed.stdout)
        self.assertEqual(receipt["operationIds"], [op_id])
        self.assertEqual(receipt["maxLaunches"], 1)


if __name__ == "__main__": unittest.main()
