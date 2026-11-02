import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from snooze.agent_workspace import AgentWorkspace, WorkspaceError
from snooze import claude_workspace_worker as worker


class ClaudeAttemptBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "private" / "agent-workspace.sqlite3"
        AgentWorkspace(self.db)
        self.base = {
            "projectId": "project-a", "taskId": "task-a", "ownerClientId": "oauth-client-a",
            "profileId": "profile-claude-0001", "modelRequested": "claude-sonnet-4-6",
            "promptDigest": "a" * 64,
        }

    def tearDown(self):
        self.temp.cleanup()

    def command(self, command, **values):
        return worker.ledger_command(str(self.db), {"command": command, **values})

    def reserve(self, **overrides):
        return self.command("reserve", **(self.base | overrides))

    def test_reserve_is_atomic_idempotent_and_survives_reopen(self):
        first = self.reserve()
        self.assertTrue(first["created"])
        self.assertEqual(first["status"], "intent")
        self.assertRegex(first["attemptId"], r"^claude-attempt-[1-9][0-9]*$")

        # Reopen through the public command path just as a later process would.
        reopened = worker.ledger_command(str(self.db), {"command": "reserve", **self.base})
        self.assertFalse(reopened["created"])
        self.assertEqual(reopened["attemptId"], first["attemptId"])
        self.assertEqual(reopened["status"], "intent")
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM claude_workspace_attempts WHERE project_id='project-a' AND task_id='task-a'").fetchone()[0], 1)

    def test_full_bounded_multiline_result_is_not_silently_cut_to_a_preview(self):
        intent = self.reserve()
        text = 'line one\n' + 'review detail ' * 200
        result = self.command('update', projectId='project-a', taskId='task-a', ownerClientId='oauth-client-a', attemptId=intent['attemptId'], status='success', result=text)
        self.assertEqual(result['result'], text.strip())
        self.assertEqual(self.command('status', projectId='project-a', taskId='task-a', ownerClientId='oauth-client-a')['result'], text.strip())

    def test_wrong_owner_cannot_reserve_take_over_read_update_or_reconcile(self):
        first = self.reserve()
        other = self.base | {"ownerClientId": "oauth-client-b"}
        with self.assertRaisesRegex(WorkspaceError, "attempt_unavailable"):
            self.command("reserve", **other)
        self.assertEqual(self.command("status", projectId="project-a", taskId="task-a", ownerClientId="oauth-client-b"), {"found": False})
        with self.assertRaisesRegex(WorkspaceError, "attempt_unavailable"):
            self.command("update", projectId="project-a", taskId="task-a", ownerClientId="oauth-client-b", attemptId=first["attemptId"], status="success")
        self.assertEqual(self.command("reconcile", projectId="project-a", taskId="task-a", ownerClientId="oauth-client-b", staleBefore=int(worker.time.time())), {"found": False})

    def test_terminal_update_redacts_result_is_idempotent_and_cannot_be_rewritten(self):
        intent = self.reserve()
        running = self.command("update", projectId="project-a", taskId="task-a", ownerClientId="oauth-client-a", attemptId=intent["attemptId"], status="running")
        self.assertEqual(running["status"], "running")
        result = self.command("update", projectId="project-a", taskId="task-a", ownerClientId="oauth-client-a", attemptId=intent["attemptId"], status="success", modelReported="claude-sonnet-4-6", costUsd=0.0, result="Done. Bearer top-secret-token")
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["result"], "Done. Bearer [REDACTED]")
        repeated = self.command("update", projectId="project-a", taskId="task-a", ownerClientId="oauth-client-a", attemptId=intent["attemptId"], status="success", modelReported="claude-sonnet-4-6", costUsd=0.0, result="Done. Bearer top-secret-token")
        self.assertEqual(repeated["result"], result["result"])
        with self.assertRaisesRegex(WorkspaceError, "attempt_terminal"):
            self.command("update", projectId="project-a", taskId="task-a", ownerClientId="oauth-client-a", attemptId=intent["attemptId"], status="error", result="different")
        status = self.command("status", projectId="project-a", taskId="task-a", ownerClientId="oauth-client-a")
        self.assertEqual(status["result"], "Done. Bearer [REDACTED]")
        self.assertNotIn("top-secret-token", json.dumps(status))

    def test_explicit_stale_reconcile_marks_ambiguous_and_never_releases_attempt_for_replay(self):
        intent = self.reserve()
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE claude_workspace_attempts SET created=1,updated=1 WHERE attempt_key=?", (intent["attemptId"],))
        reconciled = self.command("reconcile", projectId="project-a", taskId="task-a", ownerClientId="oauth-client-a", staleBefore=2)
        self.assertEqual(reconciled["status"], "ambiguous")
        self.assertEqual(reconciled["result"], "reconciled_after_restart")
        again = self.reserve()
        self.assertFalse(again["created"])
        self.assertEqual(again["status"], "ambiguous")

    def test_old_unowned_row_is_migrated_but_never_adopted(self):
        with sqlite3.connect(self.db) as db:
            db.execute("CREATE TABLE claude_workspace_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'intent', model_requested TEXT, model_reported TEXT, prompt_digest TEXT, created INTEGER NOT NULL, total_cost_usd REAL, result TEXT, UNIQUE(project_id,task_id))")
            db.execute("INSERT INTO claude_workspace_attempts(project_id,task_id,status,model_requested,prompt_digest,created) VALUES('project-a','task-a','success','claude-sonnet-4-6',?,1)", ("b" * 64,))
        status = self.command("status", projectId="project-a", taskId="task-a", ownerClientId="oauth-client-a")
        self.assertEqual(status, {"found": False})
        with sqlite3.connect(self.db) as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(claude_workspace_attempts)")}
            self.assertTrue({"owner_client_id", "profile_id", "attempt_key", "updated"}.issubset(columns))
            self.assertEqual(db.execute("SELECT attempt_key,owner_client_id FROM claude_workspace_attempts").fetchone(), ("claude-attempt-1", None))
        with self.assertRaisesRegex(WorkspaceError, "attempt_unavailable"):
            self.reserve()

    def test_bridge_cli_emits_one_json_result_without_running_the_worker(self):
        import subprocess
        import sys
        request = {"command": "reserve", **self.base}
        proc = subprocess.run([sys.executable, "-m", "snooze.claude_workspace_worker", "--db", str(self.db), "--ledger"],
                              input=json.dumps(request), text=True, capture_output=True, cwd=Path(__file__).parents[1], timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        value = json.loads(proc.stdout)
        self.assertTrue(value["created"])
        self.assertEqual(value["status"], "intent")


if __name__ == "__main__":
    unittest.main()
