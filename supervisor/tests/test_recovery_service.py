import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from snooze.guidance import GuidanceInbox
from snooze.recovery_service import RecoveryService, _read_config, read_recovery_snapshot


class Pool:
    def __init__(self):
        self.jobs = []

    def submit(self, prompt, **kwargs):
        self.jobs.append((prompt, kwargs))


class RecoveryServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self._old_home = os.environ.get("HOME")
        self._old_config = os.environ.get("TOKEN2OAUTH_CONFIG_DIR")
        os.environ["HOME"] = str(self.root / "home")
        os.environ["TOKEN2OAUTH_CONFIG_DIR"] = str(self.root / "gateway-config")
        Path(os.environ["HOME"]).mkdir(mode=0o700)
        Path(os.environ["TOKEN2OAUTH_CONFIG_DIR"]).mkdir(mode=0o700)
        self.addCleanup(self._restore_test_environment)
        self.inbox_path = self.root / "inbox.sqlite3"
        self.state_path = self.root / "service.sqlite3"
        self.inbox = GuidanceInbox(self.inbox_path)
        self.project, self.owner, self.worker = "project-a", "owner-a", "worker-a"
        self.inbox.register(worker=self.worker, project=self.project, owner=self.owner,
                            account="account-a", session="session-a", model="codex")

    def config(self, *, policy=None):
        return {
            "version": 1, "inboxDb": str(self.inbox_path), "stateDb": str(self.state_path),
            "intervalSeconds": 60, "maxEventsPerCycle": 10,
            "projects": [{"project": self.project, "scope": "scope-a", "owners": [self.owner],
                          "policy": policy or {"level": "observe", "permissions": [], "rules": {},
                              "max_attempts": 1, "max_runtime_seconds": 5, "action_budget_usd": 0,
                              "budget_ceiling_usd": 0, "oracle_advice": False, "oracle_hourly_limit": 0,
                              "headless_adapter_verified": False}}],
        }

    def service(self, **kwargs):
        return RecoveryService(self.config(**kwargs))

    def _restore_test_environment(self):
        if self._old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._old_home
        if self._old_config is None:
            os.environ.pop("TOKEN2OAUTH_CONFIG_DIR", None)
        else:
            os.environ["TOKEN2OAUTH_CONFIG_DIR"] = self._old_config

    def observe(self, state):
        return self.inbox.observe(self.worker, {"state": state}, owner=self.owner, job=self.project, now=1000)

    def test_once_and_restart_resume_cursor_and_ack_only_after_receipt(self):
        event = self.observe("failed")
        first = self.service().run_once()
        second = RecoveryService(self.config()).run_once()
        self.assertEqual(first["processed"], 1)
        self.assertEqual(second["processed"], 0)
        self.assertEqual(second["cursor"], event["eventId"])
        with sqlite3.connect(self.state_path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM recovery_events").fetchone()[0], 1)
            source = db.execute("SELECT state FROM recovery_service_sources WHERE inbox_event_id=?", (event["eventId"],)).fetchone()
        self.assertEqual(source[0], "observed")
        self.assertIsNotNone(self.inbox.inbox()[0]["ack_at"])

    def test_idle_review_does_not_call_oracle(self):
        event = self.observe("idle")
        policy = self.config()["projects"][0]["policy"]
        policy.update(oracle_advice=True, oracle_hourly_limit=2)
        pool = Pool()
        service = RecoveryService(self.config(policy=policy), oracle_pool=pool)
        service.run_once()
        self.assertEqual(pool.jobs, [])
        self.assertEqual(service.engine.get("guidance-" + str(event["eventId"]))["advice"], None)

    def test_rule_action_has_durable_receipt_and_is_not_replayed_after_restart(self):
        event = self.observe("failed")
        policy = self.config()["projects"][0]["policy"]
        policy.update(level="rules", permissions=["rule:ack-inbox"], rules={"failed": "ack-inbox"})
        service = RecoveryService(self.config(policy=policy))
        service.run_once()
        RecoveryService(self.config(policy=policy)).run_once()
        recovery_id = "guidance-" + str(event["eventId"])
        with sqlite3.connect(self.state_path) as db:
            actions = db.execute("SELECT action,state,receipt FROM recovery_actions WHERE event_id=?", (recovery_id,)).fetchall()
        self.assertEqual(len(actions), 1)
        self.assertEqual((actions[0][0], actions[0][1]), ("ack-inbox", "completed"))
        self.assertIn("guidance-inbox-ack", actions[0][2])

    def test_registration_owner_mismatch_becomes_audited_handoff(self):
        self.observe("failed")
        with sqlite3.connect(self.inbox_path) as db:
            db.execute("UPDATE guidance_events SET owner='owner-b' WHERE id=1")
        receipt = self.service().run_once()
        with sqlite3.connect(self.state_path) as db:
            handoff = db.execute("SELECT state,receipt FROM recovery_service_sources WHERE inbox_event_id=1").fetchone()
            events = db.execute("SELECT count(*) FROM recovery_events").fetchone()[0]
        self.assertEqual(receipt["pendingHandoffs"], 1)
        self.assertEqual(handoff[0], "handoff")
        self.assertIn("trusted_registration_or_project_policy_missing", handoff[1])
        self.assertEqual(events, 0)

    def test_private_config_rejects_group_readable_file(self):
        path = self.root / "config.json"
        path.write_text(json.dumps(self.config()))
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private_owner_permissions_required"):
            _read_config(path)

    def test_once_cli_emits_receipt(self):
        self.observe("failed")
        config_path = self.root / "recovery.json"
        config_path.write_text(json.dumps(self.config()))
        config_path.chmod(0o600)
        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
        result = subprocess.run([sys.executable, "-m", "snooze.recovery_service", "--config",
                                 str(config_path), "--once"], capture_output=True, text=True,
                                env=env, timeout=10, check=True)
        self.assertEqual(json.loads(result.stdout)["processed"], 1)

    def test_snapshot_is_project_and_owner_scoped_with_private_cursor(self):
        self.observe("failed")
        worker_b = "worker-b"
        self.inbox.register(worker=worker_b, project="project-b", owner="owner-b",
                            account="account-b", session="session-b", model="codex")
        self.inbox.observe(worker_b, {"state": "failed"}, owner="owner-b", job="project-b", now=1001)
        config = self.config()
        config["projects"].append({"project": "project-b", "scope": "scope-b", "owners": ["owner-b"],
                                    "policy": config["projects"][0]["policy"]})
        RecoveryService(config).run_once()
        snapshot = read_recovery_snapshot(self.state_path, project="project-a", owners=["owner-a"])
        self.assertEqual(snapshot["project"], "project-a")
        self.assertEqual(snapshot["cursor"], 1)
        self.assertEqual(len(snapshot["decisions"]), 1)
        encoded = json.dumps(snapshot)
        self.assertNotIn("project-b", encoded)
        self.assertNotIn("owner-b", encoded)
        self.assertEqual(read_recovery_snapshot(self.state_path, project="project-a", owners=["owner-b"])["decisions"], [])
        self.assertEqual(read_recovery_snapshot(self.state_path, project="project-a", owners=["owner-a"], after=1)["decisions"], [])

    def test_snapshot_contains_notify_receipt_and_redacted_completed_advice(self):
        event = self.observe("failed")
        policy = self.config()["projects"][0]["policy"]
        policy.update(level="notify", permissions=["notify"], oracle_advice=True, oracle_hourly_limit=2)
        pool = Pool()
        service = RecoveryService(self.config(policy=policy), oracle_pool=pool)
        service.run_once()
        recovery_id = "guidance-" + str(event["eventId"])
        job_id = service.engine.get(recovery_id)["advice"]["job_id"]
        oracle_db = self.root / "oracle.sqlite3"
        with sqlite3.connect(oracle_db) as db:
            db.execute("CREATE TABLE pool_tasks(id TEXT PRIMARY KEY,status TEXT,result TEXT,actual_model TEXT,model TEXT,updated REAL)")
            db.execute("INSERT INTO pool_tasks VALUES(?,?,?,?,?,?)", (job_id, "complete", "Advice: Bearer secret-value; api_key=topsecret", "qwen3.5:9b", "qwen3.5:9b", 1002))
        oracle_db.chmod(0o600)
        snapshot = read_recovery_snapshot(self.state_path, project=self.project, owners=[self.owner], oracle_db_path=oracle_db)
        self.assertEqual(snapshot["notifyReceipts"][0]["eventId"], recovery_id)
        self.assertEqual(snapshot["oracleAdvice"][0]["status"], "complete")
        self.assertTrue(snapshot["oracleAdvice"][0]["advisoryOnly"])
        self.assertNotIn("secret-value", snapshot["oracleAdvice"][0]["result"])
        self.assertNotIn("topsecret", snapshot["oracleAdvice"][0]["result"])

    def headless_config(self):
        home = self.root / "codex-home"
        home.mkdir(mode=0o700)
        project = self.root / "project"
        project.mkdir()
        executable = self.root / "codex-fake"
        capture = self.root / "codex-called"
        executable.write_text("#!/usr/bin/python3\nimport sys\nopen(%r,'w').write('called')\nprint('{\\\"type\\\":\\\"turn.completed\\\"}')\n" % str(capture))
        executable.chmod(0o700)
        headless = {"executable": str(executable), "projectDir": str(project), "codexHome": str(home),
                    "sessions": [{"project": self.project, "owner": self.owner, "session": "session-a"}],
                    "timeoutSeconds": 2}
        policy = self.config()["projects"][0]["policy"]
        policy.update(level="headless", permissions=["headless"], action_budget_usd=0.01,
                      budget_ceiling_usd=0.05, headless_adapter_verified=True)
        config = self.config(policy=policy)
        config["headless"] = headless
        return config, capture, policy

    def verified_resources(self, context):
        import time
        return {"verified": True, "quota": "available", "budgetVerified": True,
                "observedAt": time.time(), "availableBudgetUsd": 0.05,
                "project": context["project"], "job": context["job"],
                "account": context["account"], "session": context["session"]}

    def test_headless_is_opt_in_and_missing_resource_verifier_blocks_before_cli(self):
        self.observe("failed")
        config, capture, _ = self.headless_config()
        receipt = RecoveryService(config).run_once()
        self.assertEqual(receipt["processed"], 1)
        self.assertFalse(capture.exists())
        with sqlite3.connect(self.state_path) as db:
            decision = db.execute("SELECT decision FROM recovery_events").fetchone()[0]
        self.assertIn("resource_verifier_unavailable", decision)

    def test_headless_executes_once_only_after_trusted_resource_verification(self):
        self.observe("failed")
        config, capture, _ = self.headless_config()
        first = RecoveryService(config, resource_verifier=self.verified_resources).run_once()
        second = RecoveryService(config, resource_verifier=self.verified_resources).run_once()
        self.assertEqual(first["processed"], 1)
        self.assertEqual(second["processed"], 0)
        self.assertTrue(capture.exists())
        with sqlite3.connect(self.state_path) as db:
            actions = db.execute("SELECT state,receipt FROM recovery_actions WHERE action='headless'").fetchall()
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0][0], "completed")
        self.assertIn("codex-exec-resume", actions[0][1])


if __name__ == "__main__":
    unittest.main()
