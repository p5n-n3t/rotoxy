import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "retire-legacy-slots.py"
SPEC = importlib.util.spec_from_file_location("retire_legacy_slots", SCRIPT)
retire = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(retire)


@contextmanager
def db_connection(path):
    db = sqlite3.connect(path)
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def create_db(path):
    with db_connection(path) as db:
        db.executescript("""
        CREATE TABLE assignments(id TEXT PRIMARY KEY, state TEXT, body TEXT);
        CREATE TABLE job_tasks(assignment TEXT,task_id TEXT,body TEXT,state TEXT,generation INTEGER,selected_account TEXT,attempt_id TEXT,released_at REAL,dispatch_at REAL,provider_status TEXT,reported_model TEXT,PRIMARY KEY(assignment,task_id));
        CREATE TABLE attempts(id TEXT PRIMARY KEY,generation INTEGER,account TEXT,released_at REAL,state TEXT,result TEXT,reported_model TEXT);
        CREATE TABLE operations(assignment TEXT,task_id TEXT,generation INTEGER,state TEXT);
        CREATE TABLE job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,assignment TEXT,kind TEXT,at REAL,data TEXT);
        CREATE TABLE job_results(assignment TEXT,task_id TEXT,generation INTEGER,text TEXT,reported_model TEXT);
        CREATE TABLE dependency_edges(assignment TEXT,task_id TEXT,depends_on TEXT);
        INSERT INTO assignments VALUES('legacy-job','held','{"state":"held"}');
        INSERT INTO job_tasks VALUES('legacy-job','task-a','{"execution":{"mode":"existing-session"}}','blocked',3,'ls-retired','attempt-a',NULL,10,NULL,'model-a');
        INSERT INTO attempts VALUES('attempt-a',3,'ls-retired',NULL,'ambiguous','receipt-a','model-a');
        INSERT INTO job_results VALUES('legacy-job','task-a',3,'kept result','model-a');
        INSERT INTO dependency_edges VALUES('legacy-job','task-a','prereq');
        INSERT INTO job_tasks VALUES('other-job','cloudflare-task','{"execution":{"mode":"existing-session"}}','blocked',4,'cf-account','attempt-cf',NULL,11,NULL,'cf-model');
        INSERT INTO attempts VALUES('attempt-cf',4,'cf-account',NULL,'ambiguous','cf-receipt','cf-model');
        INSERT INTO job_tasks VALUES('inference-job','task-i','{"execution":{"mode":"inference","provider":"oracle"}}','blocked',2,'ls-retired','attempt-i',NULL,12,NULL,'m');
        INSERT INTO attempts VALUES('attempt-i',2,'ls-retired',NULL,'ambiguous','inference-receipt','m');
        INSERT INTO job_tasks VALUES('active-job','task-q','{"execution":{"mode":"fresh"}}','blocked',1,'ls-retired','attempt-q',NULL,13,NULL,'m');
        INSERT INTO attempts VALUES('attempt-q',1,'ls-retired',NULL,'ambiguous','queued-receipt','m');
        INSERT INTO operations VALUES('active-job','task-q',1,'queued');
        """)
    os.chmod(path, 0o600)


