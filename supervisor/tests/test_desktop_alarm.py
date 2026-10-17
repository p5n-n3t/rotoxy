from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

from snooze.desktop_alarm import AlarmError, DesktopAlarm, NOTIFY_SEND


class DesktopAlarmTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "recovery.sqlite3"
        self.receipts = self.root / "alarms.sqlite3"
        with sqlite3.connect(self.source) as db:
            db.execute("""CREATE TABLE recovery_service_notifications(
                recovery_event_id TEXT PRIMARY KEY,project TEXT NOT NULL,owner TEXT NOT NULL,
                job TEXT NOT NULL,kind TEXT NOT NULL,created REAL NOT NULL)""")
        os.chmod(self.source, 0o600)
        self.calls = self.root / "calls.jsonl"
        self.executable = self.root / "notify-send"
        self.exit_code = 0
        self.executable.write_text(
            "#!/usr/bin/env python3\n"
            "import json,sys\n"
            f"with open({str(self.calls)!r},'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n"
            f"raise SystemExit({self.exit_code})\n"
        )
        self.executable.chmod(0o700)

    def add_event(self, event_id="event-1", kind="failed", project="secret-project", owner="secret-owner", job="private-job"):
        with sqlite3.connect(self.source) as db:
            db.execute("INSERT INTO recovery_service_notifications VALUES(?,?,?,?,?,?)",
                       (event_id, project, owner, job, kind, 100.0))

    def alarm(self, **kwargs):
        alarm = DesktopAlarm(self.source, self.receipts, executable=self.executable.as_posix(), **kwargs)
        alarm.executable = self.executable.as_posix()
        return alarm

    def _run(self, alarm):
        return alarm.run_once()

    def test_submission_is_sanitized_deduplicated_after_restart(self):
        self.add_event()
        result = self._run(self.alarm())
        self.assertEqual((result.submitted, result.failed, result.ambiguous), (1, 0, 0))
        first_call = json.loads(self.calls.read_text().splitlines()[0])
        self.assertEqual(first_call[-2:], ["ROTOXY worker alert", "A supervised worker failed and needs attention."])
        self.assertNotIn("secret-project", " ".join(first_call))
        self.assertNotIn("private-job", " ".join(first_call))
        restarted = self._run(self.alarm())
        self.assertEqual((restarted.submitted, restarted.failed, restarted.ambiguous), (0, 0, 0))
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        with sqlite3.connect(self.receipts) as db:
            state = db.execute("SELECT state FROM desktop_alarm_receipts WHERE event_id='event-1'").fetchone()[0]
        self.assertEqual(state, "submitted")

    def test_pre_send_capture_is_never_replayed_after_restart(self):
        self.add_event()
        self.alarm()
        with sqlite3.connect(self.receipts) as db:
            db.execute("INSERT INTO desktop_alarm_receipts(event_id,kind,state,created,updated,detail) VALUES(?,?,?,?,?,?)",
                       ("event-1", "failed", "dispatching", 1, 1, "delivery outcome pending"))
        result = self._run(self.alarm())
        self.assertEqual(result.submitted, 0)
        self.assertFalse(self.calls.exists())
        with sqlite3.connect(self.receipts) as db:
            state = db.execute("SELECT state FROM desktop_alarm_receipts WHERE event_id='event-1'").fetchone()[0]
        self.assertEqual(state, "dispatching")

    def test_nonzero_command_result_stays_visible_and_is_not_retried(self):
        self.add_event(kind="approval")
        self.exit_code = 1
        # Regenerate the test-only fake executable with the requested outcome.
        self.executable.write_text(
            "#!/usr/bin/env python3\nimport json,sys\n"
            f"with open({str(self.calls)!r},'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n"
            f"raise SystemExit({self.exit_code})\n"
        )
        result = self._run(self.alarm())
        self.assertEqual(result.failed, 1)
        again = self._run(self.alarm())
        self.assertEqual(again.failed, 0)
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        with sqlite3.connect(self.receipts) as db:
            row = db.execute("SELECT state,detail FROM desktop_alarm_receipts WHERE event_id='event-1'").fetchone()
        self.assertEqual(row[0], "failed")
        self.assertIn("rejected", row[1])

    def test_unknown_kind_and_malformed_event_id_are_not_sent(self):
        self.add_event(event_id="bad\nvalue", kind="failed")
        self.add_event(event_id="event-2", kind="unknown")
        result = self._run(self.alarm())
        self.assertEqual(result.scanned, 2)
        self.assertEqual(result.submitted, 0)
        self.assertFalse(self.calls.exists())

    def test_fixed_notification_executable_and_permission_checks(self):
        self.assertEqual(NOTIFY_SEND, "/usr/bin/notify-send")
        unsafe = self.root / "unsafe.sqlite3"
        unsafe.write_bytes(b"x")
        unsafe.chmod(0o644)
        with self.assertRaises(AlarmError):
            DesktopAlarm(unsafe, self.root / "receipt2.sqlite3")


if __name__ == "__main__":
    unittest.main()
