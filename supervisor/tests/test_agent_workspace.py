import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from snooze.agent_workspace import AgentWorkspace, WorkspaceError

SUPERVISOR = Path(__file__).resolve().parents[1]


class AgentWorkspaceProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "private" / "workspace.sqlite3"
        self.env = {**os.environ, "PYTHONPATH": str(SUPERVISOR)}

    def tearDown(self):
        self.temp.cleanup()

    def call(self, value, expect=0):
        result = subprocess.run(
            [sys.executable, "-m", "snooze.agent_workspace", "--db", str(self.db)],
            input=json.dumps(value), text=True, capture_output=True, cwd=SUPERVISOR, env=self.env, timeout=8,
        )
        self.assertEqual(result.returncode, expect, result.stderr + result.stdout)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout)

    def snapshot(self, project="p1", actor="client:alice"):
        return self.call({"command": "snapshot", "projectId": project, "actor": actor})

    def update(self, actor, action, project="p1", key=None, expected=None):
        if expected is None:
            expected = self.snapshot(project, actor)["revision"]
        value = {"idempotencyKey": key or f"{actor}-{action}-{expected}", "expectedRevision": expected, **action}
        return self.call({"command": "update", "projectId": project, "actor": actor, "input": value})

    def expect_error(self, actor, action, code, project="p1", expected=None, key=None):
        if expected is None:
            expected = self.snapshot(project, actor)["revision"]
        value = {"idempotencyKey": key or f"fail-{actor}-{action['action']}-{expected}", "expectedRevision": expected, **action}
        result = self.call({"command": "update", "projectId": project, "actor": actor, "input": value}, expect=2)
        self.assertEqual(result, {"error": code})

    def participant(self, actor, revision=None):
        return self.update(actor, {"action": "participant_upsert", "label": actor, "provider": "reported"}, expected=revision)

    def test_shared_messages_redact_basic_url_and_json_credentials(self):
        self.participant("client:alice")
        self.update("client:alice", {"action": "message_send", "messageId": "redaction-proof", "to": "all",
            "text": 'Basic dXNlcjpwYXNz https://user:privatepass@example.test/ {"api_key":"private-json-value"}'})
        text = self.snapshot()["messages"][0]["text"]
        self.assertNotIn("dXNlcjpwYXNz", text)
        self.assertNotIn("privatepass", text)
        self.assertNotIn("private-json-value", text)
        self.assertIn("[REDACTED]", text)

    def test_process_restart_idempotency_revision_fence_and_permissions(self):
        self.participant("client:alice")
        self.participant("client:bob")
        first = self.update("client:alice", {"action": "task_create", "taskId": "task-a", "title": "Ship", "description": "Bounded task"}, key="task-create-idem")
        replay = self.update("client:alice", {"action": "task_create", "taskId": "task-a", "title": "Ship", "description": "Bounded task"}, key="task-create-idem", expected=2)
        self.assertEqual(first, replay, "identical replay returns the original result before revision checking")
        self.expect_error("client:alice", {"action": "task_create", "taskId": "other", "title": "Changed", "description": "different"}, "idempotency_conflict", expected=first["revision"], key="task-create-idem")
        claimed = self.update("client:alice", {"action": "task_claim", "taskId": "task-a"})
        self.expect_error("client:bob", {"action": "task_update", "taskId": "task-a", "state": "blocked"}, "assignee_required", expected=claimed["revision"])
        artifact = self.update("client:alice", {"action": "artifact_submit", "artifactId": "artifact-a", "taskId": "task-a", "kind": "branch", "reference": "branch-name", "title": "Implementation"})
        self.expect_error("client:alice", {"action": "review_decide", "artifactId": "artifact-a", "decision": "approved"}, "independent_reviewer_required", expected=artifact["revision"])
        self.update("client:bob", {"action": "review_decide", "artifactId": "artifact-a", "decision": "approved"})
        reopened = self.snapshot()
        self.assertEqual(reopened["tasks"][0]["state"], "complete")
        self.assertEqual(reopened["artifacts"][0]["state"], "approved")
        self.assertEqual(stat.S_IMODE(self.db.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.db.parent.stat().st_mode), 0o700)

    def test_inbox_receipts_and_project_isolation(self):
        self.participant("client:alice")
        self.participant("client:bob")
        self.update("client:alice", {"action": "message_send", "messageId": "msg-secret", "to": "client:bob", "text": "Please review Bearer token-example-secret"})
        self.assertEqual(self.snapshot("p1", "client:bob")["messages"][0]["text"], "Please review Bearer [REDACTED]")
        self.assertEqual(self.snapshot("p1", "client:alice")["messages"][0]["id"], "msg-secret")
        self.assertEqual(self.snapshot("p1", "client:outsider")["messages"], [])
        self.expect_error("client:alice", {"action": "message_ack", "messageId": "msg-secret"}, "recipient_only")
        self.update("client:bob", {"action": "message_ack", "messageId": "msg-secret"})
        self.assertTrue(self.snapshot("p1", "client:bob")["messages"][0]["acknowledged"])
        self.assertEqual(self.snapshot("p2", "client:alice")["participants"], [])
        self.assertEqual(self.snapshot("p2", "client:alice")["messages"], [])
        self.expect_error("client:alice", {"action": "message_ack", "messageId": "msg-secret"}, "participant_required", project="p2")

    def test_read_message_is_exact_private_and_not_limited_by_snapshot_page(self):
        self.participant("client:alice")
        self.participant("client:bob")
        self.update("client:alice", {"action": "message_send", "messageId": "direct", "to": "client:bob", "text": "Direct bounded message"})
        self.update("client:alice", {"action": "message_send", "messageId": "shared", "to": "all", "text": "Shared bounded message"})
        workspace = AgentWorkspace(self.db)
        direct = workspace.read_message("p1", "client:bob", "direct")
        self.assertEqual(direct, {"id": "direct", "sender": "client:alice", "recipient": "client:bob", "taskId": None,
                                  "text": "Direct bounded message", "createdAt": direct["createdAt"], "acknowledged": False,
                                  "senderContext": {"provider": "reported", "model": None, "accountId": None,
                                                    "label": "client:alice", "source": "participant_reported"}})
        self.assertEqual(workspace.read_message("p1", "client:alice", "direct")["id"], "direct")
        self.assertEqual(workspace.read_message("p1", "admin:local", "direct")["recipient"], "client:bob")
        self.assertEqual(workspace.read_message("p1", "client:bob", "shared")["text"], "Shared bounded message")
        with self.assertRaisesRegex(WorkspaceError, "message_not_found"):
            workspace.read_message("p1", "client:bob", "missing")
        with self.assertRaisesRegex(WorkspaceError, "message_not_found"):
            workspace.read_message("p1", "client:bob", "direct-other-project")
        with self.assertRaisesRegex(WorkspaceError, "message_not_found"):
            workspace.read_message("p1", "client:outsider", "shared")
        self.assertEqual(self.snapshot("p2", "client:alice")["messages"], [])
        with self.assertRaisesRegex(WorkspaceError, "message_not_found"):
            workspace.read_message("p2", "client:alice", "direct")

    def test_sender_context_is_a_send_time_snapshot_and_idempotent_replay_is_unchanged(self):
        self.update("client:alice", {"action": "participant_upsert", "label": "Alice", "provider": "openai",
                                      "model": "gpt-5", "accountId": "acct-first"})
        sent = {"action": "message_send", "messageId": "attributed", "to": "all", "text": "Hello"}
        first = self.update("client:alice", sent, key="send-attributed")
        original = {"provider": "openai", "model": "gpt-5", "accountId": "acct-first", "label": "Alice",
                    "source": "participant_reported"}
        self.assertEqual(self.snapshot("p1", "client:bob")["messages"][0]["senderContext"], original)

        self.update("client:alice", {"action": "participant_upsert", "label": "Alice renamed", "provider": "anthropic",
                                      "model": "claude-current", "accountId": "acct-current"})
        replay = self.update("client:alice", sent, key="send-attributed", expected=1)
        self.assertEqual(replay, first)
        message = self.snapshot("p1", "client:alice")["messages"][0]
        self.assertEqual(message["senderContext"], original)
        self.assertEqual(message["text"], "Hello")

    def test_legacy_message_migration_preserves_row_and_leaves_context_unknown(self):
        self.db.parent.mkdir(parents=True, mode=0o700)
        with sqlite3.connect(self.db) as db:
            db.execute("CREATE TABLE messages(project_id TEXT NOT NULL, id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, task_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project_id,id))")
            db.execute("INSERT INTO messages VALUES(?,?,?,?,?,?,?)", ("p1", "legacy", "client:alice", "all", None, "Before migration", 1234))

        workspace = AgentWorkspace(self.db)
        result = workspace.snapshot("p1", "admin:local")
        self.assertEqual(len(result["messages"]), 1)
        self.assertEqual(result["messages"][0]["text"], "Before migration")
        self.assertIsNone(result["messages"][0]["senderContext"])
        self.assertIsNone(workspace.read_message("p1", "admin:local", "legacy")["senderContext"])
        # Reopening applies the same migration safely and does not alter the record.
        AgentWorkspace(self.db)
        self.assertEqual(workspace.snapshot("p1", "admin:local")["messages"][0]["id"], "legacy")

    def test_dependency_claim_is_atomic_and_requires_completion(self):
        self.participant("client:alice")
        self.participant("client:bob")
        self.update("client:alice", {"action": "task_create", "taskId": "parent", "title": "Parent", "description": "P"})
        self.update("client:alice", {"action": "task_create", "taskId": "child", "title": "Child", "description": "C", "dependsOn": ["parent"]})
        self.expect_error("client:bob", {"action": "task_claim", "taskId": "child"}, "dependencies_incomplete")
        self.update("client:alice", {"action": "task_claim", "taskId": "parent"})
        self.update("client:alice", {"action": "artifact_submit", "artifactId": "parent-artifact", "taskId": "parent", "kind": "text", "reference": "done", "title": "Done"})
        self.update("client:bob", {"action": "review_decide", "artifactId": "parent-artifact", "decision": "approved"})
        self.assertEqual(self.update("client:bob", {"action": "task_claim", "taskId": "child"})["result"]["state"], "running")

    def test_conflicting_revision_fails_and_cli_rejects_unknown_fields(self):
        self.participant("client:alice")
        self.participant("client:bob")
        current = self.snapshot()["revision"]
        self.update("client:alice", {"action": "task_create", "taskId": "one", "title": "One", "description": "D"}, expected=current)
        self.expect_error("client:bob", {"action": "task_create", "taskId": "two", "title": "Two", "description": "D"}, "revision_conflict", expected=current)
        bad = self.call({"command": "snapshot", "projectId": "p1", "actor": "client:alice", "spoof": "no"}, expect=2)
        self.assertEqual(bad, {"error": "invalid_request"})

    def test_two_processes_cannot_claim_one_task(self):
        self.participant("client:alice")
        self.participant("client:bob")
        self.update("client:alice", {"action": "task_create", "taskId": "race", "title": "Race", "description": "One claim"})
        revision = self.snapshot()["revision"]

        def claim(actor):
            value = {"action": "task_claim", "taskId": "race", "idempotencyKey": f"claim-{actor}", "expectedRevision": revision}
            return subprocess.run(
                [sys.executable, "-m", "snooze.agent_workspace", "--db", str(self.db)],
                input=json.dumps({"command": "update", "projectId": "p1", "actor": actor, "input": value}),
                text=True, capture_output=True, cwd=SUPERVISOR, env=self.env, timeout=8,
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(claim, ("client:alice", "client:bob")))
        self.assertEqual(sorted(result.returncode for result in results), [0, 2])
        bodies = [json.loads(result.stdout) for result in results]
        self.assertEqual(sum("result" in body for body in bodies), 1)
        self.assertEqual(sum(body == {"error": "revision_conflict"} for body in bodies), 1)
        snapshot = self.snapshot()
        self.assertEqual(snapshot["tasks"][0]["state"], "running")
        self.assertIn(snapshot["tasks"][0]["assignee"], {"client:alice", "client:bob"})


if __name__ == "__main__":
    unittest.main()
