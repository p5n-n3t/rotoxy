"""Private SQLite ledger for explicitly published Agent Workspace executions.

The Node gateway is the authorization boundary. This CLI stores intent before
provider submission and exposes only project-level summaries to snapshots.
It never calls a provider or returns stored task instructions/results.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time

from snooze.agent_workspace import AgentWorkspace, WorkspaceError

MAX_INPUT = 1_100_000
MAX_OUTPUT = 2_000_000
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
STATES = {"pending", "accepted", "needs_reconciliation", "draft", "queued", "running", "held", "paused", "emergency_stopped", "complete", "completed", "blocked", "failed", "cancelled", "unknown"}


def _id(value, field):
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise WorkspaceError("invalid_" + field)
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
    return db


def _summary(row):
    try:
        submission = json.loads(row["submission_json"])
    except (TypeError, ValueError):
        submission = {}
    remote = row["remote_state"]
    return {"projectId": row["project_id"], "jobId": row["job_id"], "state": remote or row["state"],
            "provider": "lightsprint", "taskCount": len(submission.get("tasks", [])),
            "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def handle(path, request):
    if not isinstance(request, dict) or not isinstance(request.get("command"), str):
        raise WorkspaceError("invalid_request")
    command = request["command"]
    allowed = {
        "reserve": {"command", "projectId", "jobId", "clientId", "actor", "idempotencyKey", "requestHash", "submission"},
        "set_state": {"command", "projectId", "jobId", "clientId", "state"},
        "get": {"command", "projectId", "jobId", "clientId"},
        "list": {"command", "projectId"},
    }
    if command not in allowed or set(request) != allowed[command]:
        raise WorkspaceError("invalid_request")
    project = _id(request["projectId"], "project_id")
    db = _connect(path)
    try:
        if command == "reserve":
            job = _id(request["jobId"], "job_id")
            client = _id(request["clientId"], "client_id")
            actor = "client:" + client
            if request["actor"] != actor or not isinstance(request["submission"], dict):
                raise WorkspaceError("invalid_owner")
            key = _id(request["idempotencyKey"], "idempotency_key")
            digest = request["requestHash"]
            if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise WorkspaceError("invalid_request_hash")
            submission = json.dumps(request["submission"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            now = int(time.time() * 1000)
            db.execute("BEGIN IMMEDIATE")
            try:
                by_job = db.execute("SELECT * FROM workspace_executions WHERE project_id=? AND job_id=?", (project, job)).fetchone()
                by_key = db.execute("SELECT * FROM workspace_executions WHERE project_id=? AND idempotency_key=?", (project, key)).fetchone()
                existing = by_job or by_key
                if existing:
                    if existing["client_id"] != client or existing["job_id"] != job or existing["idempotency_key"] != key or existing["request_hash"] != digest:
                        raise WorkspaceError("idempotency_conflict")
                    db.execute("COMMIT")
                    return {"created": False, "shouldSubmit": False, "dispatch": _summary(existing)}
                db.execute("INSERT INTO workspace_executions(project_id,job_id,client_id,actor,idempotency_key,request_hash,submission_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)",
                           (project, job, client, actor, key, digest, submission, now, now))
                db.execute("COMMIT")
                row = db.execute("SELECT * FROM workspace_executions WHERE project_id=? AND job_id=?", (project, job)).fetchone()
                return {"created": True, "shouldSubmit": True, "dispatch": _summary(row)}
            except Exception:
                db.execute("ROLLBACK")
                raise
        if command == "set_state":
            job = _id(request["jobId"], "job_id")
            client = _id(request["clientId"], "client_id")
            state = request["state"]
            if state not in STATES:
                raise WorkspaceError("invalid_state")
            now = int(time.time() * 1000)
            db.execute("UPDATE workspace_executions SET state=?,remote_state=?,updated_at=? WHERE project_id=? AND job_id=? AND client_id=?",
                       ("accepted" if state == "accepted" else state, state, now, project, job, client))
            row = db.execute("SELECT * FROM workspace_executions WHERE project_id=? AND job_id=? AND client_id=?", (project, job, client)).fetchone()
            if row is None:
                raise WorkspaceError("execution_not_found")
            return _summary(row)
        if command == "get":
            job = _id(request["jobId"], "job_id")
            client = _id(request["clientId"], "client_id")
            row = db.execute("SELECT * FROM workspace_executions WHERE project_id=? AND job_id=? AND client_id=?", (project, job, client)).fetchone()
            if row is None:
                raise WorkspaceError("execution_not_found")
            return {"dispatch": _summary(row), "submission": json.loads(row["submission_json"])}
        rows = db.execute("SELECT * FROM workspace_executions WHERE project_id=? ORDER BY updated_at DESC,job_id LIMIT 100", (project,)).fetchall()
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
