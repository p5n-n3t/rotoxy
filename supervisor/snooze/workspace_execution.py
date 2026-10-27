"""Private SQLite ledger for explicitly published Agent Workspace executions.

The Node gateway is the authorization boundary. This CLI stores intent before
provider submission and exposes only project-level summaries to snapshots.
It never calls a provider or returns stored task instructions/results.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
import time

from snooze.agent_workspace import AgentWorkspace, WorkspaceError

MAX_INPUT = 2_200_000  # Original and namespaced submissions share one private request.
MAX_OUTPUT = 2_000_000
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
STATES = {"pending", "accepted", "needs_reconciliation", "draft", "queued", "running", "held", "paused", "emergency_stopped", "complete", "completed", "blocked", "failed", "cancelled", "unknown"}


def _id(value, field):
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise WorkspaceError("invalid_" + field)
    return value


def _client_id(value):
    if not isinstance(value, str) or not CLIENT_ID_RE.fullmatch(value):
        raise WorkspaceError("invalid_client_id")
    return value


def _connect(path):
    # AgentWorkspace applies the same private-directory/file and symlink checks
    # used by the collaboration database, and creates its schema if needed.
    service = AgentWorkspace(path)
    db = sqlite3.connect(service.path, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=10000")
    db.execute("""CREATE TABLE IF NOT EXISTS workspace_executions(
        project_id TEXT NOT NULL, job_id TEXT NOT NULL, client_id TEXT NOT NULL,
        actor TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        submission_json TEXT NOT NULL, state TEXT NOT NULL, remote_state TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id,job_id), UNIQUE(project_id,idempotency_key))""")
    db.execute("CREATE INDEX IF NOT EXISTS workspace_executions_project ON workspace_executions(project_id,updated_at DESC)")
    db.execute("""CREATE TABLE IF NOT EXISTS workspace_execution_bindings(
        project_id TEXT NOT NULL, job_id TEXT NOT NULL, remote_job_id TEXT NOT NULL,
        client_id TEXT NOT NULL, actor TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        remote_idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        submission_json TEXT NOT NULL, remote_submission_json TEXT NOT NULL,
        state TEXT NOT NULL, remote_state TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        share_mode TEXT NOT NULL DEFAULT 'private', share_handle TEXT,
        PRIMARY KEY(project_id,client_id,job_id), UNIQUE(project_id,client_id,idempotency_key),
        UNIQUE(project_id,remote_job_id))""")
    db.execute("BEGIN IMMEDIATE")
    try:
        columns = {row["name"] for row in db.execute("PRAGMA table_info(workspace_execution_bindings)")}
        if "settled" not in columns:
            db.execute("ALTER TABLE workspace_execution_bindings ADD COLUMN settled INTEGER NOT NULL DEFAULT 0")
        if "last_polled_at" not in columns:
            db.execute("ALTER TABLE workspace_execution_bindings ADD COLUMN last_polled_at INTEGER")
        if "lease_until" not in columns:
            db.execute("ALTER TABLE workspace_execution_bindings ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0")
        if "share_mode" not in columns:
            db.execute("ALTER TABLE workspace_execution_bindings ADD COLUMN share_mode TEXT NOT NULL DEFAULT 'private'")
        if "share_handle" not in columns:
            db.execute("ALTER TABLE workspace_execution_bindings ADD COLUMN share_handle TEXT")
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    db.execute("CREATE INDEX IF NOT EXISTS workspace_execution_bindings_project ON workspace_execution_bindings(project_id,updated_at DESC)")
    db.execute("CREATE INDEX IF NOT EXISTS workspace_execution_reconciliation ON workspace_execution_bindings(settled,lease_until,last_polled_at,created_at)")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS workspace_execution_share_handle ON workspace_execution_bindings(share_handle) WHERE share_handle IS NOT NULL")
    db.execute("""CREATE TABLE IF NOT EXISTS workspace_execution_audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
        owner_client_id TEXT NOT NULL, actor_client_id TEXT NOT NULL, action TEXT NOT NULL,
        occurred_at INTEGER NOT NULL)""")
    db.execute("CREATE INDEX IF NOT EXISTS workspace_execution_audit_job ON workspace_execution_audit(project_id,job_id,id)")
    # Older checkpoint bindings remain read-only sync targets under their
    # original remote IDs. Never replay their already-reserved submissions.
    for row in db.execute("SELECT * FROM workspace_executions").fetchall():
        db.execute("""INSERT OR IGNORE INTO workspace_execution_bindings(
            project_id,job_id,remote_job_id,client_id,actor,idempotency_key,remote_idempotency_key,
            request_hash,submission_json,remote_submission_json,state,remote_state,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (row["project_id"],row["job_id"],row["job_id"],row["client_id"],row["actor"],row["idempotency_key"],row["idempotency_key"],row["request_hash"],row["submission_json"],row["submission_json"],row["state"],row["remote_state"],row["created_at"],row["updated_at"]))
    return db


