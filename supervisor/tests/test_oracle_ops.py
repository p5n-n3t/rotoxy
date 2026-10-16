import json
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from snooze.oracle_ops import HOST_IDS, load_snapshot
from snooze.oracle_pool import APPROVED_MODELS, DEFAULT_MODEL, HOSTS, OraclePool


class FakeTransport:
    def __init__(self):
        self.catalog_calls = 0
        self.generate_calls = 0

    def catalog(self, host):
        self.catalog_calls += 1
        return list(APPROVED_MODELS)

    def generate(self, host, model, prompt):
        self.generate_calls += 1
        return {"model": model, "response": "private-result", "prompt_eval_count": 7,
                "eval_count": 5, "total_duration": 1_000_000_000}


class OracleOpsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="t2o-oracle-ops-")
        self.addCleanup(self.temp.cleanup)
        # Isolate both configuration roots before constructing any store/pool object.
        self.old_home = os.environ.get("HOME")
        self.old_config = os.environ.get("TOKEN2OAUTH_CONFIG_DIR")
        os.environ["HOME"] = self.temp.name
        os.environ["TOKEN2OAUTH_CONFIG_DIR"] = str(Path(self.temp.name) / "gateway-config")
        self.addCleanup(self._restore_environment)
        self.root = Path(self.temp.name) / "oracle"
        self.config_path = self.root / "config.json"
        self.db_path = self.root / "queue.sqlite3"
        self.transport = FakeTransport()
        self.pool = OraclePool(self.config_path, self.db_path, self.transport)

    def _restore_environment(self):
        if self.old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self.old_home
        if self.old_config is None:
            os.environ.pop("TOKEN2OAUTH_CONFIG_DIR", None)
        else:
            os.environ["TOKEN2OAUTH_CONFIG_DIR"] = self.old_config

    def _insert_task(self, job_id, status, host, *, model=DEFAULT_MODEL, prompt_tokens=None, eval_tokens=None):
        row = self.pool.submit("sensitive prompt text", model=model, job_id=job_id, source="owner-secret-source")
        now = time.time()
        with self.pool._connect() as db:
            db.execute("UPDATE pool_tasks SET status=?,assigned_host=?,updated=?,actual_model=?,result=?,prompt_tokens=?,eval_tokens=? WHERE id=?",
                       (status, host, now, model, "sensitive result text", prompt_tokens, eval_tokens, row["id"]))
            self.pool._event(db, row["id"], status, {"status": status, "model": model, "host": host,
                            "source": "owner-secret-source", "error_code": None}, now)

    def _write_v2(self, path, hosts):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": 2, "default_model": DEFAULT_MODEL, "max_context": 4096,
                                    "max_predict": 512, "max_total_running": 3,
                                    "max_running_per_host": 1, "inference_timeout_seconds": 240,
                                    "hosts": hosts}), encoding="utf-8")
        path.chmod(0o600)

    def test_snapshot_uses_only_fixed_hosts_cached_catalog_and_observed_rows(self):
        self.pool.catalog(refresh=True)
        task = self.pool.submit("sensitive prompt text", job_id="caller-hash:private-task")
        self.pool.run_once()
        self._insert_task("caller-hash:other-one", "complete", "ora3", model="gpt-oss:20b", eval_tokens=2)
        self._insert_task("caller-hash:other-two", "running", "ora5", prompt_tokens=3)
        calls_before = self.transport.catalog_calls

        snapshot = load_snapshot(self.config_path, self.db_path, now=time.time())

        self.assertTrue(snapshot["available"])
        self.assertEqual([row["host"] for row in snapshot["hosts"]], list(HOST_IDS))
        self.assertNotIn("ora2", json.dumps(snapshot))
        self.assertEqual(self.transport.catalog_calls, calls_before, "snapshot performs no SSH/catalog probe")
        self.assertEqual(snapshot["hosts"][0]["catalogCheckState"], "checked")
        self.assertEqual(snapshot["advisoryModel"], {"model": "tev1:0.8b", "availability": "available"})
        self.assertEqual(snapshot["summary"]["assignmentDenominator"], 3)
        self.assertEqual([row["count"] for row in snapshot["summary"]["assignmentDistribution"]], [1, 1, 1])
        self.assertAlmostEqual(sum(row["share"] for row in snapshot["summary"]["assignmentDistribution"]), 1.0)
        self.assertEqual(snapshot["summary"]["promptTokens"]["total"], 10)
        self.assertEqual(snapshot["summary"]["evalTokens"]["total"], 7)
        encoded = json.dumps(snapshot)
        for forbidden in ("sensitive prompt text", "sensitive result text", "owner-secret-source", "caller-hash", "private-task"):
            self.assertNotIn(forbidden, encoded)
        self.assertTrue(snapshot["tasks"]["items"])
        self.assertNotIn("id", snapshot["tasks"]["items"][0])

    def test_empty_database_data_stays_unknown_and_missing_files_are_not_created(self):
        empty = load_snapshot(self.config_path, self.db_path)
        self.assertTrue(empty["available"])
        self.assertIsNone(empty["summary"]["promptTokens"]["total"])
        self.assertEqual(empty["summary"]["assignmentDenominator"], 0)
        self.assertTrue(all(row["share"] is None for row in empty["summary"]["assignmentDistribution"]))
        missing_db = self.root / "not-created.sqlite3"
        missing = load_snapshot(self.config_path, missing_db)
        self.assertFalse(missing["available"])
        self.assertIsNone(missing["summary"]["totalTasks"])
        self.assertFalse(missing_db.exists())

    def test_snapshot_reads_fourth_configured_host_without_fixed_sql_slots(self):
        hosts = [{**host, "enabled": True, "allowedModels": list(APPROVED_MODELS)} for host in HOSTS]
        hosts.append({"id": "ora7", "ip": "100.68.1.7", "ssh_host": "shh-ora7.ziopsyop.tech",
                      "enabled": True, "allowedModels": [DEFAULT_MODEL]})
        config_path = self.root / "four-host" / "config.json"
        db_path = config_path.parent / "queue.sqlite3"
        self._write_v2(config_path, hosts)
        pool = OraclePool(config_path, db_path, self.transport)
        pool.catalog(refresh=True)
        snapshot = load_snapshot(config_path, db_path)
        self.assertEqual([row["host"] for row in snapshot["hosts"]][:4], ["ora1", "ora3", "ora5", "ora7"])
        self.assertTrue(next(row for row in snapshot["hosts"] if row["host"] == "ora7")["configured"])

    def test_removed_host_history_remains_visible_and_is_marked_unconfigured(self):
        self._insert_task("removed-host-task", "complete", "ora3", model="gpt-oss:20b", eval_tokens=5)
        only_ora1 = [{"id": "ora1", "ip": "100.65.151.42", "ssh_host": "shh-ora1.ziopsyop.tech",
                      "enabled": True, "allowedModels": list(APPROVED_MODELS)}]
        self._write_v2(self.config_path, only_ora1)
        snapshot = load_snapshot(self.config_path, self.db_path)
        historical = next(row for row in snapshot["hosts"] if row["host"] == "ora3")
        self.assertFalse(historical["configured"])
        self.assertEqual(historical["assignedTasks"], 1)
        task = next(row for row in snapshot["tasks"]["items"] if row["model"] == "gpt-oss:20b")
        self.assertEqual(task["assignedHost"], "ora3")
        self.assertIn("ora3", {row["host"] for row in snapshot["summary"]["assignmentDistribution"]})

    def test_task_and_event_pages_are_bounded_and_paged(self):
        for index in range(3):
            task = self.pool.submit(f"prompt {index}", job_id=f"page:{index}")
            with self.pool._connect() as db:
                self.pool._event(db, task["id"], "queued", {"status": "queued", "model": DEFAULT_MODEL,
                                "host": None, "source": "owner-private"}, time.time())
        page = load_snapshot(self.config_path, self.db_path, limit=1, offset=1, after_event=0)
        self.assertEqual(page["tasks"]["limit"], 1)
        self.assertEqual(page["tasks"]["offset"], 1)
        self.assertEqual(page["tasks"]["total"], 3)
        self.assertTrue(page["tasks"]["hasMore"])
        self.assertEqual(page["tasks"]["nextOffset"], 2)
        self.assertEqual(len(page["events"]["items"]), 1)
        self.assertTrue(page["events"]["hasMore"])
        self.assertNotIn("owner-private", json.dumps(page))
        with self.assertRaisesRegex(ValueError, "invalid_limit"):
            load_snapshot(self.config_path, self.db_path, limit=51)
        with self.assertRaisesRegex(ValueError, "invalid_offset"):
            load_snapshot(self.config_path, self.db_path, offset=10_001)


if __name__ == "__main__":
    unittest.main()
