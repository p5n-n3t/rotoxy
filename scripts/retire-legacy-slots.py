#!/usr/bin/env python3
"""Preview or release exact, retired provider task slots from a private SQLite ledger.

Apply is journaled by a full SQLite backup and requires the digest from the
current preview. Only exact manifest rows that are still blocked, dispatched,
unreleased legacy workspace tasks can be changed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import time
from pathlib import Path
from typing import Any


MAX_ITEMS = 50
SAFE_RECORD_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SAFE_ACCOUNT_ID = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$")
LEGACY_MODES = {"existing-session", "fresh"}


def private_file(path: Path, label: str) -> os.stat_result:
    if not path.is_absolute():
        raise ValueError(f"{label} path must be absolute")
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError(f"{label} must be a regular owner-private file (mode 0600 or stricter)")
    return info


def load_manifest(path: Path) -> list[dict[str, Any]]:
    private_file(path, "manifest")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_ITEMS:
        raise ValueError(f"manifest must contain 1..{MAX_ITEMS} exact task records")
    normalized = []
    seen = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {"jobId", "taskId", "accountId", "generation"}:
            raise ValueError("each manifest item must contain exactly jobId, taskId, accountId, generation")
        if any(not isinstance(item[key], str) or not SAFE_RECORD_ID.fullmatch(item[key]) for key in ("jobId", "taskId")):
            raise ValueError("jobId and taskId must be safe exact record IDs")
        if not isinstance(item["accountId"], str) or not SAFE_ACCOUNT_ID.fullmatch(item["accountId"]):
            raise ValueError("accountId must be a safe exact account ID")
        if isinstance(item["generation"], bool) or not isinstance(item["generation"], int) or item["generation"] < 1:
            raise ValueError("generation must be a positive integer")
        key = (item["jobId"], item["taskId"])
        if key in seen:
            raise ValueError("manifest task IDs must be unique")
        seen.add(key)
        normalized.append({"jobId": item["jobId"], "taskId": item["taskId"],
                           "accountId": item["accountId"], "generation": item["generation"]})
    return normalized


def schema_ok(db: sqlite3.Connection) -> None:
    required = {
        "job_tasks": {"assignment", "task_id", "body", "state", "generation", "selected_account", "attempt_id", "released_at", "dispatch_at", "provider_status"},
        "attempts": {"id", "generation", "account", "released_at", "state"},
        "operations": {"assignment", "task_id", "generation", "state"},
        "job_events": {"assignment", "kind", "at", "data"},
    }
    for table, expected in required.items():
        columns = {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}
        if not expected <= columns:
            raise ValueError(f"unsupported ledger schema: {table}")


def inspect_one(db: sqlite3.Connection, item: dict[str, Any]) -> dict[str, Any]:
    row = db.execute("SELECT rowid, body, state, generation, selected_account, attempt_id, released_at, dispatch_at, provider_status FROM job_tasks WHERE assignment=? AND task_id=?",
                     (item["jobId"], item["taskId"])).fetchone()
    result = {**item, "status": "blocked", "reason": "no exact task row"}
    if row is None:
        return result
    task = dict(row)
    result["rowid"] = task["rowid"]
    result.update(taskState=task["state"], selectedAccount=task["selected_account"],
                  releasedAt=task["released_at"], dispatchAt=task["dispatch_at"],
                  attemptId=task["attempt_id"], originalProviderStatus=task["provider_status"])
    if task["state"] != "blocked": result["reason"] = "task is not blocked"; return result
    if task["released_at"] is not None: result["reason"] = "task slot already released"; return result
    if task["dispatch_at"] is None: result["reason"] = "task was not dispatched"; return result
    if task["generation"] != item["generation"]: result["reason"] = "generation mismatch"; return result
    if task["selected_account"] != item["accountId"]: result["reason"] = "account mismatch"; return result
    try:
        body = json.loads(task["body"])
    except (ValueError, TypeError):
        result["reason"] = "task body is not valid JSON"; return result
    execution = body.get("execution") if isinstance(body, dict) else None
    mode = execution.get("mode") if isinstance(execution, dict) else None
    if mode not in LEGACY_MODES:
        result["reason"] = "task execution mode is not retired legacy workspace"; return result
    active_op = db.execute("SELECT 1 FROM operations WHERE assignment=? AND task_id=? AND generation=? AND state IN ('queued','claimed') LIMIT 1",
                           (item["jobId"], item["taskId"], item["generation"])).fetchone()
    if active_op:
        result["reason"] = "task has a queued or claimed operation"; return result
    attempt = None
    if not isinstance(task["attempt_id"], str) or not task["attempt_id"]:
        result["reason"] = "dispatched task has no attempt binding"; return result
    attempt = db.execute("SELECT id, generation, account, state, released_at FROM attempts WHERE id=?", (task["attempt_id"],)).fetchone()
    if not attempt:
        result["reason"] = "matching attempt row is missing"; return result
    if attempt["generation"] != item["generation"] or attempt["account"] != item["accountId"]:
        result["reason"] = "attempt binding mismatch"; return result
    if attempt["released_at"] is not None:
        result["reason"] = "matching attempt slot already released"; return result
    result.update(status="eligible", reason=None, attemptPresent=True,
                  attemptState=attempt["state"], attemptReleasedAt=attempt["released_at"],
                  bodySha256=hashlib.sha256(task["body"].encode()).hexdigest())
    return result


def preview_digest(items: list[dict[str, Any]], rows: list[dict[str, Any]]) -> str:
    exact = [{key: row.get(key) for key in ("jobId", "taskId", "accountId", "generation", "status", "reason", "rowid", "taskState", "selectedAccount", "releasedAt", "dispatchAt", "attemptId", "attemptPresent", "attemptState", "attemptReleasedAt", "bodySha256", "originalProviderStatus")} for row in rows]
    encoded = json.dumps({"items": items, "rows": exact}, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def backup_database(db: sqlite3.Connection, backup_dir: Path, expected: str, rows: list[dict[str, Any]]) -> dict[str, str]:
    if not backup_dir.is_absolute():
        raise ValueError("backup directory path must be absolute")
    info = backup_dir.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("backup directory must be an existing owner-private directory (mode 0700 or stricter)")
    stamp = f"{int(time.time() * 1000)}-{expected[:12]}"
    backup_path = backup_dir / f"legacy-slots-{stamp}.sqlite3"
    manifest_path = backup_dir / f"legacy-slots-{stamp}.backup.json"
    if backup_path.exists() or manifest_path.exists():
        raise ValueError("backup path already exists")
    fd = os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    target = sqlite3.connect(backup_path)
    try:
        db.backup(target)
    finally:
        target.close()
    os.chmod(backup_path, 0o600)
    backup_fd = os.open(backup_path, os.O_RDONLY)
    try:
        os.fsync(backup_fd)
    finally:
        os.close(backup_fd)
    digest = hashlib.sha256(backup_path.read_bytes()).hexdigest()
    journal = {"createdAt": int(time.time() * 1000), "previewDigest": expected,
               "backupFile": backup_path.name, "backupSha256": digest,
               "rows": [{key: row.get(key) for key in ("jobId", "taskId", "accountId", "generation", "rowid", "attemptId")} for row in rows]}
    fd = os.open(manifest_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(journal, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    dir_fd = os.open(backup_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    return {"file": backup_path.name, "sha256": digest, "manifest": manifest_path.name}


def run(db_path: Path, items: list[dict[str, Any]], apply: bool, backup_dir: Path | None, expected: str | None) -> dict[str, Any]:
    private_file(db_path, "database")
    uri = db_path.resolve().as_uri() + "?mode=rw"
    db = sqlite3.connect(uri, uri=True, timeout=5, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        schema_ok(db)
        rows = [inspect_one(db, item) for item in items]
        digest = preview_digest(items, rows)
        result: dict[str, Any] = {"mode": "preview", "applySupported": True, "digest": digest, "rows": rows}
        if not apply:
            return result
        if expected != digest:
            raise ValueError("preview digest mismatch; rerun preview and review it before applying")
        if backup_dir is None:
            raise ValueError("--backup-dir is required for apply")
        if any(row["status"] != "eligible" for row in rows):
            raise ValueError("one or more exact manifest rows are ineligible")
        backup = backup_database(db, backup_dir, digest, rows)
        db.execute("BEGIN IMMEDIATE")
        refreshed = [inspect_one(db, item) for item in items]
        if preview_digest(items, refreshed) != digest or any(row["status"] != "eligible" for row in refreshed):
            db.execute("ROLLBACK")
            raise ValueError("ledger changed since preview; no task rows were modified")
        now = time.time()
        for row in refreshed:
            db.execute("UPDATE job_tasks SET released_at=?,provider_status='provider_retired' WHERE assignment=? AND task_id=? AND state='blocked' AND released_at IS NULL AND dispatch_at IS NOT NULL AND generation=? AND selected_account=?",
                       (now, row["jobId"], row["taskId"], row["generation"], row["accountId"]))
            if db.execute("SELECT changes()").fetchone()[0] != 1:
                raise ValueError("task row changed during apply")
            if row.get("attemptPresent"):
                db.execute("UPDATE attempts SET released_at=? WHERE id=? AND generation=? AND account=? AND released_at IS NULL",
                           (now, row["attemptId"], row["generation"], row["accountId"]))
                if db.execute("SELECT changes()").fetchone()[0] != 1:
                    raise ValueError("matching attempt changed during apply")
            db.execute("INSERT INTO job_events(assignment,kind,at,data) VALUES(?,?,?,?)",
                       (row["jobId"], "provider_retired", now,
                        json.dumps({"taskId": row["taskId"], "accountId": row["accountId"],
                                    "generation": row["generation"], "providerStatus": "provider_retired"}, sort_keys=True)))
        db.execute("COMMIT")
        result.update(mode="applied", backup=backup, appliedCount=len(refreshed))
        return result
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, metavar="PATH", help="absolute owner-private scheduler SQLite database")
    parser.add_argument("--manifest", required=True, metavar="PATH", help="owner-private JSON list of exact legacy task bindings")
    parser.add_argument("--apply", action="store_true", help="apply exact eligible releases after backup and digest verification")
    parser.add_argument("--backup-dir", metavar="PATH", help="existing owner-private directory for consistent SQLite backup and journal")
    parser.add_argument("--expected-digest", metavar="SHA256", help="digest returned by the immediately reviewed preview")
    args = parser.parse_args(argv)
    if args.apply and (not args.backup_dir or not args.expected_digest):
        parser.error("--apply requires --backup-dir and --expected-digest")
    if not args.apply and (args.backup_dir or args.expected_digest):
        parser.error("--backup-dir and --expected-digest are accepted only with --apply")
    try:
        result = run(Path(args.db), load_manifest(Path(args.manifest)), args.apply,
                     Path(args.backup_dir) if args.backup_dir else None, args.expected_digest)
    except (OSError, ValueError, sqlite3.Error, json.JSONDecodeError) as exc:
        print(f"legacy slot retirement blocked: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