class TestRetireLegacySlots(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        os.chmod(root, 0o700)
        self.db = root / "scheduler.sqlite3"
        create_db(self.db)
        self.manifest_path = root / "manifest.json"
        self.items = [{"jobId": "legacy-job", "taskId": "task-a", "accountId": "ls-retired", "generation": 3}]
        self.write_manifest(self.items)
        self.backup_dir = root / "backups"
        self.backup_dir.mkdir(mode=0o700)

    def write_manifest(self, items):
        self.manifest_path.write_text(json.dumps(items), encoding="utf-8")
        os.chmod(self.manifest_path, 0o600)

    def snapshot(self):
        with db_connection(self.db) as db:
            return {
                "target": db.execute("SELECT state,generation,selected_account,released_at,provider_status,reported_model FROM job_tasks WHERE assignment='legacy-job'").fetchone(),
                "attempt": db.execute("SELECT released_at,state,result,reported_model FROM attempts WHERE id='attempt-a'").fetchone(),
                "cf": db.execute("SELECT released_at,provider_status FROM job_tasks WHERE assignment='other-job'").fetchone(),
                "inference": db.execute("SELECT released_at FROM job_tasks WHERE assignment='inference-job'").fetchone(),
                "queued": db.execute("SELECT released_at FROM job_tasks WHERE assignment='active-job'").fetchone(),
                "result": db.execute("SELECT text,reported_model FROM job_results WHERE assignment='legacy-job'").fetchone(),
                "assignment": db.execute("SELECT state,body FROM assignments WHERE id='legacy-job'").fetchone(),
                "dependency": db.execute("SELECT depends_on FROM dependency_edges WHERE assignment='legacy-job'").fetchone(),
            }

    def test_preview_is_read_only_and_reports_exact_eligible_row(self):
        before = self.snapshot()
        result = retire.run(self.db, self.items, False, None, None)
        self.assertEqual(result["mode"], "preview")
        self.assertEqual(result["rows"][0]["status"], "eligible")
        self.assertEqual(result["rows"][0]["rowid"], 1)
        self.assertEqual(self.snapshot(), before)

    def test_apply_requires_review_digest_backup_and_preserves_other_state(self):
        preview = retire.run(self.db, self.items, False, None, None)
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            retire.run(self.db, self.items, True, self.backup_dir, "0" * 64)
        self.assertEqual(self.snapshot(), before)
        with self.assertRaisesRegex(ValueError, "backup-dir is required"):
            retire.run(self.db, self.items, True, None, preview["digest"])
        self.assertEqual(self.snapshot(), before)

        applied = retire.run(self.db, self.items, True, self.backup_dir, preview["digest"])
        self.assertEqual(applied["mode"], "applied")
        self.assertEqual(applied["appliedCount"], 1)
        self.assertTrue((self.backup_dir / applied["backup"]["file"]).is_file())
        self.assertEqual((self.backup_dir / applied["backup"]["file"]).stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.backup_dir / applied["backup"]["manifest"]).stat().st_mode & 0o777, 0o600)
        import hashlib
        backup_bytes = (self.backup_dir / applied["backup"]["file"]).read_bytes()
        self.assertEqual(hashlib.sha256(backup_bytes).hexdigest(), applied["backup"]["sha256"])
        with db_connection(self.backup_dir / applied["backup"]["file"]) as backup:
            self.assertEqual(backup.execute("SELECT released_at FROM job_tasks WHERE assignment='legacy-job'").fetchone()[0], None)

        after = self.snapshot()
        self.assertEqual(after["target"][0:3], ("blocked", 3, "ls-retired"))
        self.assertIsNotNone(after["target"][3])
        self.assertEqual(after["target"][4:], ("provider_retired", "model-a"))
        self.assertEqual(after["attempt"], (after["target"][3], "ambiguous", "receipt-a", "model-a"))
        self.assertEqual(after["cf"], (None, None), "unlisted Cloudflare task remains untouched")
        self.assertEqual(after["inference"], (None,))
        self.assertEqual(after["queued"], (None,))
        self.assertEqual(after["result"], ("kept result", "model-a"))
        self.assertEqual(after["assignment"], before["assignment"])
        self.assertEqual(after["dependency"], before["dependency"])
        with db_connection(self.db) as db:
            event = db.execute("SELECT kind,data FROM job_events WHERE assignment='legacy-job'").fetchone()
        self.assertEqual(event[0], "provider_retired")
        self.assertEqual(json.loads(event[1]), {"taskId": "task-a", "accountId": "ls-retired", "generation": 3, "providerStatus": "provider_retired"})

        # Reusing the reviewed digest cannot repeat the release or duplicate its event.
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            retire.run(self.db, self.items, True, self.backup_dir, preview["digest"])
        with db_connection(self.db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM job_events WHERE assignment='legacy-job'").fetchone()[0], 1)

    def test_refuses_mismatched_inference_and_queued_rows(self):
        for job, task, account, generation in (
            ("inference-job", "task-i", "ls-retired", 2),
            ("active-job", "task-q", "ls-retired", 1),
            ("legacy-job", "task-a", "wrong-account", 3),
            ("legacy-job", "task-a", "ls-retired", 99),
        ):
            item = {"jobId": job, "taskId": task, "accountId": account, "generation": generation}
            result = retire.run(self.db, [item], False, None, None)
            self.assertEqual(result["rows"][0]["status"], "blocked")
            with self.assertRaises(ValueError):
                retire.run(self.db, [item], True, self.backup_dir, result["digest"])

    def test_requires_owner_private_inputs_and_unique_bounded_manifest(self):
        self.manifest_path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "owner-private"):
            retire.load_manifest(self.manifest_path)
        self.manifest_path.chmod(0o600)
        duplicate = self.items * 2
        self.write_manifest(duplicate)
        with self.assertRaisesRegex(ValueError, "unique"):
            retire.load_manifest(self.manifest_path)

        account_prefixes = [
            {"jobId": "job-a", "taskId": "task-a", "accountId": "_generated", "generation": 1},
            {"jobId": "job-b", "taskId": "task-b", "accountId": "-generated", "generation": 1},
        ]
        self.write_manifest(account_prefixes)
        self.assertEqual(retire.load_manifest(self.manifest_path), account_prefixes)
        self.write_manifest([{**account_prefixes[0], "jobId": "_invalid-job"}])
        with self.assertRaisesRegex(ValueError, "record IDs"):
            retire.load_manifest(self.manifest_path)

    def test_revalidates_under_lock_after_backup(self):
        preview = retire.run(self.db, self.items, False, None, None)
        original = retire.backup_database

        def race_after_backup(db, backup_dir, digest, rows):
            result = original(db, backup_dir, digest, rows)
            with db_connection(self.db) as changed:
                changed.execute("UPDATE job_tasks SET provider_status='changed-after-preview' WHERE assignment='legacy-job'")
            return result

        retire.backup_database = race_after_backup
        try:
            with self.assertRaisesRegex(ValueError, "ledger changed since preview"):
                retire.run(self.db, self.items, True, self.backup_dir, preview["digest"])
        finally:
            retire.backup_database = original
        with db_connection(self.db) as db:
            task = db.execute("SELECT released_at,provider_status FROM job_tasks WHERE assignment='legacy-job'").fetchone()
            self.assertEqual(task, (None, "changed-after-preview"))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM job_events").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
