from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from snooze.desktop_alarm import AlarmError, DesktopAlarm, NOTIFY_SEND, _notification_environment


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
        db = sqlite3.connect(self.source)
        try:
            db.execute("INSERT INTO recovery_service_notifications VALUES(?,?,?,?,?,?)",
                       (event_id, project, owner, job, kind, 100.0))
            db.commit()
        finally:
            db.close()

    def alarm(self, **kwargs):
        alarm = DesktopAlarm(self.source, self.receipts, executable=self.executable.as_posix(), **kwargs)
        alarm.executable = self.executable.as_posix()
        return alarm

    def _run(self, alarm):
        safe_env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                    "XDG_RUNTIME_DIR": "/run/user/1000",
                    "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus"}
        with patch("snooze.desktop_alarm._notification_environment", return_value=safe_env):
            return alarm.run_once()

    def test_submission_is_sanitized_deduplicated_after_restart(self):
        alarm = self.alarm()
        self.add_event()
        result = self._run(alarm)
        self.assertEqual((result.submitted, result.failed, result.ambiguous), (1, 0, 0))
        first_call = json.loads(self.calls.read_text().splitlines()[0])
        self.assertEqual(first_call[-2:], ["ROTOXY worker alert", "1 new worker event: 1 failed. Review details in ROTOXY → Supervisor. Counts are events, not unique workers."])
        self.assertIn("--urgency=critical", first_call)
        self.assertNotIn("secret-project", " ".join(first_call))
        self.assertNotIn("private-job", " ".join(first_call))
        restarted = self._run(self.alarm())
        self.assertEqual((restarted.submitted, restarted.failed, restarted.ambiguous), (0, 0, 0))
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        with sqlite3.connect(self.receipts) as db:
            state = db.execute("SELECT state FROM desktop_alarm_receipts WHERE event_id='event-1'").fetchone()[0]
        self.assertEqual(state, "submitted")

    def test_pre_send_capture_is_never_replayed_after_restart(self):
        self.alarm()
        self.add_event()
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
        self.alarm()
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
        alarm = self.alarm()
        self.add_event(event_id="bad\nvalue", kind="failed")
        self.add_event(event_id="event-2", kind="unknown")
        result = self._run(alarm)
        self.assertEqual(result.scanned, 2)
        self.assertEqual(result.submitted, 0)
        self.assertFalse(self.calls.exists())

    def test_more_than_one_batch_is_not_starved(self):
        alarm = self.alarm()
        for index in range(101):
            self.add_event(event_id=f"event-{index + 1}", kind="idle")
        first = self._run(alarm)
        second = self._run(alarm)
        self.assertEqual((first.scanned, first.submitted), (100, 100))
        self.assertEqual((second.scanned, second.submitted), (1, 1))
        self.assertEqual(len(self.calls.read_text().splitlines()), 2)
        lines = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertTrue(all("--urgency=normal" in line for line in lines))
        self.assertTrue(all(line[-2] == "ROTOXY worker update" for line in lines))
        self.assertIn("100 new worker events: 100 idle.", lines[0][-1])
        self.assertIn("1 new worker event: 1 idle.", lines[1][-1])

    def test_mixed_batch_preserves_critical_failure_and_reports_each_kind(self):
        alarm = self.alarm()
        self.add_event("idle-1", "idle")
        self.add_event("failure-1", "failed")
        self.add_event("approval-1", "needs_approval")
        result = self._run(alarm)
        self.assertEqual(result.submitted, 3)
        call = json.loads(self.calls.read_text().splitlines()[0])
        self.assertIn("--urgency=critical", call)
        self.assertIn("1 failed; 1 idle; 1 needs approval", call[-1])

    def test_first_install_baselines_old_history_without_alert_storm(self):
        for index in range(2858):
            self.add_event(event_id=f"old-{index + 1}", kind="idle")
        alarm = self.alarm()
        initial = self._run(alarm)
        self.assertEqual((initial.scanned, initial.submitted), (0, 0))
        self.assertFalse(self.calls.exists())
        self.add_event(event_id="new-event", kind="failed")
        later = self._run(alarm)
        self.assertEqual((later.scanned, later.submitted), (1, 1))
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)

    def test_desktop_environment_accepts_only_current_users_private_local_bus(self):
        uid = os.getuid()
        runtime_dir = Path(f"/run/user/{uid}")
        if not runtime_dir.exists():
            self.skipTest("no per-user desktop runtime directory in this test environment")
        safe = {"XDG_RUNTIME_DIR": str(runtime_dir),
                "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{uid}/bus,guid=0123456789abcdef"}
        accepted = _notification_environment(safe, uid=uid)
        self.assertEqual(accepted["DBUS_SESSION_BUS_ADDRESS"], safe["DBUS_SESSION_BUS_ADDRESS"])
        self.assertNotIn("HOME", accepted)
        for bad in (
            {**safe, "DBUS_SESSION_BUS_ADDRESS": "tcp:host=remote,port=1234"},
            {**safe, "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/99999/bus"},
            {**safe, "XDG_RUNTIME_DIR": "/tmp/arbitrary"},
        ):
            with self.assertRaises(AlarmError):
                _notification_environment(bad, uid=uid)

    def test_existing_parent_permissions_are_validated_not_rewritten(self):
        directory = self.root / "shared"
        directory.mkdir(mode=0o700)
        directory.chmod(0o750)
        with self.assertRaises(AlarmError):
            DesktopAlarm(self.source, directory / "receipt.sqlite3")
        self.assertEqual(directory.stat().st_mode & 0o777, 0o750)

    def test_fixed_notification_executable_and_permission_checks(self):
        self.assertEqual(NOTIFY_SEND, "/usr/bin/notify-send")
        unsafe = self.root / "unsafe.sqlite3"
        unsafe.write_bytes(b"x")
        unsafe.chmod(0o644)
        with self.assertRaises(AlarmError):
            DesktopAlarm(unsafe, self.root / "receipt2.sqlite3")


if __name__ == "__main__":
    unittest.main()
