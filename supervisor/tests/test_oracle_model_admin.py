import json
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
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
        self.assertIn("Restart/reload protocol is not yet validated", preview["apply"]["blockedReason"])
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
        legacy_db = self.root / "legacy.sqlite"
        conn = sqlite3.connect(legacy_db); conn.execute("CREATE TABLE old_schema(id INTEGER)"); conn.commit(); conn.close(); os.chmod(legacy_db, 0o600)
        self.assertIsNone(models._maintenance_readonly(legacy_db))
        with self.assertRaisesRegex(ValueError, "request_invalid"):
            models.apply_request(self.config, self.db, self.cache, {"action": "run", "command": "systemctl restart"})

    def test_legacy_pool_meta_json_is_not_a_maintenance_source(self):
        conn = sqlite3.connect(self.db)
        conn.execute("CREATE TABLE pool_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        conn.execute("INSERT INTO pool_meta VALUES('maintenance_state', ?)", (json.dumps({"epoch": 8, "paused": True,
            "configRevision": "A" * 24, "acknowledged": True,
            "blockers": {"running": 0, "ambiguous": 0, "dispatching": 0}, "reason": "paused"}),))
        conn.commit(); conn.close()
        self.assertIsNone(models._maintenance_readonly(self.db))

    def test_unknown_queue_status_is_not_treated_as_safe(self):
        conn = sqlite3.connect(self.db); conn.execute("INSERT INTO pool_tasks VALUES('future','future-state',NULL)"); conn.commit(); conn.close()
        view = models.snapshot(self.config, self.db, self.cache)
        self.assertFalse(view["queue"]["available"])
        self.assertEqual(view["queue"]["reason"], "queue_state_unknown")
        preview = models.apply_preview(self.config, self.db, self.cache, view["configRevision"])
        self.assertEqual(preview["apply"]["blockedReason"], "queue_state_unknown")

    def test_maintenance_status_read_is_readonly_and_actions_use_config_and_epoch_cas(self):
        initial = models.snapshot(self.config, self.db, self.cache)
        self.assertIsNone(initial["maintenance"])  # Old DB: no fence means unavailable, never an assumed epoch zero.
        state = {"epoch": 4, "paused": False, "configRevision": None, "acknowledged": False,
                 "blockers": {"running": 2, "ambiguous": 0, "dispatching": 0}, "reason": None}
        calls = []
        class FakePool:
            def request_maintenance(self, *, config_revision, expected_epoch):
                calls.append(("request", config_revision, expected_epoch))
                state.update(epoch=expected_epoch + 1, paused=True, configRevision=config_revision, acknowledged=False, reason="draining")
                return dict(state)
            def release_maintenance(self, *, config_revision, expected_epoch):
                calls.append(("release", config_revision, expected_epoch))
                state.update(epoch=expected_epoch + 1, paused=False, configRevision=None, acknowledged=False, blockers={"running": 0, "ambiguous": 0, "dispatching": 0}, reason=None)
                return dict(state)
        factory = lambda _path: FakePool()
        with patch.object(models, "_maintenance_readonly", side_effect=lambda _db: dict(state)):
            requested = models.apply_request(self.config, self.db, self.cache,
                {"action": "maintenance-request", "expectedConfigRevision": initial["configRevision"], "expectedEpoch": 4}, pool_factory=factory)
            self.assertEqual(requested["maintenance"]["epoch"], 5)
            self.assertEqual(requested["maintenance"]["reason"], "draining")
            resumed = models.apply_request(self.config, self.db, self.cache,
                {"action": "maintenance-release", "expectedConfigRevision": initial["configRevision"], "expectedEpoch": 5}, pool_factory=factory)
        self.assertFalse(resumed["maintenance"]["paused"])
        self.assertEqual(calls, [("request", initial["configRevision"], 4), ("release", initial["configRevision"], 5)])

    def test_maintenance_stale_revision_or_epoch_never_calls_core(self):
        view = models.snapshot(self.config, self.db, self.cache)
        calls = []
        class FakePool:
            def request_maintenance(self, **_kwargs): calls.append("request"); raise ValueError("maintenance_epoch_conflict")
        factory = lambda _path: FakePool()
        with self.assertRaisesRegex(ValueError, "maintenance_revision_conflict"):
            models.apply_request(self.config, self.db, self.cache, {"action": "maintenance-request", "expectedConfigRevision": "Z" * 24, "expectedEpoch": 0}, pool_factory=factory)
        with self.assertRaisesRegex(ValueError, "maintenance_epoch_conflict"):
            models.apply_request(self.config, self.db, self.cache, {"action": "maintenance-request", "expectedConfigRevision": view["configRevision"], "expectedEpoch": 0}, pool_factory=factory)
        self.assertEqual(calls, ["request"])

    def test_actual_core_controller_request_snapshot_release_stale_epoch_and_readonly_get(self):
        from snooze import oracle_pool
        if not hasattr(oracle_pool.OraclePool, "open_maintenance") or not hasattr(oracle_pool, "read_maintenance_status"):
            self.skipTest("integration requires the maintenance-fence core API to be integrated")
        db_path = self.root / "core-maintenance.sqlite3"
        oracle_pool.OraclePool(self.config, db_path)  # Create a realistic temporary core database.
        initial = models.snapshot(self.config, db_path, self.cache)
        before = db_path.read_bytes()
        read_again = models.snapshot(self.config, db_path, self.cache)
        self.assertEqual(read_again["maintenance"], oracle_pool.read_maintenance_status(db_path))
        self.assertEqual(db_path.read_bytes(), before, "GET must not mutate the maintenance database")
        requested = models.apply_request(self.config, db_path, self.cache,
            {"action": "maintenance-request", "expectedConfigRevision": initial["configRevision"], "expectedEpoch": 0})
        self.assertTrue(requested["maintenance"]["paused"])
        self.assertEqual(requested["maintenance"]["epoch"], 1)
        with self.assertRaisesRegex(ValueError, "maintenance_epoch_conflict"):
            models.apply_request(self.config, db_path, self.cache,
                {"action": "maintenance-release", "expectedConfigRevision": initial["configRevision"], "expectedEpoch": 0})
        resumed = models.apply_request(self.config, db_path, self.cache,
            {"action": "maintenance-release", "expectedConfigRevision": initial["configRevision"], "expectedEpoch": 1})
        self.assertFalse(resumed["maintenance"]["paused"])
        self.assertEqual(resumed["maintenance"]["epoch"], 2)

    def test_abort_after_fleet_edit_releases_original_fence_without_applying_config(self):
        from snooze.oracle_pool import OraclePool
        db_path = self.root / "edited-fleet.sqlite3"
        pool = OraclePool(self.config, db_path)
        initial = models.snapshot(self.config, db_path, self.cache)
        models.apply_request(self.config, db_path, self.cache,
            {"action": "maintenance-request", "expectedConfigRevision": initial["configRevision"], "expectedEpoch": 0})
        config = json.loads(self.config.read_text())
        config["hosts"][0]["enabled"] = False
        self.config.write_text(json.dumps(config))
        edited = models.snapshot(self.config, db_path, self.cache)
        self.assertNotEqual(initial["configRevision"], edited["configRevision"])
        with self.assertRaisesRegex(ValueError, "maintenance_revision_conflict"):
            models.apply_request(self.config, db_path, self.cache,
                {"action": "maintenance-release", "expectedConfigRevision": initial["configRevision"], "expectedEpoch": 1})
        resumed = models.apply_request(self.config, db_path, self.cache,
            {"action": "maintenance-release", "expectedConfigRevision": edited["configRevision"], "expectedEpoch": 1})
        self.assertFalse(resumed["maintenance"]["paused"])
        self.assertEqual(resumed["maintenance"]["epoch"], 2)
        self.assertTrue(pool.host_by_id["ora1"]["enabled"], "Abort must not apply edited config to existing daemon")


if __name__ == "__main__": unittest.main()
