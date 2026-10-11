"""Durable, bounded assignment registry and provider-operation outbox.

This module deliberately knows stable account IDs and operation DTOs only.  The
Token2OAuth process owns credentials and performs every provider/MCP call.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from .credit_ledger import CreditDenied

MAX_TASKS = 100
MAX_INSTRUCTIONS = 16 * 1024
MAX_JOB_BYTES = 1024 * 1024
MAX_DEPENDENCIES = 8
MAX_PAGE = 200
MUTATING_KINDS = {"create_task", "patch_task", "launch_task", "chat_session", "cancel_session"}
OPERATION_KINDS = {"observe_session", "chat_session", "cancel_session"}
USAGE_KEYS = {"reportedSessionCostUsd", "promptCount", "budgetUsed", "maxBudget", "fundingSource", "sandboxTier"}
# Node job-worker.ts returns these only on the chat_session path before
# mutationStarted is set. A rejected outcome alone is never proof of no dispatch.
SAFE_CHAT_PREFLIGHT_REJECTIONS = {
    "account_identity_mismatch", "invalid_operation_input",
    "worker_stopping_or_lease_insufficient", "session_not_sendable", "account_unavailable_or_stopping",
}
ASSIGNMENT_KEYS = {"schemaVersion", "assignmentId", "idempotencyKey", "projectId", "eligibleAccountIds", "tasks"}
ASSIGNMENT_OPTIONAL_KEYS = {"ownerPrincipalId", "clientId", "maxWorkers"}
TASK_KEYS = {"taskId", "dependsOn", "scopeKeys", "instructions", "execution", "output"}
TASK_OPTIONAL_KEYS = {"inputRef", "inputSha256", "providerTaskId", "stackId", "provider"}
OUTPUT_KEYS = {
    "json-records": {"kind", "validator", "ids", "requiredFields"},
    "text": {"kind", "maxBytes", "format", "expectedMarker"},
    "coding-artifact": {"kind", "repository", "allowedPaths", "requirePullRequest"},
}
ACTIVE_TASK_STATES = ("reserved", "starting", "running", "awaiting_output", "ambiguous", "cancel_pending")


def _text(value, name, maximum=256):
    if not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value:
        raise ValueError(f"Invalid {name}")
    return value


def _closed_object(value, keys, name):
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"{name} has unsupported or missing fields")


def _allowed_object(value, required, optional, name):
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - optional:
        raise ValueError(f"{name} has unsupported or missing fields")


def _validate_usage(value):
    _closed_object(value, USAGE_KEYS, "usage")
    for field, minimum in (("reportedSessionCostUsd", 0), ("budgetUsed", 0), ("maxBudget", 0)):
        number = value[field]
        try:
            finite = type(number) in {int, float} and math.isfinite(number)
        except (OverflowError, TypeError):
            finite = False
        if not finite or number < minimum or (field == "maxBudget" and number == 0):
            raise ValueError(f"Invalid usage {field}")
    if type(value["promptCount"]) is not int or value["promptCount"] < 0:
        raise ValueError("Invalid usage promptCount")
    for field in ("fundingSource", "sandboxTier"):
        _text(value[field], f"usage.{field}", 64)
    return value


def _validate_scope(value):
    _text(value, "scope", 512)
    if value.startswith("record:"):
        if not value[7:] or any(char.isspace() for char in value[7:]):
            raise ValueError("Invalid record scope")
        return value
    if value.startswith("path:"):
        raw = value[5:]
        path = PurePosixPath(raw)
        if not raw or path.is_absolute() or ".." in path.parts or "\\" in raw or str(path) == ".":
            raise ValueError("Scope must be repository-relative")
        return "path:" + str(path)
    raise ValueError("Use record:ID or path:repository-relative scope")


def validate_assignment(body):
    _allowed_object(body, ASSIGNMENT_KEYS, ASSIGNMENT_OPTIONAL_KEYS, "assignment")
    if body["schemaVersion"] != 1 or type(body["schemaVersion"]) is not int:
        raise ValueError("schemaVersion must be 1")
    _text(body["assignmentId"], "assignmentId")
    _text(body["idempotencyKey"], "idempotencyKey", 200)
    _text(body["projectId"], "projectId")
    accounts = body["eligibleAccountIds"]
    if not isinstance(accounts, list) or not 1 <= len(accounts) <= 50:
        raise ValueError("eligibleAccountIds must contain 1 to 50 accounts")
    if any(not isinstance(account, str) or not account or len(account) > 256 for account in accounts) or len(set(accounts)) != len(accounts):
        raise ValueError("eligibleAccountIds must be distinct stable IDs")
    for field in ASSIGNMENT_OPTIONAL_KEYS & set(body):
        if field == "maxWorkers":
            if type(body[field]) is not int or not 1 <= body[field] <= 32:
                raise ValueError("maxWorkers must be between 1 and 32")
        else:
            _text(body[field], field, 256)
    tasks = body["tasks"]
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= MAX_TASKS:
        raise ValueError(f"tasks must contain 1 to {MAX_TASKS} entries")
    if len(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_JOB_BYTES:
        raise ValueError("Assignment exceeds 1 MiB")
    ids = []
    normalized = []
    for task in tasks:
        _allowed_object(task, TASK_KEYS, TASK_OPTIONAL_KEYS, "task")
        task_id = _text(task["taskId"], "taskId")
        ids.append(task_id)
        dependencies = task["dependsOn"]
        if not isinstance(dependencies, list) or len(dependencies) > MAX_DEPENDENCIES or any(not isinstance(v, str) for v in dependencies):
            raise ValueError("dependsOn must contain at most 8 task IDs")
        if len(set(dependencies)) != len(dependencies) or task_id in dependencies:
            raise ValueError("Duplicate or self dependency")
        scopes = task["scopeKeys"]
        if not isinstance(scopes, list) or not scopes:
            raise ValueError("Each task needs scopeKeys")
        normalized_scopes = [_validate_scope(scope) for scope in scopes]
        if len(set(normalized_scopes)) != len(normalized_scopes):
            raise ValueError("Duplicate scope")
        has_ref = "inputRef" in task
        has_hash = "inputSha256" in task
        if has_ref != has_hash:
            raise ValueError("inputRef and inputSha256 must be supplied together")
        if has_ref:
            _text(task["inputRef"], "inputRef", 512)
            if not isinstance(task["inputSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", task["inputSha256"]):
                raise ValueError("inputSha256 must be 64 lowercase hexadecimal characters")
        if not isinstance(task["instructions"], str) or len(task["instructions"].encode("utf-8")) > MAX_INSTRUCTIONS:
            raise ValueError("instructions exceeds 16 KiB")
        if re.search(r"(?i)bearer\s+\S+|lsat_[A-Za-z0-9_-]+", task["instructions"]):
            raise ValueError("Credential-like instructions are not accepted")
        if has_ref and re.match(r"(?i)https?://", task["inputRef"]):
            raise ValueError("inputRef must be an opaque local reference")
        execution = task["execution"]
        if not isinstance(execution, dict) or execution.get("mode") != "existing-session":
            raise ValueError("Fresh launches are disabled until account policy is implemented")
        if set(execution) != {"mode", "sessionId", "accountId"} or not all(isinstance(execution[k], str) and execution[k] for k in ("sessionId", "accountId")):
            raise ValueError("Invalid registered-session execution")
        if execution["accountId"] not in accounts:
            raise ValueError("Registered session account must be eligible")
        output = task["output"]
        if not isinstance(output, dict) or output.get("kind") not in OUTPUT_KEYS or set(output) - OUTPUT_KEYS[output.get("kind")] or not OUTPUT_KEYS[output.get("kind")] - {"expectedMarker"} <= set(output):
            raise ValueError("Unsupported output contract")
        if output["kind"] != "text":
            raise ValueError("This runtime increment supports bounded text output only")
        if type(output["maxBytes"]) is not int or not 1 <= output["maxBytes"] <= 32768 or not isinstance(output["format"], str) or not output["format"]:
            raise ValueError("Invalid bounded text output contract")
        _text(output.get("expectedMarker"), "expectedMarker", 256)
        if "providerTaskId" in task:
            _text(task["providerTaskId"], "providerTaskId", 256)
        if "stackId" in task:
            _text(task["stackId"], "stackId", 256)
        if "provider" in task:
            _text(task["provider"], "provider", 64)
        if output["kind"] == "json-records" and (not isinstance(output["ids"], list) or not output["ids"] or not isinstance(output["requiredFields"], list) or not output["requiredFields"]):
            raise ValueError("Invalid JSON records output contract")
        if output["kind"] == "json-records" and (len(output["ids"]) > 100 or len(output["requiredFields"]) > 100 or
                any(not isinstance(item, str) or not item or len(item) > 256 for item in output["ids"] + output["requiredFields"])):
            raise ValueError("JSON record contract exceeds bounds")
        if output["kind"] == "coding-artifact" and (not isinstance(output["repository"], str) or not isinstance(output["allowedPaths"], list) or type(output["requirePullRequest"]) is not bool):
            raise ValueError("Invalid coding artifact output contract")
        if output["kind"] == "coding-artifact" and (not output["repository"] or len(output["repository"]) > 256 or
                not 1 <= len(output["allowedPaths"]) <= 100 or any(not isinstance(p, str) or not p or p.startswith("/") or ".." in PurePosixPath(p).parts or "\\" in p for p in output["allowedPaths"])):
            raise ValueError("Coding artifact paths must be bounded repository-relative paths")
        normalized.append({**task, "scopeKeys": normalized_scopes})
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate taskId")
    id_set = set(ids)
    indegree = {task["taskId"]: 0 for task in normalized}
    children = {task["taskId"]: [] for task in normalized}
    for task in normalized:
        for parent in task["dependsOn"]:
            if parent not in id_set:
                raise ValueError("Dependencies must belong to this assignment")
            indegree[task["taskId"]] += 1
            children[parent].append(task["taskId"])
    ready = [key for key, degree in indegree.items() if degree == 0]
    visited = 0
    while ready:
        current = ready.pop()
        visited += 1
        for child in children[current]:
            indegree[child] -= 1
            if indegree[child] == 0:
                ready.append(child)
    if visited != len(normalized):
        raise ValueError("Task dependencies contain a cycle")
    return {**body, "tasks": normalized}


class JobRegistry:
    """Single-host durable registry; SQLite transactions fence every claim/result."""

    def __init__(self, path, *, credit_admission=None):
        self.path = Path(path)
        self.credit_admission = credit_admission
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.path.parent, 0o700)
        self.repository = None
        try:
            from .tasks import TaskRepository
            self.repository = TaskRepository(self.path)
        except ModuleNotFoundError as exc:
            # R11's pinned Snooze source may not yet be present on this branch.
            if exc.name not in {"snooze.tasks", f"{__package__}.tasks"}:
                raise
        if self.repository is not None:
            self.path = self.repository.path
        previous_umask = os.umask(0o077)
        try:
            with self.connection(write=True) as db:
                db.executescript("""
                CREATE TABLE IF NOT EXISTS assignments(
                  id TEXT PRIMARY KEY, project TEXT NOT NULL, idem TEXT NOT NULL,
                  fingerprint TEXT NOT NULL, eligible TEXT NOT NULL, body TEXT NOT NULL,
                  state TEXT NOT NULL, approved INTEGER NOT NULL, revision INTEGER NOT NULL,
                  created_at REAL NOT NULL, owner_principal TEXT, client_id TEXT, UNIQUE(project,idem));
                CREATE TABLE IF NOT EXISTS job_tasks(
                  assignment TEXT NOT NULL, task_id TEXT NOT NULL, body TEXT NOT NULL,
                  state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
                  selected_account TEXT, attempt_id TEXT, provider_task_id TEXT, session_id TEXT,
                  released_at REAL, dispatch_at REAL, poll_count INTEGER NOT NULL DEFAULT 0, reported_model TEXT,
                  provider_status TEXT,
                  PRIMARY KEY(assignment,task_id));
                CREATE TABLE IF NOT EXISTS operations(
                  id TEXT PRIMARY KEY, assignment TEXT NOT NULL, task_id TEXT NOT NULL,
                  attempt_id TEXT NOT NULL, generation INTEGER NOT NULL, account TEXT NOT NULL,
                  kind TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL,
                  worker TEXT, lease_until REAL, result TEXT, error_class TEXT,
                  created_at REAL NOT NULL, due_at REAL NOT NULL DEFAULT 0);
                CREATE INDEX IF NOT EXISTS operations_ready ON operations(state,created_at);
                CREATE TABLE IF NOT EXISTS job_events(
                  id INTEGER PRIMARY KEY AUTOINCREMENT, assignment TEXT NOT NULL,
                  kind TEXT NOT NULL, at REAL NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS bridge_control(
                  id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL,
                  emergency_stop INTEGER NOT NULL, revision INTEGER NOT NULL, max_workers INTEGER NOT NULL DEFAULT 3);
                INSERT OR IGNORE INTO bridge_control(id,paused,emergency_stop,revision,max_workers) VALUES(1,0,0,1,3);
                CREATE TABLE IF NOT EXISTS scheduler_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
                INSERT OR IGNORE INTO scheduler_meta(key,value) VALUES('round_robin',0);
                CREATE TABLE IF NOT EXISTS registered_accounts(account_id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS job_results(assignment TEXT NOT NULL, task_id TEXT NOT NULL, generation INTEGER NOT NULL, text TEXT NOT NULL, assistant_at REAL NOT NULL, reported_model TEXT, created_at REAL NOT NULL, PRIMARY KEY(assignment,task_id,generation));
                """)
                db.execute("BEGIN IMMEDIATE")
                self._upgrade_schema(db)
            os.chmod(self.path, 0o600)
        finally:
            os.umask(previous_umask)

    @contextmanager
    def connection(self, write=False):
        if self.repository is not None:
            with self.repository.connection(write=write) as db:
                yield db
            return
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            if write:
                db.commit()
        except Exception:
            if write:
                db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _upgrade_schema(db):
        additions = {
            "assignments": {"owner_principal": "TEXT", "client_id": "TEXT"},
            "job_tasks": {"released_at": "REAL", "dispatch_at": "REAL", "poll_count": "INTEGER NOT NULL DEFAULT 0", "reported_model": "TEXT", "provider_status": "TEXT"},
            "bridge_control": {"max_workers": "INTEGER NOT NULL DEFAULT 3"},
        }
        for table, columns in additions.items():
            existing = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
            for name, declaration in columns.items():
                if name not in existing:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
        operation_columns = {row["name"] for row in db.execute("PRAGMA table_info(operations)")}
        if "due_at" not in operation_columns:
            db.execute("ALTER TABLE operations ADD COLUMN due_at REAL NOT NULL DEFAULT 0")
        for index in db.execute("PRAGMA index_list(operations)").fetchall():
            if not index["unique"]:
                continue
            columns = tuple(row["name"] for row in db.execute(f"PRAGMA index_info({index['name']})"))
            if columns == ("assignment", "task_id", "generation", "kind"):
                db.execute("DROP INDEX IF EXISTS operations_ready")
                db.execute("ALTER TABLE operations RENAME TO operations_r14")
                db.execute("""CREATE TABLE operations(
                  id TEXT PRIMARY KEY, assignment TEXT NOT NULL, task_id TEXT NOT NULL,
                  attempt_id TEXT NOT NULL, generation INTEGER NOT NULL, account TEXT NOT NULL,
                  kind TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL,
                  worker TEXT, lease_until REAL, result TEXT, error_class TEXT,
                  created_at REAL NOT NULL, due_at REAL NOT NULL DEFAULT 0)""")
                db.execute("""INSERT INTO operations(id,assignment,task_id,attempt_id,generation,account,kind,input,state,worker,lease_until,result,error_class,created_at,due_at)
                              SELECT id,assignment,task_id,attempt_id,generation,account,kind,input,state,worker,lease_until,result,error_class,created_at,0 FROM operations_r14""")
                db.execute("DROP TABLE operations_r14")
                break
        db.execute("CREATE INDEX IF NOT EXISTS operations_ready ON operations(state,due_at,created_at)")

    def _event(self, db, assignment, kind, data=None, now=None):
        # Event payloads contain state/IDs only. Instructions and operation inputs stay private.
        safe = {key: value for key, value in (data or {}).items()
                if key in {"state", "taskId", "accountId", "generation", "operationId", "reason"}
                and isinstance(value, (str, int, float, bool, type(None)))}
        when = time.time() if now is None else now
        if self.repository is not None:
            row = db.execute("SELECT project FROM assignments WHERE id=?", (assignment,)).fetchone()
            if row:
                self.repository.event(db, row["project"], kind, {**safe, "assignmentId": assignment}, now=when)
                return
        db.execute("INSERT INTO job_events(assignment,kind,at,data) VALUES(?,?,?,?)",
                   (assignment, kind, when, json.dumps(safe)))

    def register_account(self, body, now=None):
        required = {"accountId", "enabled", "authorized", "allowUnknownQuota", "health", "quota", "registeredSessions"}
        _allowed_object(body, required, {"localCapacity"}, "account")
        account_id = _text(body["accountId"], "accountId")
        if any(type(body[key]) is not bool for key in ("enabled", "authorized", "allowUnknownQuota")):
            raise ValueError("Account flags must be boolean")
        if body["health"] not in {"healthy", "degraded", "auth_failed", "unknown"} or body["quota"] not in {"available", "unknown", "depleted"}:
            raise ValueError("Invalid account health or quota signal")
        capacity = body.get("localCapacity", 1)
        if type(capacity) is not int or not 1 <= capacity <= 16:
            raise ValueError("localCapacity must be between 1 and 16")
        sessions = body["registeredSessions"]
        if not isinstance(sessions, list) or len(sessions) > 100:
            raise ValueError("registeredSessions must be a bounded list")
        clean_sessions = []
        seen = set()
        for session in sessions:
            _closed_object(session, {"id", "model", "workspace"}, "registered session")
            clean = {key: _text(session[key], key, 256) for key in ("id", "model", "workspace")}
            if clean["id"] in seen:
                raise ValueError("Duplicate registered session")
            seen.add(clean["id"])
            clean_sessions.append(clean)
        data = {"accountId": account_id, "enabled": body["enabled"], "authorized": body["authorized"],
                "allowUnknownQuota": body["allowUnknownQuota"], "health": body["health"],
                "quota": body["quota"], "localCapacity": capacity, "registeredSessions": clean_sessions}
        when = time.time() if now is None else now
        with self.connection(write=True) as db:
            current = db.execute("SELECT revision,data FROM registered_accounts WHERE account_id=?", (account_id,)).fetchone()
            # A busy session is an identity tuple, not just an ID. Keep its owning
            # account, workspace, and model stable until every reservation releases.
            old_sessions = {item["id"]: item for item in json.loads(current["data"])["registeredSessions"]} if current else {}
            requested_sessions = {item["id"]: item for item in clean_sessions}
            for session_id, old in old_sessions.items():
                busy = db.execute(
                    "SELECT 1 FROM job_tasks WHERE session_id=? AND state IN (?,?,?,?,?,?) LIMIT 1",
                    (session_id, *ACTIVE_TASK_STATES),
                ).fetchone()
                if not busy and self.repository is not None:
                    busy = db.execute("SELECT 1 FROM attempts WHERE session=? AND released_at IS NULL LIMIT 1", (session_id,)).fetchone()
                if busy and requested_sessions.get(session_id) != old:
                    raise ValueError("Cannot change a registered session while it is reserved")
            if self.repository is not None:
                for session_id, requested in requested_sessions.items():
                    live = db.execute("SELECT account FROM attempts WHERE session=? AND released_at IS NULL LIMIT 1", (session_id,)).fetchone()
                    if live and (live["account"] != account_id or old_sessions.get(session_id) != requested):
                        raise ValueError("Cannot rebind a reserved session registration")
            # Do not let two account registrations claim one live session identity.
            for session_id in requested_sessions:
                for other in db.execute("SELECT account_id,data FROM registered_accounts WHERE account_id<>?", (account_id,)):
                    other_sessions = json.loads(other["data"])["registeredSessions"]
                    if any(item["id"] == session_id for item in other_sessions):
                        busy = db.execute(
                            "SELECT 1 FROM job_tasks WHERE session_id=? AND state IN (?,?,?,?,?,?) LIMIT 1",
                            (session_id, *ACTIVE_TASK_STATES),
                        ).fetchone()
                        if not busy and self.repository is not None:
                            busy = db.execute("SELECT 1 FROM attempts WHERE session=? AND released_at IS NULL LIMIT 1", (session_id,)).fetchone()
                        if busy and old_sessions.get(session_id) != requested_sessions[session_id]:
                            raise ValueError("Cannot rebind a reserved session to another account")
            revision = current["revision"] + 1 if current else 1
            db.execute("INSERT INTO registered_accounts(account_id,data,revision,updated_at) VALUES(?,?,?,?) "
                       "ON CONFLICT(account_id) DO UPDATE SET data=excluded.data,revision=excluded.revision,updated_at=excluded.updated_at",
                       (account_id, json.dumps(data, sort_keys=True), revision, when))
            return {"accountId": account_id, "revision": revision}

    @staticmethod
    def _account(db, account_id, session_id=None):
        row = db.execute("SELECT data FROM registered_accounts WHERE account_id=?", (account_id,)).fetchone()
        if not row:
            raise RuntimeError("Account is not registered")
        account = json.loads(row["data"])
        if not account["enabled"] or not account["authorized"] or account["health"] != "healthy":
            raise RuntimeError("Account is disabled or not authorized/healthy")
        if account["quota"] == "depleted" or (account["quota"] == "unknown" and not account["allowUnknownQuota"]):
            raise RuntimeError("Account quota policy blocks dispatch")
        session = next((item for item in account["registeredSessions"] if item["id"] == session_id), None) if session_id else None
        if session_id and session is None:
            raise RuntimeError("Session is not registered to this account")
        return account, session

    @staticmethod
    def _scopes_overlap(left, right):
        for a in left:
            for b in right:
                if a == b or (a.startswith("path:") and b.startswith("path:") and (a.startswith(b + "/") or b.startswith(a + "/"))):
                    return True
        return False

    def submit(self, body, *, approved=True, now=None):
        body = validate_assignment(body)
        encoded = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        fingerprint = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        created = time.time() if now is None else now
        with self.connection(write=True) as db:
            prior = db.execute("SELECT * FROM assignments WHERE project=? AND idem=?", (body["projectId"], body["idempotencyKey"])).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise ValueError("Idempotency key already belongs to a different assignment")
                return self._receipt(prior)
            for task in body["tasks"]:
                execution = task["execution"]
                self._account(db, execution["accountId"], execution["sessionId"])
            assignment_row = {"owner_principal": body.get("ownerPrincipalId"), "client_id": body.get("clientId")}
            state = "queued" if approved else "draft"
            db.execute("INSERT INTO assignments(id,project,idem,fingerprint,eligible,body,state,approved,revision,created_at,owner_principal,client_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                       (body["assignmentId"], body["projectId"], body["idempotencyKey"], fingerprint,
                        json.dumps(body["eligibleAccountIds"]), encoded, state, int(approved), 1, created,
                        assignment_row["owner_principal"], assignment_row["client_id"]))
            for task in body["tasks"]:
                db.execute("INSERT INTO job_tasks(assignment,task_id,body,state) VALUES(?,?,?,?)",
                           (body["assignmentId"], task["taskId"], json.dumps(task, ensure_ascii=False), "queued"))
            self._event(db, body["assignmentId"], "assignment_" + state, {"state": state}, created)
            row = db.execute("SELECT * FROM assignments WHERE id=?", (body["assignmentId"],)).fetchone()
            return self._receipt(row)

    @staticmethod
    def _receipt(row):
        return {"assignmentId": row["id"], "projectId": row["project"], "state": row["state"],
                "revision": row["revision"], "taskCount": len(json.loads(row["body"])["tasks"])}

    @staticmethod
    def _owner_matches(row, owner_principal_id, client_id):
        # No filters is reserved for direct local-admin access. Once either
        # trusted dimension is supplied, both stored dimensions must match,
        # including NULL; NULL is never a wildcard for an OAuth caller.
        if owner_principal_id is None and client_id is None:
            return True
        return row["owner_principal"] == owner_principal_id and row["client_id"] == client_id

    @staticmethod
    def _task_usage(db, task):
        if not task["attempt_id"] or not task["selected_account"] or not task["session_id"]:
            return None
        rows = db.execute(
            "SELECT rowid AS sequence,kind,input,result,created_at FROM operations WHERE assignment=? AND task_id=? AND attempt_id=? "
            "AND generation=? AND account=? AND kind IN ('chat_session','observe_session') AND state='accepted' "
            "AND result IS NOT NULL ORDER BY created_at,rowid",
            (task["assignment"], task["task_id"], task["attempt_id"], task["generation"], task["selected_account"]),
        ).fetchall()
        baseline = latest = None
        for operation in rows:
            try:
                request = json.loads(operation["input"])
                envelope = json.loads(operation["result"])
                receipt = envelope.get("result")
                if request.get("sessionId") != task["session_id"] or not isinstance(receipt, dict):
                    continue
                receipt_session = receipt.get("sessionId")
                if receipt_session is not None and receipt_session != task["session_id"]:
                    continue
                usage = receipt.get("usage")
                if usage is not None:
                    try:
                        usage = dict(_validate_usage(usage))
                    except (TypeError, ValueError):
                        usage = None  # Older persisted or malformed usage is unavailable, never zero.
                observed_at = envelope.get("observedAt", operation["created_at"])
                if not (isinstance(observed_at, (int, float)) and type(observed_at) is not bool and math.isfinite(observed_at)):
                    observed_at = operation["created_at"]
                item = {"usage": usage, "model": receipt.get("reportedModel"),
                        "observedAt": observed_at, "sequence": operation["sequence"]}
                if operation["kind"] == "chat_session" and (baseline is None or
                        (item["observedAt"], item["sequence"]) < (baseline["observedAt"], baseline["sequence"])):
                    baseline = item
                elif operation["kind"] == "observe_session" and (latest is None or
                        (item["observedAt"], item["sequence"]) > (latest["observedAt"], latest["sequence"])):
                    latest = item
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
        if latest is None or latest["usage"] is None:
            return None
        current = latest["usage"]
        result = {key: current[key] for key in USAGE_KEYS}
        if isinstance(latest["model"], str):
            result["reportedModel"] = latest["model"]
        result["observedAt"] = latest["observedAt"]
        result.update({"source": "lightsprint-session-status", "provisional": True, "budgetUnit": "unknown"})
        if baseline is not None and baseline["usage"] is not None and isinstance(baseline["model"], str) and baseline["model"] == latest["model"]:
            before = baseline["usage"]
            if current["reportedSessionCostUsd"] >= before["reportedSessionCostUsd"]:
                result["reportedCostDeltaUsd"] = round(current["reportedSessionCostUsd"] - before["reportedSessionCostUsd"], 12)
            if current["promptCount"] >= before["promptCount"]:
                result["promptCountDelta"] = current["promptCount"] - before["promptCount"]
        return result

    def get_assignment(self, assignment_id, owner_principal_id=None, client_id=None):
        with self.connection() as db:
            row = db.execute("SELECT * FROM assignments WHERE id=?", (assignment_id,)).fetchone()
            if not row or not self._owner_matches(row, owner_principal_id, client_id):
                return None
            tasks = []
            for task in db.execute("SELECT * FROM job_tasks WHERE assignment=? ORDER BY rowid", (assignment_id,)):
                spec = json.loads(task["body"])
                dto = {"taskId": task["task_id"], "state": task["state"], "dependsOn": spec["dependsOn"],
                              "attempt": task["attempt_id"], "generation": task["generation"],
                              "selectedAccountId": task["selected_account"], "providerTaskId": task["provider_task_id"],
                              "sessionId": task["session_id"], "dispatchAt": task["dispatch_at"], "releasedAt": task["released_at"],
                              "modelRequested": "unknown/unsupported", "modelReported": task["reported_model"],
                              "providerStatus": task["provider_status"], "quota": "unknown", "capacity": "unknown"}
                usage = self._task_usage(db, task)
                if usage is not None:
                    dto["usage"] = usage
                tasks.append(dto)
            return {"schemaVersion": 1, **self._receipt(row), "eligibleAccountIds": json.loads(row["eligible"]), "tasks": tasks}

    def list_assignments(self, project, *, offset=0, limit=50, owner_principal_id=None, client_id=None):
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= MAX_PAGE:
            raise ValueError("Invalid assignment page")
        with self.connection() as db:
            clauses, args = [], [project]
            if owner_principal_id is not None or client_id is not None:
                clauses.append("owner_principal IS ? AND client_id IS ?")
                args.extend((owner_principal_id, client_id))
            where = " AND " + " AND ".join(clauses) if clauses else ""
            total = db.execute("SELECT COUNT(*) FROM assignments WHERE project=?" + where, args).fetchone()[0]
            rows = db.execute("SELECT * FROM assignments WHERE project=?" + where + " ORDER BY created_at,id LIMIT ? OFFSET ?", (*args, limit, offset)).fetchall()
        return {"assignments": [self._receipt(row) for row in rows], "total": total, "offset": offset,
                "hasMore": offset + len(rows) < total}

    def approve(self, assignment_id, expected_revision, now=None):
        when = time.time() if now is None else now
        with self.connection(write=True) as db:
            row = db.execute("SELECT * FROM assignments WHERE id=?", (assignment_id,)).fetchone()
            if not row:
                raise KeyError("Assignment not found")
            if row["revision"] != expected_revision or row["state"] != "draft":
                raise RuntimeError("Stale assignment revision or state")
            db.execute("UPDATE assignments SET approved=1,state='queued',revision=revision+1 WHERE id=?", (assignment_id,))
            self._event(db, assignment_id, "assignment_queued", {"state": "queued"}, when)
            return self._receipt(db.execute("SELECT * FROM assignments WHERE id=?", (assignment_id,)).fetchone())

    def set_control(self, action, value, expected_revision):
        if action not in {"pause_dispatch", "emergency_stop"} or type(value) is not bool:
            raise ValueError("Invalid control action")
        with self.connection(write=True) as db:
            row = db.execute("SELECT * FROM bridge_control WHERE id=1").fetchone()
            if row["revision"] != expected_revision:
                raise RuntimeError("Stale control revision")
            field = "paused" if action == "pause_dispatch" else "emergency_stop"
            db.execute(f"UPDATE bridge_control SET {field}=?,revision=revision+1 WHERE id=1", (int(value),))
            return {"action": action, "value": value, "revision": expected_revision + 1}

    def events(self, after=0, limit=100):
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= MAX_PAGE:
            raise ValueError("Invalid event cursor/page size")
        with self.connection() as db:
            if self.repository is not None:
                rows = db.execute("SELECT id,project,task,attempt,kind,at,data FROM events WHERE id>? ORDER BY id LIMIT ?", (after, limit)).fetchall()
                events = [{"id": row["id"], "projectId": row["project"], "task": row["task"], "attempt": row["attempt"],
                           "kind": row["kind"], "at": row["at"], "data": json.loads(row["data"])} for row in rows]
            else:
                rows = db.execute("SELECT id,assignment,kind,at,data FROM job_events WHERE id>? ORDER BY id LIMIT ?", (after, limit)).fetchall()
                events = [{"id": row["id"], "assignmentId": row["assignment"], "kind": row["kind"],
                           "at": row["at"], "data": json.loads(row["data"])} for row in rows]
        return {"events": events, "cursor": events[-1]["id"] if events else after, "hasMore": len(events) == limit}

    @staticmethod
    def _next_kind(task):
        mode = task["execution"]["mode"]
        if mode == "fresh":
            return {"queued": "create_task", "created": "patch_task", "patched": "verify_task_packet",
                    "verified": "launch_task"}.get(task.get("dispatchPhase", "queued"))
        return "chat_session" if task.get("dispatchPhase", "queued") == "queued" else None

    def _queue_one_ready(self, db, now):
        control = db.execute("SELECT paused,emergency_stop FROM bridge_control WHERE id=1").fetchone()
        if control["paused"] or control["emergency_stop"]:
            return None
        rows = db.execute("SELECT a.*,t.task_id,t.body AS task_body,t.state AS task_state,t.generation,t.selected_account,t.attempt_id "
                          "FROM assignments a JOIN job_tasks t ON t.assignment=a.id "
                          "WHERE a.approved=1 AND a.state='queued' AND t.state IN ('queued','retry_due') "
                          "ORDER BY a.created_at,t.rowid").fetchall()
        for row in rows:
            spec = json.loads(row["task_body"])
            deps = spec["dependsOn"]
            if deps:
                states = {x["task_id"]: x["state"] for x in db.execute("SELECT task_id,state FROM job_tasks WHERE assignment=?", (row["id"],))}
                if any(states.get(dep) != "complete" for dep in deps):
                    continue
            accounts = json.loads(row["eligible"])
            control_row = db.execute("SELECT max_workers FROM bridge_control WHERE id=1").fetchone()
            max_workers = min(json.loads(row["body"]).get("maxWorkers", control_row["max_workers"]), control_row["max_workers"])
            active_count = db.execute("SELECT COUNT(*) FROM job_tasks WHERE state IN ('reserved','starting','running','awaiting_output','ambiguous','cancel_pending')").fetchone()[0]
            job_active = db.execute("SELECT COUNT(*) FROM job_tasks WHERE assignment=? AND state IN ('reserved','starting','running','awaiting_output','ambiguous','cancel_pending')", (row["id"],)).fetchone()[0]
            if active_count >= control_row["max_workers"] or job_active >= max_workers:
                continue
            available = []
            for candidate in accounts:
                try:
                    account_data, _ = self._account(db, candidate)
                except RuntimeError:
                    continue
                job_occupancy = db.execute("SELECT COUNT(*) FROM job_tasks WHERE selected_account=? AND state IN ('reserved','starting','running','awaiting_output','ambiguous','cancel_pending')", (candidate,)).fetchone()[0]
                external_occupancy = 0
                if self.repository is not None:
                    for active_attempt in db.execute("SELECT data FROM attempts WHERE account=? AND released_at IS NULL", (candidate,)):
                        owner = json.loads(active_attempt["data"] or "{}")
                        if not owner.get("r21Assignment"):
                            external_occupancy += 1
                if job_occupancy + external_occupancy < account_data["localCapacity"]:
                    available.append(candidate)
            if spec["execution"]["mode"] == "existing-session":
                pinned = spec["execution"]["accountId"]
                available = [account for account in available if account == pinned]
                session_id = spec["execution"]["sessionId"]
                session_occupancy = db.execute(
                    "SELECT COUNT(*) FROM job_tasks WHERE session_id=? AND state IN (?,?,?,?,?,?)",
                    (session_id, *ACTIVE_TASK_STATES),
                ).fetchone()[0]
                # This check is inside BEGIN IMMEDIATE alongside the reservation,
                # so claims from other projects/accounts cannot win concurrently.
                external_session_occupancy = 0
                if self.repository is not None:
                    for attempt in db.execute("SELECT id,data FROM attempts WHERE session=? AND released_at IS NULL", (session_id,)):
                        identity = json.loads(attempt["data"] or "{}")
                        if identity.get("r21Assignment") == row["id"] and identity.get("r21TaskId") == row["task_id"]:
                            continue
                        external_session_occupancy += 1
                if session_occupancy or external_session_occupancy:
                    continue
            if not available:
                continue
            if self._has_scope_conflict(db, row["project"], spec["scopeKeys"], row["id"], row["task_id"]):
                continue
            rr = db.execute("SELECT value FROM scheduler_meta WHERE key='round_robin'").fetchone()[0]
            account = available[rr % len(available)]
            account_data, session = self._account(db, account, spec["execution"]["sessionId"])
            db.execute("UPDATE scheduler_meta SET value=? WHERE key='round_robin'", (rr + 1,))
            generation = row["generation"] + 1
            attempt = uuid.uuid4().hex
            phase = "queued"
            kind = self._next_kind(spec)
            if kind not in OPERATION_KINDS:
                continue
            # Reservation, affinity, attempt generation, outbox operation, and event share one transaction.
            db.execute("UPDATE job_tasks SET state='reserved',generation=?,selected_account=?,attempt_id=? WHERE assignment=? AND task_id=? AND state IN ('queued','retry_due')",
                       (generation, account, attempt, row["id"], row["task_id"]))
            operation_id = uuid.uuid4().hex
            dispatch_at = now
            operation_input = {"sessionId": session["id"], "instructions": spec["instructions"],
                               "clientMessageId": f"{attempt}:{generation}", "expectedMarker": spec["output"]["expectedMarker"],
                               "dispatchAt": dispatch_at, "providerTaskId": spec.get("providerTaskId"),
                               "stackId": spec.get("stackId"), "provider": spec.get("provider"),
                               "workspace": session["workspace"], "model": session["model"]}
            db.execute("UPDATE job_tasks SET dispatch_at=?,session_id=? WHERE assignment=? AND task_id=? AND generation=?",
                       (dispatch_at, session["id"], row["id"], row["task_id"], generation))
            db.execute("INSERT INTO operations(id,assignment,task_id,attempt_id,generation,account,kind,input,state,worker,lease_until,result,error_class,created_at,due_at) VALUES(?,?,?,?,?,?,?,?,'queued',NULL,NULL,NULL,NULL,?,?)",
                       (operation_id, row["id"], row["task_id"], attempt, generation, account, kind,
                        json.dumps(operation_input), now, now))
            if self.repository is not None:
                db.execute("INSERT INTO attempts(id,task,project,account,generation,idempotency_key,session,state,scopes,started_at,lease_until,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                           (attempt, f"r21:{row['id']}:{row['task_id']}", row["project"], account, generation,
                            uuid.uuid4().hex, session["id"], "reserved", json.dumps(spec["scopeKeys"]), now,
                            now + 600, json.dumps({"r21Assignment": row["id"], "r21TaskId": row["task_id"]})))
            self._event(db, row["id"], "operation_queued", {"state": "queued", "taskId": row["task_id"],
                                                               "accountId": account, "generation": generation,
                                                               "operationId": operation_id}, now)
            return operation_id
        return None

    def _has_scope_conflict(self, db, project, scopes, assignment, task_id):
        for row in db.execute("SELECT a.id,a.project,t.task_id,t.body AS task_body,t.state FROM assignments a JOIN job_tasks t ON t.assignment=a.id WHERE a.state NOT IN ('complete','cancelled') AND t.state IN ('reserved','starting','running','awaiting_output','ambiguous','cancel_pending')"):
            if row["project"] == project and (row["id"], row["task_id"]) != (assignment, task_id):
                if self._scopes_overlap(scopes, json.loads(row["task_body"])["scopeKeys"]):
                    return True
        if self.repository is not None:
            for row in db.execute("SELECT scopes,data FROM attempts WHERE project=? AND released_at IS NULL", (project,)):
                owner = json.loads(row["data"] or "{}")
                if owner.get("r21Assignment") == assignment and owner.get("r21TaskId") == task_id:
                    continue
                if self._scopes_overlap(scopes, json.loads(row["scopes"])):
                    return True
        return False

    def claim_operation(self, worker_id, lease_seconds=30, now=None):
        _text(worker_id, "workerId", 128)
        if type(lease_seconds) is not int or not 1 <= lease_seconds <= 300:
            raise ValueError("leaseSeconds must be between 1 and 300")
        when = time.time() if now is None else now
        with self.connection(write=True) as db:
            expired = db.execute("SELECT * FROM operations WHERE state='claimed' AND lease_until<=?", (when,)).fetchall()
            for op in expired:
                state = "ambiguous" if op["kind"] in MUTATING_KINDS else "queued"
                db.execute("UPDATE operations SET state=?,worker=NULL,lease_until=NULL,error_class='LeaseExpired' WHERE id=? AND state='claimed'",
                           (state, op["id"]))
                if state == "ambiguous":
                    db.execute("UPDATE job_tasks SET state='ambiguous' WHERE assignment=? AND task_id=? AND generation=?",
                               (op["assignment"], op["task_id"], op["generation"]))
                    db.execute("UPDATE assignments SET state='held',revision=revision+1 WHERE id=?", (op["assignment"],))
                    self._event(db, op["assignment"], "operation_ambiguous", {"state": state,
                                  "taskId": op["task_id"], "generation": op["generation"], "operationId": op["id"]}, when)
            self._queue_one_ready(db, when)
            control = db.execute("SELECT paused,emergency_stop FROM bridge_control WHERE id=1").fetchone()
            if control["paused"] or control["emergency_stop"]:
                return None
            op = db.execute("SELECT o.* FROM operations o JOIN assignments a ON a.id=o.assignment "
                            "WHERE o.state='queued' AND o.due_at<=? AND a.state='queued' AND a.approved=1 ORDER BY o.created_at,o.id LIMIT 1", (when,)).fetchone()
            if not op:
                return None
            task_row = db.execute("SELECT * FROM job_tasks WHERE assignment=? AND task_id=?", (op["assignment"], op["task_id"])).fetchone()
            assignment = db.execute("SELECT * FROM assignments WHERE id=?", (op["assignment"],)).fetchone()
            if task_row["generation"] != op["generation"] or task_row["attempt_id"] != op["attempt_id"] or task_row["selected_account"] != op["account"] or task_row["state"] not in {"reserved", "starting", "running", "awaiting_output"}:
                db.execute("UPDATE operations SET state='rejected',error_class='StaleGeneration' WHERE id=? AND state='queued'", (op["id"],))
                return None
            control = db.execute("SELECT paused,emergency_stop FROM bridge_control WHERE id=1").fetchone()
            if control["paused"] or control["emergency_stop"] or assignment["state"] != "queued":
                return None
            task_spec = json.loads(task_row["body"])
            account_data, _ = self._account(db, op["account"], task_spec["execution"]["sessionId"])
            occupied = db.execute("SELECT COUNT(*) FROM job_tasks WHERE selected_account=? AND NOT (assignment=? AND task_id=?) AND state IN (?,?,?,?,?,?)",
                                  (op["account"], op["assignment"], op["task_id"], *ACTIVE_TASK_STATES)).fetchone()[0]
            if occupied >= account_data["localCapacity"]:
                return None
            session_id = task_spec["execution"]["sessionId"]
            session_occupancy = db.execute("SELECT COUNT(*) FROM job_tasks WHERE session_id=? AND NOT (assignment=? AND task_id=?) AND state IN (?,?,?,?,?,?)",
                                           (session_id, op["assignment"], op["task_id"], *ACTIVE_TASK_STATES)).fetchone()[0]
            if session_occupancy:
                return None
            if self.repository is not None:
                external = 0
                for attempt_row in db.execute("SELECT data FROM attempts WHERE (account=? OR session=?) AND released_at IS NULL", (op["account"], session_id)):
                    identity = json.loads(attempt_row["data"] or "{}")
                    if identity.get("r21Assignment") == op["assignment"] and identity.get("r21TaskId") == op["task_id"]:
                        continue
                    external += 1
                if external:
                    return None
            if self._has_scope_conflict(db, assignment["project"], task_spec["scopeKeys"], op["assignment"], op["task_id"]):
                return None
            # A session message can spend provider quota. Reserve against its
            # durable operation ID before a worker can receive the mutation.
            # If the process dies after reservation but before the job DB commit,
            # retrying this claim is an idempotent replay of the same hold.
            if op["kind"] == "chat_session" and self.credit_admission is not None:
                try:
                    self.credit_admission.reserve(operation_id=op["id"], account_id=op["account"])
                except CreditDenied:
                    db.execute("UPDATE operations SET state='rejected',error_class='CreditAdmissionDenied' WHERE id=? AND state='queued'", (op["id"],))
                    db.execute("UPDATE job_tasks SET state='blocked',released_at=? WHERE assignment=? AND task_id=? AND generation=?",
                               (when, op["assignment"], op["task_id"], op["generation"]))
                    if self.repository is not None:
                        db.execute("UPDATE attempts SET state='blocked',released_at=? WHERE id=? AND released_at IS NULL",
                                   (when, op["attempt_id"]))
                    db.execute("UPDATE assignments SET state='held',revision=revision+1 WHERE id=?", (op["assignment"],))
                    self._event(db, op["assignment"], "credit_admission_denied", {
                        "taskId": op["task_id"], "generation": op["generation"], "operationId": op["id"]
                    }, when)
                    return None
            db.execute("UPDATE operations SET state='claimed',worker=?,lease_until=? WHERE id=? AND state='queued'",
                       (worker_id, when + lease_seconds, op["id"]))
            return {"operationId": op["id"], "attemptId": op["attempt_id"], "generation": op["generation"],
                    "selectedAccountId": op["account"], "kind": op["kind"], "providerTaskId": task_spec.get("providerTaskId"),
                    "stackId": task_spec.get("stackId"), "provider": task_spec.get("provider"),
                    "sessionId": task_spec["execution"]["sessionId"], "input": json.loads(op["input"])}

    def record_result(self, operation_id, body, now=None):
        if not isinstance(body, dict) or set(body) - {"workerId", "outcome", "observedAt", "result", "errorClass"}:
            raise ValueError("Invalid operation result fields")
        worker = _text(body.get("workerId"), "workerId", 128)
        outcome = body.get("outcome")
        if outcome not in {"accepted", "rejected", "ambiguous"}:
            raise ValueError("Invalid operation outcome")
        result = body.get("result", {})
        if not isinstance(result, dict) or len(json.dumps(result, separators=(",", ":")).encode()) > 32768:
            raise ValueError("Result must be a bounded object")
        allowed_result = {"providerTaskId", "sessionId", "branchName", "commitRef", "artifactRefs", "pullRequest", "reportedModel", "status", "assistantText", "assistantAt", "usage", "creditDebit"}
        if set(result) - allowed_result:
            raise ValueError("Unsupported operation result fields")
        for key, value in result.items():
            if key == "usage":
                if value is not None:
                    _validate_usage(value)
                continue
            if key == "creditDebit":
                required = {"unit", "amount", "source", "verified"}
                if not isinstance(value, dict) or set(value) != required:
                    raise ValueError("Invalid provider credit debit evidence")
                _text(value["unit"], "creditDebit.unit", 64)
                if type(value["amount"]) is not int or value["amount"] < 0:
                    raise ValueError("Invalid provider credit debit amount")
                _text(value["source"], "creditDebit.source", 512)
                if type(value["verified"]) is not bool:
                    raise ValueError("Invalid provider credit debit verification")
                continue
            if isinstance(value, str):
                _text(value, key, 2048)
                if re.search(r"(?i)bearer\s+\S+|lsat_[A-Za-z0-9_-]+", value):
                    raise ValueError("Credential-like result values are not accepted")
            elif isinstance(value, list):
                if len(value) > 32 or any(not isinstance(v, str) or len(v) > 2048 for v in value): raise ValueError("Invalid reference list")
            elif isinstance(value, dict):
                if key != "pullRequest" or set(value) - {"url", "status"}: raise ValueError("Invalid pull request reference")
                for nested in value.values():
                    if not isinstance(nested, str) or len(nested) > 2048 or re.search(r"(?i)bearer\s+\S+|lsat_[A-Za-z0-9_-]+", nested):
                        raise ValueError("Invalid pull request reference")
            elif key == "assistantAt":
                if type(value) not in {int, float} or value < 0:
                    raise ValueError("assistantAt must be a non-negative timestamp")
            elif value is not None: raise ValueError("Invalid result value")
        error_class = body.get("errorClass")
        if error_class is not None and (not isinstance(error_class, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", error_class)):
            raise ValueError("errorClass must be a safe class name")
        when = time.time() if now is None else now
        comparable = {"outcome": outcome, "result": result, "errorClass": error_class}
        encoded = json.dumps({**comparable, "observedAt": when}, sort_keys=True, separators=(",", ":"))
        with self.connection(write=True) as db:
            op = db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
            if not op: raise KeyError("Operation not found")
            if op["state"] in {"accepted", "rejected", "ambiguous"}:
                try:
                    stored = json.loads(op["result"] or "{}")
                    stored.pop("observedAt", None)
                except (TypeError, json.JSONDecodeError):
                    stored = None
                if stored == comparable: return {"operationId": operation_id, "state": op["state"], "replayed": True}
                raise RuntimeError("Conflicting operation result")
            if op["state"] != "claimed" or op["worker"] != worker:
                raise RuntimeError("Operation is not owned by this worker")
            debit = result.get("creditDebit")
            if debit is not None:
                if self.credit_admission is None or op["kind"] != "chat_session" or outcome != "accepted":
                    raise ValueError("Provider debit cannot be reconciled for this operation")
                self.credit_admission.settle_verified_debit(
                    operation_id=op["id"], unit=debit["unit"], amount=debit["amount"],
                    source=debit["source"], verified=debit["verified"],
                )
            db.execute("UPDATE operations SET state=?,result=?,error_class=?,lease_until=NULL WHERE id=? AND state='claimed' AND worker=?",
                       (outcome, encoded, body.get("errorClass"), operation_id, worker))
            task = db.execute("SELECT * FROM job_tasks WHERE assignment=? AND task_id=?", (op["assignment"], op["task_id"])).fetchone()
            if task["generation"] != op["generation"] or task["attempt_id"] != op["attempt_id"] or task["selected_account"] != op["account"]:
                raise RuntimeError("Stale operation generation")
            if outcome == "ambiguous":
                state = "ambiguous"
            elif outcome == "rejected":
                state = "blocked"
            elif op["kind"] == "chat_session":
                state = "awaiting_output"
                payload = json.loads(op["input"])
                self._queue_observation(db, op, payload, when, delay=1)
            elif op["kind"] == "observe_session":
                state, complete = self._process_observation(db, op, task, result, when)
                if complete:
                    db.execute("UPDATE job_tasks SET released_at=? WHERE assignment=? AND task_id=? AND generation=?",
                               (when, op["assignment"], op["task_id"], op["generation"]))
                    db.execute("UPDATE attempts SET released_at=? WHERE id=? AND released_at IS NULL", (when, op["attempt_id"]))
                observed_status = result.get("status")
                if isinstance(observed_status, str):
                    db.execute("UPDATE job_tasks SET provider_status=? WHERE assignment=? AND task_id=? AND generation=?",
                               (observed_status, op["assignment"], op["task_id"], op["generation"]))
            else:
                state = "running" if op["kind"] == "launch_task" else "starting"
                spec = json.loads(task["body"])
                phase_map = {"create_task": "created", "patch_task": "patched", "verify_task_packet": "verified"}
                phase = phase_map.get(op["kind"])
                if phase:
                    spec["dispatchPhase"] = phase
                    db.execute("UPDATE job_tasks SET body=? WHERE assignment=? AND task_id=? AND generation=?",
                               (json.dumps(spec), op["assignment"], op["task_id"], op["generation"]))
                    next_kind = self._next_kind(spec)
                    if next_kind:
                        next_id = uuid.uuid4().hex
                        db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,'queued',NULL,NULL,NULL,NULL,?)",
                                   (next_id, op["assignment"], op["task_id"], op["attempt_id"], op["generation"], op["account"], next_kind,
                                    json.dumps({"assignmentId": op["assignment"], "taskId": op["task_id"], "phase": phase}), when))
                if result.get("providerTaskId"):
                    db.execute("UPDATE job_tasks SET provider_task_id=? WHERE assignment=? AND task_id=? AND generation=?",
                               (result["providerTaskId"], op["assignment"], op["task_id"], op["generation"]))
                if result.get("sessionId"):
                    db.execute("UPDATE job_tasks SET session_id=? WHERE assignment=? AND task_id=? AND generation=?",
                               (result["sessionId"], op["assignment"], op["task_id"], op["generation"]))
            if outcome == "rejected" and op["kind"] == "chat_session" and error_class in SAFE_CHAT_PREFLIGHT_REJECTIONS:
                # These explicit worker classes prove dispatch was not attempted.
                # Keep observe failures, post-send rejections, and generic errors reserved.
                db.execute("UPDATE job_tasks SET released_at=? WHERE assignment=? AND task_id=? AND generation=? AND released_at IS NULL",
                           (when, op["assignment"], op["task_id"], op["generation"]))
                db.execute("UPDATE attempts SET released_at=? WHERE id=? AND released_at IS NULL", (when, op["attempt_id"]))
                if self.credit_admission is not None:
                    self.credit_admission.release_known_refusal(op["id"], known_preexecution_refusal=True)
            db.execute("UPDATE job_tasks SET state=? WHERE assignment=? AND task_id=? AND generation=?",
                       (state, op["assignment"], op["task_id"], op["generation"]))
            if state == "complete":
                remaining = db.execute("SELECT COUNT(*) FROM job_tasks WHERE assignment=? AND state!='complete'",
                                       (op["assignment"],)).fetchone()[0]
                if remaining == 0:
                    changed = db.execute("UPDATE assignments SET state='complete',revision=revision+1 WHERE id=? AND state='queued' AND approved=1",
                                         (op["assignment"],)).rowcount
                    if changed:
                        self._event(db, op["assignment"], "assignment_complete", {"state": "complete"}, when)
            if state in {"ambiguous", "blocked"}:
                db.execute("UPDATE assignments SET state='held',revision=revision+1 WHERE id=?", (op["assignment"],))
            self._event(db, op["assignment"], "operation_" + state, {"state": state, "taskId": op["task_id"],
                          "generation": op["generation"], "operationId": operation_id}, when)
            return {"operationId": operation_id, "state": state, "replayed": False}

    def _queue_observation(self, db, op, payload, now, delay):
        next_id = uuid.uuid4().hex
        db.execute("INSERT INTO operations(id,assignment,task_id,attempt_id,generation,account,kind,input,state,created_at,due_at) VALUES(?,?,?,?,?,?,'observe_session',?,'queued',?,?)",
                   (next_id, op["assignment"], op["task_id"], op["attempt_id"], op["generation"], op["account"],
                    json.dumps({key: payload[key] for key in ("sessionId", "clientMessageId", "dispatchAt", "expectedMarker")}), now, now + delay))
        db.execute("UPDATE job_tasks SET poll_count=poll_count+1 WHERE assignment=? AND task_id=? AND generation=?",
                   (op["assignment"], op["task_id"], op["generation"]))

    def _process_observation(self, db, op, task, result, now):
        payload = json.loads(op["input"])
        status = result.get("status")
        if result.get("sessionId") != payload["sessionId"]:
            return "blocked", False
        text = result.get("assistantText")
        assistant_at = result.get("assistantAt")
        # A stale or absent assistant result is not completion; poll again with bounded backoff.
        if status in {"running", "pending"} or not isinstance(text, str) or type(assistant_at) not in {int, float} or assistant_at < payload["dispatchAt"]:
            count = task["poll_count"]
            if count >= 20:
                return "blocked", False
            self._queue_observation(db, op, payload, now, min(30, 2 ** min(count, 5)))
            return "awaiting_output", False
        if status not in {"idle", "complete", "completed", "finished", "done", "succeeded"}:
            return "blocked", False
        spec = json.loads(task["body"])
        output = spec["output"]
        encoded = text.encode("utf-8")
        if len(encoded) > output["maxBytes"] or output["expectedMarker"] not in text:
            return "blocked", False
        db.execute("INSERT OR IGNORE INTO job_results(assignment,task_id,generation,text,assistant_at,reported_model,created_at) VALUES(?,?,?,?,?,?,?)",
                   (op["assignment"], op["task_id"], op["generation"], text, assistant_at, result.get("reportedModel"), now))
        db.execute("UPDATE job_tasks SET reported_model=? WHERE assignment=? AND task_id=? AND generation=?",
                   (result.get("reportedModel"), op["assignment"], op["task_id"], op["generation"]))
        return "complete", True

    def assignment_results(self, assignment_id, owner_principal_id=None, client_id=None):
        with self.connection() as db:
            row = db.execute("SELECT owner_principal,client_id FROM assignments WHERE id=?", (assignment_id,)).fetchone()
            if not row:
                raise KeyError("Assignment not found")
            if not self._owner_matches(row, owner_principal_id, client_id):
                raise KeyError("Assignment not found")
            results = db.execute("SELECT task_id,generation,text,assistant_at,reported_model,created_at FROM job_results WHERE assignment=? ORDER BY task_id,generation", (assignment_id,)).fetchall()
            return {"assignmentId": assignment_id, "results": [dict(item) for item in results]}

    def cancel_assignment(self, assignment_id, expected_revision, owner_principal_id=None, client_id=None, now=None):
        when = time.time() if now is None else now
        with self.connection(write=True) as db:
            row = db.execute("SELECT * FROM assignments WHERE id=?", (assignment_id,)).fetchone()
            if not row or not self._owner_matches(row, owner_principal_id, client_id):
                raise KeyError("Assignment not found")
            if row["revision"] != expected_revision:
                raise RuntimeError("Stale assignment revision")
            active = db.execute("SELECT * FROM job_tasks WHERE assignment=? AND state IN ('reserved','starting','running','awaiting_output','ambiguous','cancel_pending')", (assignment_id,)).fetchall()
            for task in active:
                if task["state"] == "ambiguous":
                    continue
                # A chat may already have reached the provider; retain ownership and stop future observation.
                db.execute("UPDATE job_tasks SET state='cancel_pending' WHERE assignment=? AND task_id=? AND generation=?", (assignment_id, task["task_id"], task["generation"]))
                db.execute("UPDATE job_tasks SET generation=generation+1 WHERE assignment=? AND task_id=? AND generation=?", (assignment_id, task["task_id"], task["generation"]))
                db.execute("UPDATE operations SET state='ambiguous',error_class='CancelledAfterDispatch' WHERE assignment=? AND task_id=? AND generation=? AND state IN ('queued','claimed')", (assignment_id, task["task_id"], task["generation"]))
            db.execute("UPDATE job_tasks SET state='cancelled' WHERE assignment=? AND state IN ('queued','retry_due')", (assignment_id,))
            db.execute("UPDATE assignments SET state='cancelled',revision=revision+1 WHERE id=?", (assignment_id,))
            self._event(db, assignment_id, "assignment_cancelled", {"state": "cancelled"}, when)
            return self._receipt(db.execute("SELECT * FROM assignments WHERE id=?", (assignment_id,)).fetchone())
