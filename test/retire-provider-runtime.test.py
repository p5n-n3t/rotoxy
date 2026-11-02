import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "retire-provider-runtime.py"


class RetirementPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / "runtime.sqlite3"
        with sqlite3.connect(self.db) as connection:
            connection.executescript("""
                CREATE TABLE registered_accounts(account_id TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE jobs(project TEXT, id TEXT, session TEXT, data TEXT);
                CREATE TABLE assignments(id TEXT PRIMARY KEY, provider TEXT, data TEXT);
                CREATE TABLE mixed_assignments(id TEXT PRIMARY KEY, data TEXT);
            """)
            connection.execute("INSERT INTO registered_accounts VALUES(?,?)", ("ls-account-001", json.dumps({"registeredSessions": [{"id": "session-exact-01"}]})))
            connection.execute("INSERT INTO registered_accounts VALUES(?,?)", ("not-ls-account-001-extra", "{}"))
            connection.execute("INSERT INTO jobs VALUES(?,?,?,?)", ("project", "job-ls", "session-exact-01", "{}"))
            connection.execute("INSERT INTO jobs VALUES(?,?,?,?)", ("project", "job-other", "session-exact-010", "{}"))
            connection.execute("INSERT INTO assignments VALUES(?,?,?)", ("mixed-job", "exa", "{\"accountId\":\"ls-account-001\"}"))
            connection.execute("INSERT INTO mixed_assignments VALUES(?,?)", ("mixed-sibling", "{\"provider\":\"lightsprint\",\"accountId\":\"ls-account-001\",\"sibling\":{\"provider\":\"cloudflare\",\"accountId\":\"cf-account-01\"}}"))
        self.db.chmod(0o600)
        self.json_store = self.root / "credit-snapshots.json"
        self.json_store.write_text(json.dumps({
            "version": 1,
            "snapshots": [
                {"provider": "lightsprint", "accountId": "ls-account-001", "remaining": 7},
                {"provider": "exa", "accountId": "exa-account-01", "remaining": 3},
                {"provider": "lightsprint", "accountId": "ls-account-001-copy", "remaining": 2},
            ],
            "sessionCosts": [{"provider": "lightsprint", "accountId": "ls-account-001", "sessionId": "session-exact-01", "totalUsd": 1}],
        }))
        self.json_store.chmod(0o600)

    def tearDown(self):
        self.temp.cleanup()

    def run_preview(self, *extra):
        return subprocess.run([
            sys.executable, str(SCRIPT), "--sqlite", str(self.db), "--json-store", str(self.json_store),
            "--lightsprint-account-id", "ls-account-001", "--lightsprint-session-id", "session-exact-01", "--json", *extra,
        ], capture_output=True, text=True)

    def test_exact_identifier_preview_preserves_substrings_and_mixed_provider_records(self):
        before_db, before_json = self.db.read_bytes(), self.json_store.read_bytes()
        result = self.run_preview()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertFalse(report["applySupported"])
        sqlite_store, json_store = report["stores"]
        self.assertEqual({row["table"] for row in sqlite_store["matches"]}, {"registered_accounts", "jobs"})
        self.assertIn("assignments[rowid=1]", sqlite_store["blocked"])
        self.assertIn("mixed_assignments[rowid=1]", sqlite_store["blocked"])
        self.assertEqual(json_store["matches"], {"$.snapshots[0]": 1, "$.sessionCosts[0]": 1})
        self.assertEqual(before_db, self.db.read_bytes())
        self.assertEqual(before_json, self.json_store.read_bytes())

    def test_apply_is_explicitly_unsupported_even_with_backup_dir(self):
        backup_dir = self.root / "backups"
        result = self.run_preview("--apply", "--backup-dir", str(backup_dir))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--apply is currently unsupported", result.stderr)
        self.assertFalse(backup_dir.exists())

    def test_unprivate_input_is_blocked_before_inspection(self):
        self.db.chmod(0o644)
        result = self.run_preview()
        self.assertEqual(result.returncode, 2)
        self.assertIn("owner-private", result.stderr)


if __name__ == "__main__":
    unittest.main()
