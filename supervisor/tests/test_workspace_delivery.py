import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from snooze.guidance import GuidanceInbox
from snooze.workspace_delivery import WorkspaceDelivery, WorkspaceDeliveryError


class WorkspaceDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inbox_path = self.root / "inbox.sqlite3"
        self.ledger_path = self.root / "deliveries.sqlite3"
        self.inbox = GuidanceInbox(self.inbox_path)
        self.inbox.register(worker="worker-a", project="project-a", owner="client-a",
                            account="account-a", session="session-a", model="claude-opus-5-5")
        self.service = WorkspaceDelivery(self.ledger_path, self.inbox_path)

    @staticmethod
    def message_hash(text="Guidance from the workspace"):
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def event(self, *, approval=False):
        observation = {"state": "idle", "needsInput": True,
                       "question": {"kind": "approval" if approval else "question", "text": "Need input"}}
        return self.inbox.observe("worker-a", observation, owner="client-a", job="project-a", now=10)["eventId"]

    def prepare(self, event_id, *, message_id="workspace-message-a", message_hash=None):
        return self.service.prepare(project="project-a", owner="client-a", workspace_message_id=message_id,
                                    guidance_event_id=event_id, worker="worker-a",
                                    message_hash=message_hash or self.message_hash(), now=20)

    def test_prepare_binds_registration_and_never_stores_message_body(self):
        prepared = self.prepare(self.event())
        self.assertEqual(prepared["state"], "pending")
        self.assertFalse(prepared["maySend"], "only claim_send can authorize one outbound attempt")
        self.assertEqual({key: prepared[key] for key in ("project", "owner", "worker", "accountId", "sessionId", "model")}, {
            "project": "project-a", "owner": "client-a", "worker": "worker-a",
            "accountId": "account-a", "sessionId": "session-a", "model": "claude-opus-5-5",
        })
        replay = self.prepare(self.inbox.inbox()[0]["id"])
        self.assertEqual(replay, prepared)
        with sqlite3.connect(self.ledger_path) as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(workspace_deliveries)")}
            values = db.execute("SELECT message_hash FROM workspace_deliveries").fetchone()
        self.assertNotIn("text", columns)
        self.assertEqual(values[0], self.message_hash())
        with self.assertRaisesRegex(WorkspaceDeliveryError, "idempotency_conflict"):
            self.prepare(self.inbox.inbox()[0]["id"], message_hash=self.message_hash("different"))

    def test_claim_is_crash_safe_and_ambiguous_send_never_retries(self):
        self.prepare(self.event())
        first = self.service.claim_send(project="project-a", owner="client-a", workspace_message_id="workspace-message-a", now=21)
        self.assertTrue(first["maySend"])
        self.assertEqual((first["state"], first["outcomeCode"]), ("ambiguous", "send_receipt_pending"))
        reopened = WorkspaceDelivery(self.ledger_path, self.inbox_path)
        repeat = reopened.claim_send(project="project-a", owner="client-a", workspace_message_id="workspace-message-a", now=22)
        self.assertFalse(repeat["maySend"])
        self.assertEqual(repeat["state"], "ambiguous")
        accepted = reopened.record_outcome(project="project-a", owner="client-a", workspace_message_id="workspace-message-a",
                                           outcome="accepted", outcome_code="provider_receipt", receipt_id="remote-message-a", now=23)
        self.assertEqual((accepted["state"], accepted["receiptId"]), ("accepted", "remote-message-a"))
        self.assertEqual(reopened.record_outcome(project="project-a", owner="client-a", workspace_message_id="workspace-message-a",
                                                  outcome="accepted", outcome_code="provider_receipt", receipt_id="remote-message-a", now=24), accepted)
        self.assertFalse(reopened.claim_send(project="project-a", owner="client-a", workspace_message_id="workspace-message-a")["maySend"])

    def test_direct_ambiguous_outcome_is_terminal_and_not_retryable(self):
        self.prepare(self.event())
        ambiguous = self.service.record_outcome(project="project-a", owner="client-a", workspace_message_id="workspace-message-a",
                                                outcome="ambiguous", outcome_code="provider_timeout", now=21)
        self.assertEqual(ambiguous["state"], "ambiguous")
        self.assertFalse(self.service.claim_send(project="project-a", owner="client-a", workspace_message_id="workspace-message-a")["maySend"])
        with self.assertRaisesRegex(WorkspaceDeliveryError, "ambiguous_delivery_not_retryable"):
            self.service.record_outcome(project="project-a", owner="client-a", workspace_message_id="workspace-message-a",
                                        outcome="rejected", outcome_code="late_failure", now=22)

    def test_native_approval_is_durably_rejected_without_a_send_claim(self):
        approval = self.prepare(self.event(approval=True))
        self.assertEqual((approval["state"], approval["outcomeCode"], approval["maySend"]),
                         ("rejected", "native_approval_requires_operator", False))
        self.assertFalse(self.service.claim_send(project="project-a", owner="client-a", workspace_message_id="workspace-message-a")["maySend"])
        with self.assertRaisesRegex(WorkspaceDeliveryError, "outcome_already_recorded"):
            self.service.record_outcome(project="project-a", owner="client-a", workspace_message_id="workspace-message-a",
                                        outcome="accepted", outcome_code="provider_receipt", receipt_id="forbidden", now=21)

    def test_registration_and_event_scope_must_be_exact(self):
        event = self.event()
        with self.assertRaisesRegex(WorkspaceDeliveryError, "worker_registration_missing"):
            self.service.prepare(project="project-a", owner="client-a", workspace_message_id="workspace-message-a",
                                 guidance_event_id=event, worker="worker-b", message_hash=self.message_hash())
        with self.assertRaisesRegex(WorkspaceDeliveryError, "guidance_event_not_owned"):
            self.service.prepare(project="project-a", owner="client-a", workspace_message_id="workspace-message-a",
                                 guidance_event_id=event + 1, worker="worker-a", message_hash=self.message_hash())

    def test_event_without_observed_account_and_session_binding_is_rejected(self):
        older = GuidanceInbox(self.root / "older-inbox.sqlite3")
        event = older.observe("worker-a", {"state": "failed"}, owner="client-a", job="project-a", now=10)["eventId"]
        older.register(worker="worker-a", project="project-a", owner="client-a",
                       account="account-a", session="session-a", model="claude-opus-5-5")
        service = WorkspaceDelivery(self.root / "older-deliveries.sqlite3", self.root / "older-inbox.sqlite3")
        result = service.prepare(project="project-a", owner="client-a", workspace_message_id="workspace-message-a",
                                 guidance_event_id=event, worker="worker-a", message_hash=self.message_hash())
        self.assertEqual((result["state"], result["outcomeCode"], result["maySend"]),
                         ("rejected", "guidance_event_binding_incomplete", False))

    def test_prepare_by_event_derives_owner_and_worker_without_caller_identity(self):
        event = self.event()
        result = self.service.prepare_by_event(project="project-a", workspace_message_id="workspace-message-a",
                                               guidance_event_id=event, message_hash=self.message_hash(), now=20)
        self.assertEqual((result["owner"], result["worker"], result["accountId"], result["sessionId"], result["model"]),
                         ("client-a", "worker-a", "account-a", "session-a", "claude-opus-5-5"))
        replay = self.service.prepare_by_event(project="project-a", workspace_message_id="workspace-message-a",
                                               guidance_event_id=event, message_hash=self.message_hash(), now=21)
        self.assertEqual(replay, result)
        with self.assertRaisesRegex(WorkspaceDeliveryError, "guidance_event_not_owned"):
            self.service.prepare_by_event(project="project-b", workspace_message_id="workspace-message-a",
                                          guidance_event_id=event, message_hash=self.message_hash())

    def test_prepare_by_event_rejects_native_approval_and_cli_has_no_identity_fields(self):
        event = self.event(approval=True)
        result = self.service.prepare_by_event(project="project-a", workspace_message_id="workspace-message-a",
                                               guidance_event_id=event, message_hash=self.message_hash())
        self.assertEqual((result["state"], result["outcomeCode"], result["maySend"]),
                         ("rejected", "native_approval_requires_operator", False))
        payload = {"command": "prepare-by-event", "project": "project-a", "workspaceMessageId": "workspace-message-b",
                   "guidanceEventId": event, "messageHash": self.message_hash()}
        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
        command = [sys.executable, "-m", "snooze.workspace_delivery", "--ledger", str(self.root / "cli.sqlite3"), "--inbox", str(self.inbox_path)]
        complete = subprocess.run(command, input=json.dumps(payload), text=True, capture_output=True, env=env, timeout=8)
        self.assertEqual(complete.returncode, 0, complete.stderr)
        self.assertEqual(json.loads(complete.stdout)["outcomeCode"], "native_approval_requires_operator")
        payload["owner"] = "client-a"
        invalid = subprocess.run(command, input=json.dumps(payload), text=True, capture_output=True, env=env, timeout=8)
        self.assertEqual(invalid.returncode, 2)
        self.assertEqual(json.loads(invalid.stdout), {"error": "invalid_request"})


if __name__ == "__main__":
    unittest.main()
