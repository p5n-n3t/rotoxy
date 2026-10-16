"""Local-admin, exact-operation grants for explicitly controlled small batches.

This module is not exposed through MCP. Approval and grant consumption share
the JobRegistry SQLite database and its write transaction.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import time
import uuid


def ensure_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS controlled_batch_approvals(
        id TEXT PRIMARY KEY, assignment TEXT NOT NULL, operation_ids TEXT NOT NULL,
        account_ids TEXT NOT NULL, binding_hash TEXT NOT NULL, max_launches INTEGER NOT NULL,
        expires_at REAL NOT NULL, acknowledged_unknown_cost INTEGER NOT NULL,
        created_at REAL NOT NULL, last_wall_clock REAL NOT NULL)""")
    db.execute("CREATE INDEX IF NOT EXISTS controlled_batch_assignment ON controlled_batch_approvals(assignment,created_at)")
    db.execute("""CREATE TABLE IF NOT EXISTS controlled_batch_consumptions(
        approval_id TEXT NOT NULL, operation_id TEXT NOT NULL, binding_hash TEXT NOT NULL,
        consumed_at REAL NOT NULL, PRIMARY KEY(approval_id,operation_id), UNIQUE(operation_id))""")


def _canonical_binding(db, assignment_id, operation_ids):
    rows = []
    for operation_id in sorted(operation_ids):
        op = db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
        if op is None or op["assignment"] != assignment_id or op["kind"] != "chat_session":
            raise ValueError("operation is not an exact chat_session in this assignment")
        task = db.execute("SELECT * FROM job_tasks WHERE assignment=? AND task_id=?", (assignment_id, op["task_id"])).fetchone()
        assignment = db.execute("SELECT project,idem,fingerprint,eligible,body FROM assignments WHERE id=?", (assignment_id,)).fetchone()
        if task is None or assignment is None or task["generation"] != op["generation"] or task["attempt_id"] != op["attempt_id"] or task["selected_account"] != op["account"]:
            raise ValueError("operation binding changed")
        rows.append({"operationId": op["id"], "assignmentId": op["assignment"], "projectId": assignment["project"],
                     "assignmentIdempotencyKey": assignment["idem"], "assignmentFingerprint": assignment["fingerprint"],
                     "eligibleAccountIds": json.loads(assignment["eligible"]), "assignmentBody": json.loads(assignment["body"]),
                     "taskId": op["task_id"], "attemptId": op["attempt_id"], "generation": op["generation"],
                     "accountId": op["account"], "kind": op["kind"], "input": json.loads(op["input"]),
                     "task": json.loads(task["body"])})
    encoded = json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(encoded.encode()).hexdigest(), rows


def consume_on_credit_denied(db, op, now, event_writer):
    """Called only after strict credit reserve raised CreditDenied, inside claim BEGIN IMMEDIATE."""
    ensure_schema(db)
    grants = db.execute("SELECT * FROM controlled_batch_approvals WHERE assignment=? ORDER BY created_at DESC", (op["assignment"],)).fetchall()
    for grant in grants:
        ids = json.loads(grant["operation_ids"])
        accounts = json.loads(grant["account_ids"])
        # Persist a high-water wall-clock. A backward clock never extends a grant.
        if now < grant["last_wall_clock"]:
            continue
        db.execute("UPDATE controlled_batch_approvals SET last_wall_clock=? WHERE id=?", (now, grant["id"]))
        if now >= grant["expires_at"] or not grant["acknowledged_unknown_cost"] or op["id"] not in ids or op["account"] not in accounts:
            continue
        consumed = db.execute("SELECT COUNT(*) FROM controlled_batch_consumptions WHERE approval_id=?", (grant["id"],)).fetchone()[0]
        if consumed >= grant["max_launches"]:
            continue
        try:
            current_hash, _ = _canonical_binding(db, grant["assignment"], ids)
        except (ValueError, TypeError, json.JSONDecodeError):
            continue
        if current_hash != grant["binding_hash"]:
            continue
        try:
            db.execute("INSERT INTO controlled_batch_consumptions(approval_id,operation_id,binding_hash,consumed_at) VALUES(?,?,?,?)",
                       (grant["id"], op["id"], current_hash, now))
        except sqlite3.IntegrityError:
            continue
        event_writer(db, op["assignment"], "controlled_batch_admitted",
                     {"operationId": op["id"], "taskId": op["task_id"], "accountId": op["account"], "generation": op["generation"]}, now)
        return True
    return False


