"""AW1 durable, project-scoped agent workspace store.

The Node gateway is the trust boundary. This private CLI accepts one JSON
request on stdin and emits one bounded JSON result; it does not contact agents
or providers.
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

MAX_ID = 128
MAX_TEXT = 2_000
MAX_DESCRIPTION = 8_000
MAX_PAGE = 100
MAX_INPUT_BYTES = 64 * 1024
ADMIN = "admin:local"
ID_RE = re.compile(r"^[A-Za-z0-9_.:@-]+$")
SECRET_PATTERNS = (
    (re.compile(r"(?i)\bBasic\s+[A-Za-z0-9+/=_-]{4,}"), "Basic [REDACTED]"),
    (re.compile(r"(?i)(https?://)[^\s/@:]+:[^\s/@]+@"), r"\1[REDACTED]@"),
    (re.compile(r'(?i)("(?:access_token|refresh_token|api_key|password|secret)"\s*:\s*")[^"]*(")'), r"\1[REDACTED]\2"),
    (re.compile(r"(?i)\bBearer\s+\S+"), "Bearer [REDACTED]"),
    (re.compile(r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b"), "[REDACTED]"),
    (re.compile(r"\blsat_[A-Za-z0-9_-]+\b"), "[REDACTED]"),
    (re.compile(r"(?i)\b((?:access_|refresh_)?token|api[_-]?key|password|secret)=([^\s&]+)"), r"\1=[REDACTED]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*"), "[REDACTED]"),
)


class WorkspaceError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _text(value, limit: int, code: str = "invalid_input") -> str:
    if not isinstance(value, str) or not value or len(value) > limit or "\x00" in value:
        raise WorkspaceError(code)
    return value


def _id(value, name="id") -> str:
    value = _text(value, MAX_ID)
    if not ID_RE.fullmatch(value):
        raise WorkspaceError("invalid_" + name)
    return value


def _clean_text(value: str, limit: int) -> str:
    value = "".join(" " if ord(c) < 32 or 0x7f <= ord(c) <= 0x9f else c for c in value)
    value = value.strip()
    for pattern, replacement in SECRET_PATTERNS:
        value = pattern.sub(replacement, value)
    return value[:limit]


def _actor(value) -> str:
    value = _id(value, "actor")
    if value != ADMIN and not value.startswith("client:"):
        raise WorkspaceError("invalid_actor")
    if value == "client:":
        raise WorkspaceError("invalid_actor")
    return value


def _object(value, required, optional=()):
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - set(optional):
        raise WorkspaceError("invalid_input")


def _safe_db_path(raw: str) -> Path:
    path = Path(raw)
    if not path.is_absolute() or path.name in {"", ".", ".."}:
        raise WorkspaceError("invalid_database_path")
    parent = path.parent
    current = Path("/")
    for part in path.parts[1:-1]:
        current /= part
        if current.is_symlink():
            raise WorkspaceError("unsafe_database_path")
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if parent.is_symlink() or not parent.is_dir():
        raise WorkspaceError("unsafe_database_path")
    if stat.S_IMODE(parent.stat().st_mode) & 0o077:
        raise WorkspaceError("unsafe_database_path")
    if path.is_symlink():
        raise WorkspaceError("unsafe_database_path")
    if not path.exists():
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
    if path.is_symlink() or not path.is_file():
        raise WorkspaceError("unsafe_database_path")
    os.chmod(path, 0o600)
    return path


class AgentWorkspace:
    def __init__(self, db_path: str | os.PathLike[str]):
        self.path = _safe_db_path(os.fspath(db_path))
        with self._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS workspaces(project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS participants(
                    project_id TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, provider TEXT NOT NULL,
                    model TEXT, account_id TEXT, updated_at INTEGER NOT NULL,
                    PRIMARY KEY(project_id,id));
                CREATE TABLE IF NOT EXISTS tasks(
                    project_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
                    state TEXT NOT NULL, assignee TEXT, job_id TEXT, external_task_id TEXT,
                    depends_on TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY(project_id,id));
                CREATE TABLE IF NOT EXISTS messages(
                    project_id TEXT NOT NULL, id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
                    task_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL,
                    sender_provider TEXT, sender_model TEXT, sender_account_id TEXT, sender_label TEXT,
                    sender_context_source TEXT,
                    PRIMARY KEY(project_id,id));
                CREATE TABLE IF NOT EXISTS receipts(
                    project_id TEXT NOT NULL, message_id TEXT NOT NULL, actor TEXT NOT NULL, acked_at INTEGER NOT NULL,
                    PRIMARY KEY(project_id,message_id,actor));
                CREATE TABLE IF NOT EXISTS artifacts(
                    project_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL, submitter TEXT NOT NULL,
                    kind TEXT NOT NULL, reference TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
                    reviewer TEXT, decision TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY(project_id,id));
                CREATE TABLE IF NOT EXISTS events(
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
                    actor TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT, at INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS events_project_seq ON events(project_id,seq);
                CREATE TABLE IF NOT EXISTS replays(
                    project_id TEXT NOT NULL, actor TEXT NOT NULL, idem_key TEXT NOT NULL,
                    digest TEXT NOT NULL, result TEXT NOT NULL,
                    PRIMARY KEY(project_id,actor,idem_key));
            """)
            # Keep existing workspace databases usable without rewriting or
            # guessing provenance for messages sent before this schema existed.
            message_columns = {row["name"] for row in db.execute("PRAGMA table_info(messages)")}
            for name in ("sender_provider", "sender_model", "sender_account_id", "sender_label", "sender_context_source"):
                if name not in message_columns:
                    db.execute(f"ALTER TABLE messages ADD COLUMN {name} TEXT")

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=10000")
        return db

    @staticmethod
    def _revision(db, project: str) -> int:
        row = db.execute("SELECT revision FROM workspaces WHERE project_id=?", (project,)).fetchone()
        return int(row["revision"]) if row else 0

    @staticmethod
    def _participant(db, project: str, actor: str) -> bool:
        return db.execute("SELECT 1 FROM participants WHERE project_id=? AND id=?", (project, actor)).fetchone() is not None

    @staticmethod
    def _event(db, project, revision, actor, kind, entity_id=None):
        cur = db.execute("INSERT INTO events(project_id,revision,actor,kind,entity_id,at) VALUES(?,?,?,?,?,?)",
                         (project, revision, actor, kind, entity_id, int(time.time() * 1000)))
        return int(cur.lastrowid)

    def snapshot(self, project_id: str, actor: str, after: int = 0) -> dict:
        project, actor = _id(project_id, "project_id"), _actor(actor)
        if type(after) is not int or after < 0:
            raise WorkspaceError("invalid_cursor")
        with self._connect() as db:
            revision = self._revision(db, project)
            participants = [dict(r) for r in db.execute(
                "SELECT id,label,provider,model,account_id AS accountId,updated_at AS updatedAt FROM participants WHERE project_id=? ORDER BY id LIMIT ?",
                (project, MAX_PAGE))]
            tasks = []
            for r in db.execute("SELECT * FROM tasks WHERE project_id=? ORDER BY updated_at DESC,id LIMIT ?", (project, MAX_PAGE)):
                tasks.append({"id": r["id"], "title": r["title"], "description": r["description"], "state": r["state"],
                              "assignee": r["assignee"], "jobId": r["job_id"], "externalTaskId": r["external_task_id"],
                              "dependsOn": json.loads(r["depends_on"]), "revision": r["revision"], "updatedAt": r["updated_at"]})
            msg_params: list[object] = [project, actor, actor]
            message_sql = "SELECT m.*, EXISTS(SELECT 1 FROM receipts r WHERE r.project_id=m.project_id AND r.message_id=m.id AND r.actor=?) AS acknowledged FROM messages m WHERE m.project_id=? AND (m.sender=? OR m.recipient='all' OR m.recipient=?)"
            msg_params = [actor, project, actor, actor]
            if actor == ADMIN:
                message_sql = "SELECT m.*, EXISTS(SELECT 1 FROM receipts r WHERE r.project_id=m.project_id AND r.message_id=m.id AND r.actor=?) AS acknowledged FROM messages m WHERE m.project_id=?"
                msg_params = [actor, project]
            messages = [{"id": r["id"], "sender": r["sender"], "recipient": r["recipient"], "taskId": r["task_id"],
                         "text": r["text"], "createdAt": r["created_at"], "acknowledged": bool(r["acknowledged"]),
                         "senderContext": self._sender_context(r)}
                        for r in db.execute(message_sql + " ORDER BY created_at DESC,id LIMIT ?", (*msg_params, MAX_PAGE))]
            artifacts = [self._artifact(r) for r in db.execute(
                "SELECT * FROM artifacts WHERE project_id=? ORDER BY created_at DESC,id LIMIT ?", (project, MAX_PAGE))]
            reviews = [item for item in artifacts if item["state"] == "pending"]
            event_rows = db.execute("SELECT seq,revision,actor,kind,entity_id AS entityId,at FROM events WHERE project_id=? AND seq>? ORDER BY seq LIMIT ?",
                                    (project, after, MAX_PAGE)).fetchall()
            events = [dict(r) for r in event_rows]
            next_cursor = events[-1]["seq"] if events else after
            return {"projectId": project, "revision": revision, "participants": participants, "tasks": tasks,
                    "messages": messages, "artifacts": artifacts, "reviews": reviews, "events": events,
                    "nextCursor": next_cursor}

    def read_message(self, project_id: str, actor: str, message_id: str) -> dict:
        """Return one immutable message without turning snapshot pagination into an authority boundary."""
        project, actor, message_id = _id(project_id, "project_id"), _actor(actor), _id(message_id, "message_id")
        with self._connect() as db:
            admin = actor == ADMIN
            participant = self._participant(db, project, actor)
            if not admin and not participant:
                # Do not disclose whether the project or its messages exist.
                raise WorkspaceError("message_not_found")
            if admin:
                row = db.execute(
                    "SELECT m.*, EXISTS(SELECT 1 FROM receipts r WHERE r.project_id=m.project_id AND r.message_id=m.id AND r.actor=?) AS acknowledged "
                    "FROM messages m WHERE m.project_id=? AND m.id=?",
                    (actor, project, message_id),
                ).fetchone()
            else:
                row = db.execute(
                    "SELECT m.*, EXISTS(SELECT 1 FROM receipts r WHERE r.project_id=m.project_id AND r.message_id=m.id AND r.actor=?) AS acknowledged "
                    "FROM messages m WHERE m.project_id=? AND m.id=? AND (m.sender=? OR m.recipient='all' OR m.recipient=?)",
                    (actor, project, message_id, actor, actor),
                ).fetchone()
            if row is None:
                raise WorkspaceError("message_not_found")
            # Messages are sanitized and bounded during message_send.  Treat a
            # malformed legacy row as absent instead of returning unbounded data.
            if not isinstance(row["text"], str) or not row["text"] or len(row["text"]) > MAX_TEXT:
                raise WorkspaceError("message_not_found")
            return {"id": row["id"], "sender": row["sender"], "recipient": row["recipient"],
                    "taskId": row["task_id"], "text": row["text"], "createdAt": row["created_at"],
                    "acknowledged": bool(row["acknowledged"]), "senderContext": self._sender_context(row)}

    @staticmethod
    def _sender_context(row):
        """Return only send-time reported sender metadata, or None for unknown history."""
        if not row["sender_context_source"]:
            return None
        return {"provider": row["sender_provider"], "model": row["sender_model"],
                "accountId": row["sender_account_id"], "label": row["sender_label"],
                "source": row["sender_context_source"]}

    @staticmethod
    def _artifact(row):
        return {"id": row["id"], "taskId": row["task_id"], "submitter": row["submitter"], "kind": row["kind"],
                "reference": row["reference"], "title": row["title"], "state": row["state"], "reviewer": row["reviewer"],
                "decision": row["decision"], "note": row["note"], "createdAt": row["created_at"], "updatedAt": row["updated_at"]}

    def update(self, project_id: str, actor: str, value: dict) -> dict:
        project, actor = _id(project_id, "project_id"), _actor(actor)
        if not isinstance(value, dict) or not isinstance(value.get("action"), str):
            raise WorkspaceError("invalid_input")
        action = value["action"]
        action_fields = {
            "participant_upsert": ({"label", "provider"}, {"model", "accountId"}),
            "task_create": ({"taskId", "title", "description"}, {"dependsOn", "jobId", "externalTaskId"}),
            "task_claim": ({"taskId"}, set()),
            "task_update": ({"taskId", "state"}, {"note"}),
            "message_send": ({"messageId", "to", "text"}, {"taskId"}),
            "message_ack": ({"messageId"}, set()),
            "artifact_submit": ({"artifactId", "taskId", "kind", "reference", "title"}, set()),
            "review_decide": ({"artifactId", "decision"}, {"note"}),
        }
        if action not in action_fields:
            raise WorkspaceError("unsupported_action")
        required, optional = action_fields[action]
        _object(value, {"action", "idempotencyKey", "expectedRevision"} | required,
                {"action", "idempotencyKey", "expectedRevision"} | optional)
        key = _text(value["idempotencyKey"], 200, "invalid_idempotency_key")
        expected = value["expectedRevision"]
        if type(expected) is not int or expected < 0:
            raise WorkspaceError("invalid_revision")
        digest = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                replay = db.execute("SELECT digest,result FROM replays WHERE project_id=? AND actor=? AND idem_key=?",
                                    (project, actor, key)).fetchone()
                if replay:
                    if replay["digest"] != digest:
                        raise WorkspaceError("idempotency_conflict")
                    db.execute("COMMIT")
                    return json.loads(replay["result"])
                revision = self._revision(db, project)
                if expected != revision:
                    raise WorkspaceError("revision_conflict")
                result_data, entity_id = self._apply(db, project, actor, action, value)
                revision += 1
                db.execute("INSERT INTO workspaces(project_id,revision) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision",
                           (project, revision))
                event_id = self._event(db, project, revision, actor, action, entity_id)
                result = {"projectId": project, "revision": revision, "eventId": event_id, "action": action, "result": result_data}
                db.execute("INSERT INTO replays(project_id,actor,idem_key,digest,result) VALUES(?,?,?,?,?)",
                           (project, actor, key, digest, json.dumps(result, separators=(",", ":"))))
                db.execute("COMMIT")
                return result
            except Exception:
                db.execute("ROLLBACK")
                raise

    def _apply(self, db, project: str, actor: str, action: str, value: dict):
        now = int(time.time() * 1000)
        admin = actor == ADMIN
        participant = self._participant(db, project, actor)
        if action == "participant_upsert":
            label = _clean_text(_text(value["label"], 128), 128)
            provider = _clean_text(_text(value["provider"], 64), 64)
            model = _clean_text(_text(value["model"], 128), 128) if value.get("model") is not None else None
            account = _clean_text(_text(value["accountId"], 128), 128) if value.get("accountId") is not None else None
            db.execute("INSERT INTO participants(project_id,id,label,provider,model,account_id,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET label=excluded.label,provider=excluded.provider,model=excluded.model,account_id=excluded.account_id,updated_at=excluded.updated_at",
                       (project, actor, label, provider, model, account, now))
            return {"participantId": actor}, actor
        if not participant and not admin:
            raise WorkspaceError("participant_required")
        if action == "task_create":
            task_id = _id(value["taskId"], "task_id")
            title = _clean_text(_text(value["title"], 256), 256)
            description = _clean_text(_text(value["description"], MAX_DESCRIPTION), MAX_DESCRIPTION)
            deps = value.get("dependsOn", [])
            if not isinstance(deps, list) or len(deps) > 16 or any(not isinstance(dep, str) for dep in deps):
                raise WorkspaceError("invalid_dependencies")
            if len(set(deps)) != len(deps):
                raise WorkspaceError("invalid_dependencies")
            deps = [_id(dep, "dependency") for dep in deps]
            for dep in deps:
                row = db.execute("SELECT depends_on FROM tasks WHERE project_id=? AND id=?", (project, dep)).fetchone()
                if row is None:
                    raise WorkspaceError("dependency_not_found")
                seen, todo = set(), [dep]
                while todo:
                    current = todo.pop()
                    if current == task_id:
                        raise WorkspaceError("dependency_cycle")
                    if current not in seen:
                        seen.add(current)
                        child = db.execute("SELECT depends_on FROM tasks WHERE project_id=? AND id=?", (project, current)).fetchone()
                        if child:
                            todo.extend(json.loads(child["depends_on"]))
            for field in ("jobId", "externalTaskId"):
                if value.get(field) is not None:
                    _id(value[field], field)
            try:
                db.execute("INSERT INTO tasks(project_id,id,title,description,state,job_id,external_task_id,depends_on,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                           (project, task_id, title, description, "queued", value.get("jobId"), value.get("externalTaskId"), json.dumps(deps), self._revision(db, project) + 1, now))
            except sqlite3.IntegrityError:
                raise WorkspaceError("task_exists")
            return {"taskId": task_id, "state": "queued"}, task_id
        if action in {"task_claim", "task_update", "artifact_submit"}:
            task_id = _id(value["taskId"], "task_id")
            task = db.execute("SELECT * FROM tasks WHERE project_id=? AND id=?", (project, task_id)).fetchone()
            if not task:
                raise WorkspaceError("task_not_found")
        if action == "task_claim":
            if task["state"] != "queued":
                raise WorkspaceError("task_not_claimable")
            deps = json.loads(task["depends_on"])
            if deps:
                marks = ",".join("?" for _ in deps)
                rows = db.execute(f"SELECT id,state FROM tasks WHERE project_id=? AND id IN ({marks})", (project, *deps)).fetchall()
                if len(rows) != len(deps) or any(row["state"] != "complete" for row in rows):
                    raise WorkspaceError("dependencies_incomplete")
            db.execute("UPDATE tasks SET state='running',assignee=?,revision=?,updated_at=? WHERE project_id=? AND id=? AND state='queued'",
                       (actor, self._revision(db, project) + 1, now, project, task_id))
            return {"taskId": task_id, "state": "running", "assignee": actor}, task_id
        if action == "task_update":
            state = value["state"]
            if state not in {"running", "blocked", "cancelled"}:
                raise WorkspaceError("invalid_task_state")
            if state == "cancelled":
                if not admin:
                    raise WorkspaceError("admin_required")
            elif task["assignee"] != actor or task["state"] not in {"running", "blocked"}:
                raise WorkspaceError("assignee_required")
            if value.get("note") is not None:
                _clean_text(_text(value["note"], MAX_TEXT), MAX_TEXT)  # validate and redact, but keep event metadata body-free
            db.execute("UPDATE tasks SET state=?,revision=?,updated_at=? WHERE project_id=? AND id=?",
                       (state, self._revision(db, project) + 1, now, project, task_id))
            return {"taskId": task_id, "state": state}, task_id
        if action == "message_send":
            message_id = _id(value["messageId"], "message_id")
            to = value["to"]
            if to != "all":
                to = _actor(to)
                if not self._participant(db, project, to):
                    raise WorkspaceError("recipient_not_found")
            task_id = _id(value["taskId"], "task_id") if value.get("taskId") is not None else None
            if task_id and not db.execute("SELECT 1 FROM tasks WHERE project_id=? AND id=?", (project, task_id)).fetchone():
                raise WorkspaceError("task_not_found")
            text = _clean_text(_text(value["text"], MAX_TEXT), MAX_TEXT)
            sender = db.execute("SELECT label,provider,model,account_id FROM participants WHERE project_id=? AND id=?",
                                (project, actor)).fetchone()
            context = (sender["provider"], sender["model"], sender["account_id"], sender["label"], "participant_reported") if sender else (None, None, None, None, None)
            db.execute("INSERT INTO messages(project_id,id,sender,recipient,task_id,text,created_at,sender_provider,sender_model,sender_account_id,sender_label,sender_context_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                       (project, message_id, actor, to, task_id, text, now, *context))
            return {"messageId": message_id, "recipient": to}, message_id
        if action == "message_ack":
            message_id = _id(value["messageId"], "message_id")
            message = db.execute("SELECT sender,recipient FROM messages WHERE project_id=? AND id=?", (project, message_id)).fetchone()
            if not message:
                raise WorkspaceError("message_not_found")
            if message["sender"] == actor or message["recipient"] not in {"all", actor}:
                raise WorkspaceError("recipient_only")
            db.execute("INSERT OR IGNORE INTO receipts(project_id,message_id,actor,acked_at) VALUES(?,?,?,?)", (project, message_id, actor, now))
            return {"messageId": message_id, "acknowledged": True}, message_id
        if action == "artifact_submit":
            artifact_id = _id(value["artifactId"], "artifact_id")
            if task["assignee"] != actor or task["state"] not in {"running", "blocked"}:
                raise WorkspaceError("assignee_required")
            kind = value["kind"]
            if kind not in {"text", "branch", "pull_request"}:
                raise WorkspaceError("invalid_artifact_kind")
            reference = _clean_text(_text(value["reference"], 1_000), 1_000)
            title = _clean_text(_text(value["title"], 256), 256)
            if db.execute("SELECT 1 FROM artifacts WHERE project_id=? AND task_id=? AND state='pending'", (project, task_id)).fetchone():
                raise WorkspaceError("review_pending")
            db.execute("INSERT INTO artifacts(project_id,id,task_id,submitter,kind,reference,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)",
                       (project, artifact_id, task_id, actor, kind, reference, title, now, now))
            db.execute("UPDATE tasks SET state='review',revision=?,updated_at=? WHERE project_id=? AND id=?",
                       (self._revision(db, project) + 1, now, project, task_id))
            return {"artifactId": artifact_id, "taskId": task_id, "state": "pending"}, artifact_id
        if action == "review_decide":
            artifact_id = _id(value["artifactId"], "artifact_id")
            artifact = db.execute("SELECT * FROM artifacts WHERE project_id=? AND id=?", (project, artifact_id)).fetchone()
            if not artifact:
                raise WorkspaceError("artifact_not_found")
            task = db.execute("SELECT * FROM tasks WHERE project_id=? AND id=?", (project, artifact["task_id"])).fetchone()
            if not task or (actor == task["assignee"] and not admin):
                raise WorkspaceError("independent_reviewer_required")
            if not admin and not participant:
                raise WorkspaceError("participant_required")
            if artifact["state"] != "pending":
                raise WorkspaceError("review_already_decided")
            decision = value["decision"]
            if decision not in {"approved", "changes_requested"}:
                raise WorkspaceError("invalid_review_decision")
            note = _clean_text(_text(value["note"], MAX_TEXT), MAX_TEXT) if value.get("note") is not None else None
            db.execute("UPDATE artifacts SET state=?,reviewer=?,decision=?,note=?,updated_at=? WHERE project_id=? AND id=?",
                       (decision, actor, decision, note, now, project, artifact_id))
            state = "complete" if decision == "approved" else "blocked"
            db.execute("UPDATE tasks SET state=?,revision=?,updated_at=? WHERE project_id=? AND id=?",
                       (state, self._revision(db, project) + 1, now, project, task["id"]))
            return {"artifactId": artifact_id, "decision": decision, "taskId": task["id"], "taskState": state}, artifact_id
        raise WorkspaceError("unsupported_action")


def handle(db_path: str, request: dict) -> dict:
    if not isinstance(request, dict) or set(request) - {"command", "projectId", "actor", "after", "input"}:
        raise WorkspaceError("invalid_request")
    command = request.get("command")
    if command not in {"snapshot", "update"}:
        raise WorkspaceError("invalid_command")
    service = AgentWorkspace(db_path)
    if command == "snapshot":
        if set(request) - {"command", "projectId", "actor", "after"} or "projectId" not in request or "actor" not in request:
            raise WorkspaceError("invalid_request")
        return service.snapshot(request["projectId"], request["actor"], request.get("after", 0))
    if set(request) != {"command", "projectId", "actor", "input"}:
        raise WorkspaceError("invalid_request")
    return service.update(request["projectId"], request["actor"], request["input"])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    args = parser.parse_args(argv)
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        print(json.dumps({"error": "request_too_large"}, separators=(",", ":")))
        return 2
    try:
        request = json.loads(raw)
        result = handle(args.db, request)
        output = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        if len(output.encode("utf-8")) > 2 * 1024 * 1024:
            raise WorkspaceError("response_too_large")
        print(output)
        return 0
    except WorkspaceError as exc:
        print(json.dumps({"error": exc.code}, separators=(",", ":")))
    except (json.JSONDecodeError, UnicodeDecodeError):
        print('{"error":"invalid_json"}')
    except (sqlite3.Error, OSError):
        print('{"error":"storage_unavailable"}')
    except (TypeError, ValueError, KeyError, IndexError):
        print('{"error":"invalid_input"}')
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
