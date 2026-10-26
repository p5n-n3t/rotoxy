import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from snooze.granted_supervisor import GrantedSupervisor, GrantedSupervisorError
from snooze.guidance import GuidanceInbox
from snooze.supervisor_grants import SupervisorGrantStore


class Clock:
    def __init__(self, now=1000):
        self.now = now

    def __call__(self):
        return self.now


class GrantedSupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inbox_path = self.root / "private" / "inbox.sqlite3"
        self.grants_path = self.root / "private" / "grants.sqlite3"
        self.results_path = self.root / "private" / "results.sqlite3"
        self.project_dir = self.root / "project"
        self.project_dir.mkdir(mode=0o700)
        self.codex_home = self.root / "codex-home"
        self.codex_home.mkdir(mode=0o700)
        self.capture = self.root / "calls.jsonl"
        self.executable = self.root / "fake-codex"
        self.executable.write_text("#!/usr/bin/python3\nimport json,sys\nopen(%r,'a').write(json.dumps({'argv':sys.argv,'stdin':sys.stdin.read()})+'\\n')\nprint(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'Inspect the durable event ledger.'}}))\nprint(json.dumps({'type':'turn.completed'}))\n" % str(self.capture))
        self.executable.chmod(0o700)
        self.clock = Clock()
        self.inbox = GuidanceInbox(self.inbox_path)
        self.inbox.register(worker="worker-a", project="project-a", owner="oauth-client:client-a",
                            account="account-a", session="remote-session-a", model="model-a")
        self.grants = SupervisorGrantStore(self.grants_path, clock=self.clock)

    def supervisor(self):
        return GrantedSupervisor(
            inbox_path=self.inbox_path, grants_path=self.grants_path, results_path=self.results_path,
            executable=self.executable, project_dir=self.project_dir, codex_home=self.codex_home,
            sessions=[{
                "project": "project-a", "owner": "oauth-client:client-a", "remoteSession": "remote-session-a",
                "executor": "codex-cli", "executorSession": "0199a213-81c0-7800-8aa1-bbab2a035a53",
                "codexSession": "0199a213-81c0-7800-8aa1-bbab2a035a53",
            }], timeout_seconds=2, clock=self.clock,
        )

    def event(self, state, **extra):
        observation = {"state": state, "model": "model-a", **extra}
        result = self.inbox.observe("worker-a", observation, owner="oauth-client:client-a", job="project-a", now=self.clock.now)
        self.assertIsNotNone(result["eventId"])
        return result["eventId"]

    def grant(self, event_types, **updates):
        value = {
            "project": "project-a", "owner": "oauth-client:client-a", "remote_session": "remote-session-a",
            "executor": "codex-cli", "executor_session": "0199a213-81c0-7800-8aa1-bbab2a035a53",
            "allowed_event_types": event_types, "expires_at": self.clock.now + 100,
            "max_runtime_seconds": 60, "max_invocations": 1,
            "authorization": {"quota": "unknown", "mode": "owner-controlled-batch", "reference": "approval-42"},
        }
        value.update(updates)
        return self.grants.issue(**value)

    def event_row(self, event_id):
        with sqlite3.connect(self.inbox_path) as db:
            # Canonical session incidents retain acknowledgement per authorized
            # viewer rather than putting one client's acknowledgement onto the
            # shared event row.
            return db.execute(
                "SELECT COALESCE((SELECT ack_at FROM canonical_event_viewers "
                "WHERE event_id=? AND project='project-a' AND owner='oauth-client:client-a'), "
                "(SELECT ack_at FROM guidance_events WHERE id=?))",
                (event_id, event_id),
            ).fetchone()

    def test_failed_and_idle_events_spawn_once_persist_advice_and_survive_restart(self):
        for state, expected_kind in (("failed", "failed"), ("idle", "idle_needs_review")):
            with self.subTest(state=state):
                event_id = self.event(state)
                grant = self.grant([expected_kind])
                first = self.supervisor().run_once(event_id=event_id, grant_id=grant["grantId"])
                self.assertEqual(first["state"], "completed")
                self.assertEqual(first["advisory"], "Inspect the durable event ledger.")
                self.assertTrue(first["advisoryOnly"])
                self.assertIsNotNone(self.event_row(event_id)[0])
                before = self.capture.read_text().count("\n")
                second = self.supervisor().run_once(event_id=event_id, grant_id=grant["grantId"])
                self.assertTrue(second["deduplicated"])
                self.assertEqual(self.capture.read_text().count("\n"), before)

    def test_scope_mismatch_becomes_durable_handoff_without_spawn(self):
        event_id = self.event("failed")
        grant = self.grant(["failed"], owner="oauth-client:other")
        result = self.supervisor().run_once(event_id=event_id, grant_id=grant["grantId"])
        self.assertEqual(result["state"], "handoff")
        self.assertEqual(result["reason"], "grant_scope_mismatch")
        self.assertFalse(self.capture.exists())
        self.assertIsNotNone(self.event_row(event_id)[0])

    def test_preclaimed_grant_is_fenced_as_ambiguous_after_restart_without_spawn(self):
        event_id = self.event("failed")
        grant = self.grant(["failed"])
        self.grants.claim(grant_id=grant["grantId"], project="project-a", owner="oauth-client:client-a",
                          remote_session="remote-session-a", executor="codex-cli",
                          executor_session="0199a213-81c0-7800-8aa1-bbab2a035a53", event_type="failed")
        result = self.supervisor().run_once(event_id=event_id, grant_id=grant["grantId"])
        self.assertEqual(result["state"], "ambiguous")
        self.assertEqual(result["reason"], "grant_claim_uncertain")
        self.assertFalse(self.capture.exists())
        self.assertIsNotNone(self.event_row(event_id)[0])

    def test_native_approval_is_advisory_only_and_never_passes_question_content(self):
        event_id = self.event("idle", needsInput=True, question={"kind": "approval", "text": "Deploy production now?", "id": "q-1"})
        grant = self.grant(["needs_approval"])
        result = self.supervisor().run_once(event_id=event_id, grant_id=grant["grantId"])
        self.assertEqual(result["state"], "completed")
        self.assertTrue(result["nativeApproval"])
        self.assertTrue(result["advisoryOnly"])
        captured = self.capture.read_text()
        self.assertNotIn("Deploy production now?", captured)
        self.assertNotIn("q-1", captured)

    def test_existing_symlink_or_nonprivate_result_path_is_rejected_before_sqlite_opens_it(self):
        target = self.root / "result-target.sqlite3"
        target.touch(mode=0o600)
        self.results_path.symlink_to(target)
        with self.assertRaisesRegex(GrantedSupervisorError, "unsafe_result_path"):
            self.supervisor()
        self.results_path.unlink()
        self.results_path.touch(mode=0o600)
        self.results_path.chmod(0o640)
        with self.assertRaisesRegex(GrantedSupervisorError, "unsafe_result_path"):
            self.supervisor()


if __name__ == "__main__":
    unittest.main()