def _summary(row):
    try:
        submission = json.loads(row["submission_json"])
    except (TypeError, ValueError):
        submission = {}
    remote = row["remote_state"]
    return {"projectId": row["project_id"], "jobId": row["job_id"], "state": remote or row["state"],
            "provider": "lightsprint", "taskCount": len(submission.get("tasks", [])),
            "createdAt": row["created_at"], "updatedAt": row["updated_at"], "shareMode": row["share_mode"]}


def _audit(db, project, job, owner, actor, action):
    db.execute("INSERT INTO workspace_execution_audit(project_id,job_id,owner_client_id,actor_client_id,action,occurred_at) VALUES(?,?,?,?,?,?)",
               (project, job, owner, actor, action, int(time.time() * 1000)))


def handle(path, request):
    if not isinstance(request, dict) or not isinstance(request.get("command"), str):
        raise WorkspaceError("invalid_request")
    command = request["command"]
    allowed = {
        "reserve": {"command", "projectId", "jobId", "remoteJobId", "clientId", "actor", "idempotencyKey", "remoteIdempotencyKey", "requestHash", "submission", "remoteSubmission", "shareMode", "shareHandle"},
        "set_state": {"command", "projectId", "jobId", "clientId", "actorClientId", "state"},
        "get": {"command", "projectId", "jobId", "clientId"},
        "get_shared": {"command", "projectId", "shareHandle", "actorClientId"},
        "list": {"command", "projectId"},
        "claim_reconciliation": {"command", "limit"},
        "settle_reconciliation": {"command", "projectId", "jobId", "clientId"},
    }
    legacy_reserve_fields = allowed["reserve"] - {"shareMode", "shareHandle"} if command == "reserve" else None
    if command not in allowed or set(request) not in (allowed[command], legacy_reserve_fields):
        raise WorkspaceError("invalid_request")
    project = None if command == "claim_reconciliation" else _id(request["projectId"], "project_id")
    db = _connect(path)
    try:
        if command == "reserve":
            job = _id(request["jobId"], "job_id")
            remote_job = _id(request["remoteJobId"], "remote_job_id")
            client = _client_id(request["clientId"])
            actor = "client:" + client
            if request["actor"] != actor or not isinstance(request["submission"], dict) or not isinstance(request["remoteSubmission"], dict):
                raise WorkspaceError("invalid_owner")
            key = _id(request["idempotencyKey"], "idempotency_key")
            remote_key = _id(request["remoteIdempotencyKey"], "remote_idempotency_key")
            digest = request["requestHash"]
            if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise WorkspaceError("invalid_request_hash")
            share_mode = request.get("shareMode", "private")
            share_handle = request.get("shareHandle")
            if share_mode not in ("private", "fleet") or (share_mode == "private" and share_handle is not None) or (share_mode == "fleet" and (not isinstance(share_handle, str) or not re.fullmatch(r"share_[A-Za-z0-9_-]{32}", share_handle))):
                raise WorkspaceError("invalid_sharing_mode")
            submission = json.dumps(request["submission"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            remote_submission = json.dumps(request["remoteSubmission"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            now = int(time.time() * 1000)
            db.execute("BEGIN IMMEDIATE")
            try:
                by_job = db.execute("SELECT * FROM workspace_execution_bindings WHERE project_id=? AND client_id=? AND job_id=?", (project, client, job)).fetchone()
                by_key = db.execute("SELECT * FROM workspace_execution_bindings WHERE project_id=? AND client_id=? AND idempotency_key=?", (project, client, key)).fetchone()
                existing = by_job or by_key
                if existing:
                    if existing["job_id"] != job or existing["idempotency_key"] != key or existing["request_hash"] != digest or existing["remote_job_id"] != remote_job or existing["share_mode"] != share_mode:
                        raise WorkspaceError("idempotency_conflict")
                    db.execute("COMMIT")
                    return {"created": False, "shouldSubmit": False, "dispatch": _summary(existing), **({"shareHandle": existing["share_handle"]} if share_mode == "fleet" else {})}
                db.execute("INSERT INTO workspace_execution_bindings(project_id,job_id,remote_job_id,client_id,actor,idempotency_key,remote_idempotency_key,request_hash,submission_json,remote_submission_json,state,created_at,updated_at,share_mode,share_handle) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)",
                           (project, job, remote_job, client, actor, key, remote_key, digest, submission, remote_submission, now, now, share_mode, share_handle))
                if share_mode == "fleet":
                    _audit(db, project, job, client, client, "share_created")
                db.execute("COMMIT")
                row = db.execute("SELECT * FROM workspace_execution_bindings WHERE project_id=? AND client_id=? AND job_id=?", (project, client, job)).fetchone()
                return {"created": True, "shouldSubmit": True, "dispatch": _summary(row), **({"shareHandle": row["share_handle"]} if share_mode == "fleet" else {})}
            except Exception:
                db.execute("ROLLBACK")
                raise
        if command == "set_state":
            job = _id(request["jobId"], "job_id")
            client = _client_id(request["clientId"])
            actor_client = _client_id(request["actorClientId"])
            state = request["state"]
            if state not in STATES:
                raise WorkspaceError("invalid_state")
            now = int(time.time() * 1000)
            db.execute("UPDATE workspace_execution_bindings SET state=?,remote_state=?,updated_at=? WHERE project_id=? AND job_id=? AND client_id=?",
                       ("accepted" if state == "accepted" else state, state, now, project, job, client))
            row = db.execute("SELECT * FROM workspace_execution_bindings WHERE project_id=? AND job_id=? AND client_id=?", (project, job, client)).fetchone()
            if row is None:
                raise WorkspaceError("execution_not_found")
            _audit(db, project, job, client, actor_client, "state_observed")
            return _summary(row)
        if command == "get":
            job = _id(request["jobId"], "job_id")
            client = _client_id(request["clientId"])
            row = db.execute("SELECT * FROM workspace_execution_bindings WHERE project_id=? AND job_id=? AND client_id=?", (project, job, client)).fetchone()
            if row is None:
                raise WorkspaceError("execution_not_found")
            _audit(db, project, job, client, client, "sync_owner")
            return {"dispatch": _summary(row), "submission": json.loads(row["submission_json"]), "remoteJobId": row["remote_job_id"], "actor": row["actor"]}
        if command == "get_shared":
            handle = request["shareHandle"]
            actor_client = _client_id(request["actorClientId"])
            if not isinstance(handle, str) or not re.fullmatch(r"share_[A-Za-z0-9_-]{32}", handle):
                raise WorkspaceError("execution_not_found")
            row = db.execute("SELECT * FROM workspace_execution_bindings WHERE project_id=? AND share_mode='fleet' AND share_handle=?", (project, handle)).fetchone()
            if row is None:
                raise WorkspaceError("execution_not_found")
            _audit(db, project, row["job_id"], row["client_id"], actor_client, "sync_shared")
            return {"dispatch": _summary(row), "submission": json.loads(row["submission_json"]), "remoteJobId": row["remote_job_id"], "actor": row["actor"], "ownerClientId": row["client_id"]}
        if command == "claim_reconciliation":
            limit = request["limit"]
            if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 5:
                raise WorkspaceError("invalid_limit")
            now = int(time.time() * 1000)
            db.execute("BEGIN IMMEDIATE")
            try:
                # Give a newly published binding its first observation before
                # rechecking older work.  A failed or still-review-pending
                # binding is deliberately left unsettled, so ordering all
                # never-observed rows oldest-first lets a backlog delay a new
                # handoff by several polling intervals.  Once observed, the
                # normal least-recently-polled order preserves fair polling.
                rows = db.execute("""SELECT project_id,job_id,client_id FROM workspace_execution_bindings
                    WHERE settled=0 AND COALESCE(lease_until,0)<=?
                    AND (last_polled_at IS NULL OR last_polled_at<=?)
                    ORDER BY CASE WHEN last_polled_at IS NULL THEN 0 ELSE 1 END ASC,
                    CASE WHEN last_polled_at IS NULL THEN created_at END DESC,
                    -- Millisecond clocks legitimately collide when a client
                    -- publishes several bindings in one event-loop turn.  In
                    -- that case, use SQLite insertion order as the final
                    -- "newest first" tiebreaker.  Lexical project/job order
                    -- would otherwise let unrelated backlog delay the most
                    -- recent handoff by several reconciliation intervals.
                    CASE WHEN last_polled_at IS NULL THEN rowid END DESC,
                    last_polled_at ASC,project_id ASC,job_id ASC,client_id ASC LIMIT ?""",
                    (now, now - 30_000, limit)).fetchall()
                claimed = []
                for row in rows:
                    changed = db.execute("""UPDATE workspace_execution_bindings SET last_polled_at=?,lease_until=?
                        WHERE project_id=? AND job_id=? AND client_id=? AND settled=0
                        AND COALESCE(lease_until,0)<=? AND (last_polled_at IS NULL OR last_polled_at<=?)""",
                        (now, now + 120_000, row["project_id"], row["job_id"], row["client_id"], now, now - 30_000)).rowcount
                    if changed:
                        claimed.append({"projectId": row["project_id"], "jobId": row["job_id"], "clientId": row["client_id"]})
                db.execute("COMMIT")
                return {"bindings": claimed}
            except Exception:
                db.execute("ROLLBACK")
                raise
        if command == "settle_reconciliation":
            project = _id(request["projectId"], "project_id")
            job = _id(request["jobId"], "job_id")
            client = _client_id(request["clientId"])
            db.execute("BEGIN IMMEDIATE")
            try:
                changed = db.execute("UPDATE workspace_execution_bindings SET settled=1,lease_until=0 WHERE project_id=? AND job_id=? AND client_id=?",
                                     (project, job, client)).rowcount
                if not changed:
                    raise WorkspaceError("execution_not_found")
                db.execute("COMMIT")
                return {"settled": True}
            except Exception:
                db.execute("ROLLBACK")
                raise
        rows = db.execute("SELECT * FROM workspace_execution_bindings WHERE project_id=? AND share_mode='fleet' ORDER BY updated_at DESC,job_id LIMIT 100", (project,)).fetchall()
        return {"executions": [_summary(row) for row in rows]}
    finally:
        db.close()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    args = parser.parse_args(argv)
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        print('{"error":"request_too_large"}'); return 2
    try:
        result = handle(args.db, json.loads(raw))
        output = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        if len(output.encode()) > MAX_OUTPUT: raise WorkspaceError("response_too_large")
        print(output); return 0
    except WorkspaceError as exc:
        print(json.dumps({"error": exc.code}, separators=(",", ":")))
    except (json.JSONDecodeError, UnicodeDecodeError):
        print('{"error":"invalid_json"}')
    except (sqlite3.Error, OSError):
        print('{"error":"storage_unavailable"}')
    except (TypeError, ValueError, KeyError):
        print('{"error":"invalid_input"}')
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
