import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from snooze import oracle_model_admin as models
from snooze.oracle_pool import HOSTS, default_config


class OracleModelAdminTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        os.chmod(self.root, 0o700)
        self.config = self.root / "config.json"
        self.db = self.root / "queue.sqlite3"
        self.cache = self.root / "inventory.json"
        fleet = {**default_config(), "version": 2, "hosts": [
            {**host, "enabled": True, "allowedModels": ["qwen3.5:9b", "gpt-oss:20b"]} for host in HOSTS
        ]}
        self.config.write_text(json.dumps(fleet)); os.chmod(self.config, 0o600)
        conn = sqlite3.connect(self.db)
        conn.executescript("""CREATE TABLE pool_tasks(id TEXT PRIMARY KEY,status TEXT,assigned_host TEXT);
        CREATE TABLE pool_hosts(id TEXT PRIMARY KEY,assigned INTEGER);""")
        conn.executemany("INSERT INTO pool_hosts VALUES(?,0)", [(h["id"],) for h in HOSTS])
        conn.execute("INSERT INTO pool_tasks VALUES('queued-one','queued',NULL)")
        conn.execute("INSERT INTO pool_tasks VALUES('done-one','complete','ora1')")
        conn.commit(); conn.close(); os.chmod(self.db, 0o600)

    def tearDown(self): self.temp.cleanup()

    def test_refresh_uses_only_fixed_readonly_script_and_caches_bounded_inventory(self):
        initial = models.snapshot(self.config, self.db, self.cache)
        calls = []
        def probe(host, script):
            calls.append((host["id"], script))
            self.assertIn("NoRedirect", script)
            self.assertIn("http://127.0.0.1:11434/api/tags", script)
            self.assertNotIn("POST", script)
            payload = [
                {"name": "qwen3.5:9b", "size": 12345, "modified_at": "2026-10-01T00:00:00Z"},
                {"name": "gpt-oss:20b", "size": 9876, "modified_at": "2026-10-02T00:00:00Z"},
                {"name": "bad model", "size": 1, "modified_at": "later"},
                {"name": "x" * 500, "size": 2**80, "modified_at": "later"},
            ] + [{"name": f"extra-{index}:1", "size": index, "modified_at": None} for index in range(300)]
            return {"status": "healthy", "body": {"models": payload}}
        refreshed = models.refresh(self.config, self.db, self.cache, initial["cacheRevision"], probe)
        self.assertEqual([call[0] for call in calls], [host["id"] for host in HOSTS])
        self.assertEqual(refreshed["hosts"][0]["hostStatus"], "healthy")
        self.assertEqual([m["name"] for m in refreshed["hosts"][0]["models"]], ["qwen3.5:9b", "gpt-oss:20b"] + [f"extra-{i}:1" for i in range(252)])
        self.assertEqual(refreshed["hosts"][0]["models"][0]["size"], 12345)
        self.assertTrue(refreshed["hosts"][0]["observedAt"])
        self.assertEqual(self.cache.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list(self.root.glob("inventory.json.backup.*"))), 1)

    def test_refresh_cas_and_fleet_host_removal_does_not_keep_stale_inventory(self):
        first = models.snapshot(self.config, self.db, self.cache)
        models.refresh(self.config, self.db, self.cache, first["cacheRevision"], lambda *_: {"status": "healthy", "body": {"models": []}})
        with self.assertRaisesRegex(ValueError, "cache_revision_conflict"):
            models.refresh(self.config, self.db, self.cache, first["cacheRevision"], lambda *_: self.fail("stale refresh probed host"))
        config = json.loads(self.config.read_text()); config["hosts"] = config["hosts"][1:]
        self.config.write_text(json.dumps(config)); os.chmod(self.config, 0o600)
        view = models.snapshot(self.config, self.db, self.cache)
        self.assertNotIn("ora1", [host["id"] for host in view["hosts"]])

    def test_queue_state_and_apply_fail_closed_with_exact_preview_only_reason(self):
        first = models.snapshot(self.config, self.db, self.cache)
        self.assertTrue(first["queue"]["available"])
        self.assertEqual(first["queue"]["statuses"], {"complete": 1, "queued": 1})
        self.assertEqual(first["queue"]["hosts"]["ora1"]["assigned"], 1)
        preview = models.apply_preview(self.config, self.db, self.cache, first["configRevision"])
        self.assertEqual(preview["apply"]["mode"], "previewOnly")
        self.assertIn("no shared maintenance fence", preview["apply"]["blockedReason"])
        with self.assertRaisesRegex(ValueError, "config_revision_conflict"):
            models.apply_preview(self.config, self.db, self.cache, "A" * 24)
        active_db = sqlite3.connect(self.db); active_db.execute("INSERT INTO pool_tasks VALUES('run','running','ora3')"); active_db.commit(); active_db.close()
        active = models.apply_preview(self.config, self.db, self.cache, first["configRevision"])
        self.assertIn("running", active["apply"]["blockedReason"])

    def test_missing_database_unknown_status_and_arbitrary_command_are_rejected(self):
        view = models.snapshot(self.config, self.root / "missing.sqlite", self.cache)
        self.assertFalse(view["queue"]["available"])
        blocked = models.apply_preview(self.config, self.root / "missing.sqlite", self.cache, view["configRevision"])
        self.assertEqual(blocked["apply"]["blockedReason"], "queue_state_unavailable")
        with self.assertRaisesRegex(ValueError, "request_invalid"):
            models.apply_request(self.config, self.db, self.cache, {"action": "run", "command": "systemctl restart"})

    def test_unknown_queue_status_is_not_treated_as_safe(self):
        conn = sqlite3.connect(self.db); conn.execute("INSERT INTO pool_tasks VALUES('future','future-state',NULL)"); conn.commit(); conn.close()
        view = models.snapshot(self.config, self.db, self.cache)
        self.assertFalse(view["queue"]["available"])
        self.assertEqual(view["queue"]["reason"], "queue_state_unknown")
        preview = models.apply_preview(self.config, self.db, self.cache, view["configRevision"])
        self.assertEqual(preview["apply"]["blockedReason"], "queue_state_unknown")


if __name__ == "__main__": unittest.main()
