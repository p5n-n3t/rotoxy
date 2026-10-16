import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from snooze.credit_ledger import CreditDenied
from snooze.controlled_batches import approve
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
            "allowUnknownQuota": False, "health": "healthy", "quota": "unknown", "localCapacity": 1,
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
            self.assertEqual(db.execute("SELECT kind FROM job_events WHERE kind='controlled_batch_admitted'").fetchone()[0], "controlled_batch_admitted")
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
        claimed = self.registry.claim_operation("worker", now=21)
        self.assertEqual(claimed["operationId"], op_id)

    def test_ambiguous_operation_cannot_be_requeued(self):
        no_credit = JobRegistry(self.path)
        with no_credit.connection(write=True) as db:
            db.execute("UPDATE operations SET state='ambiguous',error_class='chat_ambiguous',worker=NULL,lease_until=NULL")
            db.execute("UPDATE job_tasks SET state='ambiguous'")
            db.execute("UPDATE assignments SET state='held'")
        with self.assertRaisesRegex(ValueError, "operation state"):
            self.grant("operation-id-does-not-matter")

    def test_claim_transaction_rolls_back_if_consumption_commit_cannot_finish(self):
        op_id = self.queue()
        self.grant(op_id)
        with self.registry.connection(write=True) as db:
            db.execute("CREATE TRIGGER reject_controlled_use BEFORE INSERT ON controlled_batch_consumptions BEGIN SELECT RAISE(ABORT,'simulated crash'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.registry.claim_operation("worker", now=21)
        with self.registry.connection() as db:
            self.assertEqual(db.execute("SELECT state FROM operations WHERE id=?", (op_id,)).fetchone()[0], "queued")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM controlled_batch_consumptions").fetchone()[0], 0)


if __name__ == "__main__": unittest.main()
