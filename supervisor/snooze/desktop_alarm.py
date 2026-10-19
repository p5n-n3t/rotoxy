"""Bounded desktop delivery for durable recovery notifications.

This is a human-facing alarm only. A successful notify-send invocation means
the desktop accepted a notification request; it does not mean an agent was
awakened or that a person saw the notification.
"""
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import time
from typing import Any
from urllib.parse import quote


MAX_EVENTS_PER_PASS = 100
NOTIFY_SEND = "/usr/bin/notify-send"
EVENT_TEXT = {
    "failed": "A supervised worker failed and needs attention.",
    "stalled": "A supervised worker appears stalled and needs attention.",
    "ambiguous": "A worker action has an uncertain delivery outcome and needs review.",
    "needs_instructions": "A supervised worker is waiting for instructions.",
    "needs_approval": "A supervised worker needs approval.",
    "ownership_unknown": "A worker identity could not be verified.",
    "quota_blocked": "A worker account reached a quota limit.",
    "timed_out": "A supervised worker exceeded its time limit.",
    "completed": "A supervised worker completed its task.",
    "cancelled": "A supervised worker was cancelled.",
    "idle": "A supervised worker is idle and may need attention.",
    "instruction": "A supervised worker is waiting for instructions.",
    "approval": "A supervised worker needs approval.",
    "blocked": "A supervised task is blocked and needs attention.",
    "quota_exhausted": "A worker account reached a quota limit.",
    "credential_expired": "A worker connection needs reauthorization.",
    "workspace_inaccessible": "A worker workspace is inaccessible.",
    "repository_conflict": "A worker encountered a repository conflict.",
    "review_requested": "A worker has requested a review.",
    "artifact_ready": "A worker has produced an artifact for review.",
    "job_ready": "A supervised job is ready for integration.",
    "human_handoff": "A supervised event needs human attention.",
}
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}\Z")
BUS_ADDRESS = re.compile(r"unix:path=/run/user/(?P<uid>[0-9]+)/bus(?:,guid=[A-Fa-f0-9-]{8,64})?\Z")


class AlarmError(RuntimeError):
    pass


@dataclass(frozen=True)
class AlarmResult:
    scanned: int
    submitted: int
    failed: int
    ambiguous: int


def _private_db_path(path: Path, *, create_parent: bool = False) -> None:
    if not path.is_absolute() or "\x00" in str(path):
        raise AlarmError("database_path_invalid")
    if create_parent:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        parent = path.parent.lstat()
    except OSError as exc:
        raise AlarmError("database_directory_unavailable") from exc
    if (not stat.S_ISDIR(parent.st_mode) or stat.S_ISLNK(parent.st_mode) or
            parent.st_mode & 0o077 or (hasattr(os, "getuid") and parent.st_uid != os.getuid())):
        raise AlarmError("database_directory_permissions_invalid")
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    except OSError as exc:
        raise AlarmError("database_unavailable") from exc
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or
            info.st_mode & 0o077 or (hasattr(os, "getuid") and info.st_uid != os.getuid())):
        raise AlarmError("database_permissions_invalid")


def _readonly_connection(path: Path) -> sqlite3.Connection:
    _private_db_path(path)
    uri = "file:" + quote(str(path), safe="/") + "?mode=ro"
    try:
        db = sqlite3.connect(uri, uri=True, timeout=1)
        db.row_factory = sqlite3.Row
        return db
    except sqlite3.Error as exc:
        raise AlarmError("source_database_unavailable") from exc


def _notification_environment(source: dict[str, str], *, uid: int | None = None) -> dict[str, str]:
    """Return a small environment only when it points at this user's local bus."""
    if uid is None:
        uid = os.getuid()
    expected = Path(f"/run/user/{uid}")
    supplied_dir = source.get("XDG_RUNTIME_DIR")
    address = source.get("DBUS_SESSION_BUS_ADDRESS")
    try:
        info = expected.lstat()
    except OSError as exc:
        raise AlarmError("desktop_runtime_directory_unavailable") from exc
    if (not expected.is_absolute() or supplied_dir != str(expected) or
            not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or
            info.st_uid != uid or info.st_mode & 0o077):
        raise AlarmError("desktop_runtime_directory_invalid")
    match = BUS_ADDRESS.fullmatch(address or "")
    if not match or int(match.group("uid")) != uid:
        raise AlarmError("desktop_bus_address_invalid")
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
            "XDG_RUNTIME_DIR": str(expected), "DBUS_SESSION_BUS_ADDRESS": address}