def _private_db(path):
    p = Path(path)
    if not p.is_absolute() or p.is_symlink() or not p.exists() or not p.is_file():
        raise ValueError("jobs database must be an existing absolute regular file")
    st = p.stat()
    if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
        raise ValueError("jobs database must be owner-only and owned by this user")
    parent = p.parent
    if parent.is_symlink() or not parent.is_dir() or parent.stat().st_uid != os.getuid() or stat.S_IMODE(parent.stat().st_mode) & 0o077:
        raise ValueError("jobs database directory must be owner-only and owned by this user")
    return p


def approve(registry, assignment_id, operation_ids, account_ids, max_launches, ttl_seconds, acknowledged, now=None, expected_bindings=None):
    if not isinstance(assignment_id, str) or not assignment_id or len(assignment_id) > 128:
        raise ValueError("invalid assignment id")
    if len(set(operation_ids)) != len(operation_ids) or len(set(account_ids)) != len(account_ids):
        raise ValueError("duplicate operation or account IDs are not allowed")
    operation_ids = sorted(operation_ids)
    account_ids = sorted(account_ids)
    if not operation_ids or len(operation_ids) > 3 or not account_ids or any(not isinstance(x, str) or not x or len(x) > 128 for x in operation_ids + account_ids):
        raise ValueError("approval requires 1 to 3 exact operation IDs and account IDs")
    if type(max_launches) is not int or not 1 <= max_launches <= 3 or max_launches > len(operation_ids):
        raise ValueError("max launches must be 1..3 and no greater than operation count")
    if type(ttl_seconds) is not int or not 30 <= ttl_seconds <= 600 or acknowledged is not True:
        raise ValueError("approval requires 30..600 seconds and unknown-cost acknowledgement")
    when = time.time() if now is None else now
    with registry.connection(write=True) as db:
        ensure_schema(db)
        assignment = db.execute("SELECT * FROM assignments WHERE id=?", (assignment_id,)).fetchone()
        if not assignment or not assignment["approved"] or assignment["state"] not in {"queued", "held"}:
            raise ValueError("assignment must be already approved and queued or held")
        rows = []
        for op_id in operation_ids:
            op = db.execute("SELECT * FROM operations WHERE id=?", (op_id,)).fetchone()
            if op is None or op["assignment"] != assignment_id or op["kind"] != "chat_session":
                raise ValueError("operation is not an exact chat_session in this assignment")
            task = db.execute("SELECT * FROM job_tasks WHERE assignment=? AND task_id=?", (assignment_id, op["task_id"])).fetchone()
            if task is None or task["generation"] != op["generation"] or task["attempt_id"] != op["attempt_id"] or task["selected_account"] != op["account"]:
                raise ValueError("operation binding changed")
            if (op["state"] == "queued" and op["worker"] is None and op["lease_until"] is None
                    and task["state"] == "reserved"):
                pass
            elif (op["state"] == "rejected" and op["error_class"] == "CreditAdmissionDenied" and op["worker"] is None and op["lease_until"] is None
                  and task["state"] == "blocked" and task["released_at"] is not None and assignment["state"] == "held"):
                project_control = db.execute("SELECT paused FROM project_controls WHERE project=?", (assignment["project"],)).fetchone()
                if not project_control or not project_control["paused"]:
                    raise ValueError("pause the project before requeuing a known credit-denied operation")
                if registry.repository is not None:
                    attempt = db.execute("SELECT state,released_at FROM attempts WHERE id=?", (op["attempt_id"],)).fetchone()
                    if not attempt or attempt["state"] != "blocked" or attempt["released_at"] is None:
                        raise ValueError("credit-denied attempt is not a safe pre-dispatch requeue")
            else:
                raise ValueError("operation state is not safely grantable")
            rows.append(op)
        actual_accounts = sorted({op["account"] for op in rows})
        if actual_accounts != account_ids:
            raise ValueError("account IDs must exactly match the selected accounts of these operations")
        if expected_bindings is not None:
            if type(expected_bindings) is not dict or set(expected_bindings) != set(operation_ids):
                raise ValueError("operation binding changed")
            for operation_id in operation_ids:
                observed_hash, _ = _canonical_binding(db, assignment_id, [operation_id])
                if observed_hash != expected_bindings[operation_id]:
                    raise ValueError("operation binding changed")
        binding_hash, _ = _canonical_binding(db, assignment_id, operation_ids)
        denied = [op for op in rows if op["state"] == "rejected"]
        if denied:
            # Only reset the exact never-claimed, known CreditAdmissionDenied rows.
            for op in denied:
                db.execute("UPDATE operations SET state='queued',error_class=NULL WHERE id=? AND state='rejected' AND error_class='CreditAdmissionDenied' AND worker IS NULL", (op["id"],))
                db.execute("UPDATE job_tasks SET state='reserved',released_at=NULL WHERE assignment=? AND task_id=? AND generation=? AND attempt_id=? AND state='blocked'",
                           (assignment_id, op["task_id"], op["generation"], op["attempt_id"]))
                if registry.repository is not None:
                    restored = db.execute("UPDATE attempts SET state='reserved',released_at=NULL WHERE id=? AND state='blocked' AND released_at IS NOT NULL", (op["attempt_id"],)).rowcount
                    if restored != 1:
                        raise ValueError("credit-denied attempt changed before safe requeue")
            db.execute("UPDATE assignments SET state='queued',revision=revision+1 WHERE id=? AND state='held'", (assignment_id,))
        grant_id = uuid.uuid4().hex
        db.execute("INSERT INTO controlled_batch_approvals(id,assignment,operation_ids,account_ids,binding_hash,max_launches,expires_at,acknowledged_unknown_cost,created_at,last_wall_clock) VALUES(?,?,?,?,?,?,?,?,?,?)",
                   (grant_id, assignment_id, json.dumps(operation_ids), json.dumps(account_ids), binding_hash, max_launches, when + ttl_seconds, 1, when, when))
        for op in rows:
            registry._event(db, assignment_id, "controlled_batch_approved",
                            {"operationId": op["id"], "taskId": op["task_id"], "accountId": op["account"], "generation": op["generation"]}, when)
    return {"approvalId": grant_id, "assignmentId": assignment_id, "operationIds": operation_ids, "accountIds": account_ids, "maxLaunches": max_launches, "expiresAt": when + ttl_seconds}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Approve exact queued chat operations for bounded unknown-credit-cost dispatch")
    parser.add_argument("--jobs-db", required=True)
    parser.add_argument("command", choices=["approve"])
    parser.add_argument("--assignment-id", required=True)
    parser.add_argument("--operation-ids", required=True)
    parser.add_argument("--accounts", required=True)
    parser.add_argument("--max-launches", type=int, required=True)
    parser.add_argument("--ttl-seconds", type=int, required=True)
    parser.add_argument("--ack-unknown-credit-cost", action="store_true")
    args = parser.parse_args(argv)
    try:
        path = _private_db(args.jobs_db)
        from .jobs import JobRegistry
        registry = JobRegistry(path)
        result = approve(registry, args.assignment_id, args.operation_ids.split(","), args.accounts.split(","), args.max_launches, args.ttl_seconds, args.ack_unknown_credit_cost)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except (ValueError, RuntimeError, OSError, sqlite3.Error) as exc:
        print(json.dumps({"error": str(exc)[:200]}, separators=(",", ":")), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