class DesktopAlarm:
    """Send durable recovery notifications to the logged-in desktop once."""

    def __init__(self, source_db: Path, receipts_db: Path, *,
                 executable: str = NOTIFY_SEND, clock=time.time):
        self.source_db = Path(source_db)
        self.receipts_db = Path(receipts_db)
        self.executable = executable
        self.clock = clock
        if executable != NOTIFY_SEND and not executable.startswith("/"):
            raise AlarmError("notification_executable_must_be_absolute")
        _private_db_path(self.source_db)
        _private_db_path(self.receipts_db, create_parent=True)
        self._initialize()

    def _receipts(self) -> sqlite3.Connection:
        _private_db_path(self.receipts_db)
        try:
            db = sqlite3.connect(self.receipts_db, timeout=2, isolation_level=None)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA busy_timeout=2000")
            return db
        except sqlite3.Error as exc:
            raise AlarmError("receipt_database_unavailable") from exc

    def _initialize(self) -> None:
        old = os.umask(0o077)
        try:
            source = _readonly_connection(self.source_db)
            try:
                source_table = source.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recovery_service_notifications'").fetchone()
                if not source_table:
                    raise AlarmError("notification_source_schema_unavailable")
                initial_rowid = int(source.execute("SELECT COALESCE(MAX(rowid),0) FROM recovery_service_notifications").fetchone()[0])
            finally:
                source.close()
            db = self._receipts()
            try:
                db.execute("""CREATE TABLE IF NOT EXISTS desktop_alarm_receipts(
                    event_id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('dispatching','submitted','failed')),
                    created REAL NOT NULL,
                    updated REAL NOT NULL,
                    detail TEXT NOT NULL DEFAULT ''
                )""")
                db.execute("CREATE TABLE IF NOT EXISTS desktop_alarm_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL)")
                # On first install, baseline existing history so a timer does
                # not page through old incidents. New rows use larger rowids.
                db.execute("INSERT OR IGNORE INTO desktop_alarm_meta(key,value) VALUES('source_rowid',?)", (initial_rowid,))
            finally:
                db.close()
            os.chmod(self.receipts_db, 0o600)
        except sqlite3.Error as exc:
            raise AlarmError("receipt_schema_unavailable") from exc
        finally:
            os.umask(old)

    def _events(self, limit: int) -> list[dict[str, Any]]:
        db = _readonly_connection(self.source_db)
        try:
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recovery_service_notifications'").fetchone()
            if not exists:
                raise AlarmError("notification_source_schema_unavailable")
            receipt_db = self._receipts()
            try:
                cursor_row = receipt_db.execute("SELECT value FROM desktop_alarm_meta WHERE key='source_rowid'").fetchone()
                cursor = int(cursor_row["value"]) if cursor_row else 0
            finally:
                receipt_db.close()
            rows = db.execute("""SELECT rowid AS source_rowid,recovery_event_id,kind FROM recovery_service_notifications
                                WHERE rowid>? ORDER BY rowid ASC LIMIT ?""", (cursor, limit)).fetchall()
            return [{"source_rowid": row["source_rowid"], "event_id": row["recovery_event_id"], "kind": row["kind"]} for row in rows]
        except sqlite3.Error as exc:
            raise AlarmError("notification_source_read_failed") from exc
        finally:
            db.close()

    def _claim_batch(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        now = self.clock()
        db = self._receipts()
        try:
            db.execute("BEGIN IMMEDIATE")
            claimed = []
            last_rowid = None
            for event in events:
                last_rowid = event["source_rowid"]
                event_id, kind = event["event_id"], event["kind"]
                if not isinstance(event_id, str) or not SAFE_ID.fullmatch(event_id):
                    continue
                if not isinstance(kind, str) or kind not in EVENT_TEXT:
                    continue
                cur = db.execute("INSERT OR IGNORE INTO desktop_alarm_receipts(event_id,kind,state,created,updated,detail) VALUES(?,?,'dispatching',?,?,?)",
                                 (event_id, kind, now, now, "delivery outcome pending"))
                if cur.rowcount == 1:
                    claimed.append(event)
            if last_rowid is not None:
                db.execute("UPDATE desktop_alarm_meta SET value=MAX(value,?) WHERE key='source_rowid'", (last_rowid,))
            db.execute("COMMIT")
            return claimed
        except sqlite3.Error as exc:
            try:
                db.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise AlarmError("receipt_claim_failed") from exc
        finally:
            db.close()

    def _finish_batch(self, events: list[dict[str, Any]], state: str, detail: str) -> None:
        db = self._receipts()
        try:
            db.execute("BEGIN IMMEDIATE")
            db.executemany("UPDATE desktop_alarm_receipts SET state=?,updated=?,detail=? WHERE event_id=? AND state='dispatching'",
                           [(state, self.clock(), detail[:160], event["event_id"]) for event in events])
            db.execute("COMMIT")
        except sqlite3.Error as exc:
            # dispatching remains a visible ambiguous outcome and will never
            # be automatically re-sent after a crash or receipt-write failure.
            raise AlarmError("receipt_update_failed") from exc
        finally:
            db.close()

    def run_once(self, *, limit: int = MAX_EVENTS_PER_PASS) -> AlarmResult:
        if type(limit) is not int or not 1 <= limit <= MAX_EVENTS_PER_PASS:
            raise AlarmError("event_limit_invalid")
        events = self._events(limit)
        claimed = self._claim_batch(events)
        if not claimed:
            return AlarmResult(len(events), 0, 0, 0)
        count = len(claimed)
        kinds = Counter(event["kind"] for event in claimed)
        urgent = set(kinds) - {"idle", "completed", "cancelled", "artifact_ready", "job_ready"}
        summary = "; ".join(f"{number} {kind.replace('_', ' ')}" for kind, number in sorted(kinds.items()))
        body = (f"{count} new worker event{'s' if count != 1 else ''}: {summary}. "
                "Review details in ROTOXY → Supervisor. Counts are events, not unique workers.")
        try:
            env = _notification_environment(dict(os.environ))
            result = subprocess.run(
                [self.executable, "--app-name=ROTOXY", "--urgency=" + ("critical" if urgent else "normal"),
                 "ROTOXY worker alert" if urgent else "ROTOXY worker update", body],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=5, check=False,
                shell=False, close_fds=True,
                env=env,
            )
        except AlarmError:
            self._finish_batch(claimed, "failed", "desktop notification session is unavailable or invalid")
            return AlarmResult(len(events), 0, count, 0)
        except subprocess.TimeoutExpired:
            self._finish_batch(claimed, "failed", "notification command timed out; delivery may be ambiguous")
            return AlarmResult(len(events), 0, 0, count)
        except OSError:
            self._finish_batch(claimed, "failed", "notification command unavailable")
            return AlarmResult(len(events), 0, count, 0)
        if result.returncode == 0:
            self._finish_batch(claimed, "submitted", "desktop notification request accepted")
            return AlarmResult(len(events), count, 0, 0)
        self._finish_batch(claimed, "failed", "desktop notification command rejected request")
        return AlarmResult(len(events), 0, count, 0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Deliver one bounded pass of durable recovery alerts to the local desktop")
    parser.add_argument("--source-db", type=Path, required=True, help="private Snooze recovery service database")
    parser.add_argument("--receipts-db", type=Path, required=True, help="private desktop alarm receipt database")
    parser.add_argument("--limit", type=int, default=MAX_EVENTS_PER_PASS)
    args = parser.parse_args(argv)
    try:
        result = DesktopAlarm(args.source_db, args.receipts_db).run_once(limit=args.limit)
    except AlarmError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(f"scanned={result.scanned} submitted={result.submitted} failed={result.failed} ambiguous={result.ambiguous}")
    return 0 if result.failed == 0 and result.ambiguous == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
