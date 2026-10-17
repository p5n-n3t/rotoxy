"""Durable single-use grants for a separately authorized local supervisor.

This store intentionally records that executor quota is *unknown*.  A grant is
an owner-issued controlled-batch authorization for exactly one bounded local
invocation; it is neither a provider quota reading nor a dollar reservation.
Claims are persisted before an external process is started and are never
returned to ``issued`` automatically.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
import uuid


IDENTITY = re.compile(r"[A-Za-z0-9_.:@/-]{1,160}\Z")
LOCAL_SESSION = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z")
EVENT_TYPES = {
    "idle", "idle_needs_review", "completed", "cancelled", "timed_out", "needs_approval",
    "needs_instructions", "failed", "stalled", "ambiguous", "quota_blocked", "ownership_unknown",
}
OUTCOMES = {"completed", "ambiguous", "rejected"}


class GrantError(ValueError):
    """A fixed, safe-to-display grant error."""


def _identity(value, name):
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        raise GrantError(f"invalid_{name}")
    return value


def _local_session(value):
    if not isinstance(value, str) or not LOCAL_SESSION.fullmatch(value):
        raise GrantError("invalid_executor_session")
    return value.lower()


def _finite_time(value, name):
    if type(value) not in {int, float} or not math.isfinite(value):
        raise GrantError(f"invalid_{name}")
    return float(value)


def _authorization(value):
    """Keep only explicit unknown-quota owner-controlled-batch metadata."""
    if not isinstance(value, dict) or set(value) != {"quota", "mode", "reference"}:
        raise GrantError("invalid_authorization")
    if value.get("quota") != "unknown" or value.get("mode") != "owner-controlled-batch":
        raise GrantError("invalid_authorization")
    reference = _identity(value.get("reference"), "authorization_reference")
    return {"quota": "unknown", "mode": "owner-controlled-batch", "reference": reference}


def _event_types(value):
    if not isinstance(value, list) or not value or len(value) > len(EVENT_TYPES):
        raise GrantError("invalid_event_types")
    normalized = []
    for item in value:
        if not isinstance(item, str) or item not in EVENT_TYPES or item in normalized:
            raise GrantError("invalid_event_types")
        normalized.append(item)
    return normalized


def _safe_receipt(value):
    """Store process metadata only; no prompts, output, costs, or transcripts."""
    if not isinstance(value, dict):
        return {}
    safe = {}
    for key in ("adapter", "state", "code"):
        item = value.get(key)
        if isinstance(item, str) and len(item) <= 160 and re.fullmatch(r"[A-Za-z0-9_.:@/-]*", item):
            safe[key] = item
    for key in ("exitCode", "elapsedMs"):
        item = value.get(key)
        if type(item) is int and -255 <= item <= 2**31:
            safe[key] = item
    return safe


class SupervisorGrantStore:
    """SQLite-backed one-shot supervisor invocation grants.

    Issue/claim/finish is deliberately separate from recovery dispatch.  The
    caller must still authenticate the owner before calling ``issue``.
    """

    def __init__(self, path, *, clock=time.time, id_factory=lambda: str(uuid.uuid4())):
        requested = Path(path).absolute()
        requested.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        parent = requested.parent.lstat()
        if (stat.S_ISLNK(parent.st_mode) or not stat.S_ISDIR(parent.st_mode) or
                parent.st_uid != os.geteuid() or parent.st_mode & 0o077):
            raise GrantError("unsafe_grant_directory")
        self.path = requested
        self._prepare_private_path()
        self.clock = clock
        self.id_factory = id_factory
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS supervisor_grants(
                    grant_id TEXT PRIMARY KEY,
                    project TEXT NOT NULL,
                    owner TEXT NOT NULL,
                    remote_session TEXT NOT NULL,
                    executor TEXT NOT NULL,
                    executor_session TEXT NOT NULL,
                    event_types TEXT NOT NULL,
                    authorization TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    max_runtime_seconds INTEGER NOT NULL,
                    max_invocations INTEGER NOT NULL CHECK(max_invocations=1),
                    state TEXT NOT NULL CHECK(state IN ('issued','claimed','completed','ambiguous','rejected','expired')),
                    claim_id TEXT UNIQUE,
                    claimed_event_type TEXT,
                    issued_at REAL NOT NULL,
                    claimed_at REAL,
                    finished_at REAL,
                    receipt TEXT
                );
                CREATE INDEX IF NOT EXISTS supervisor_grants_scope
                    ON supervisor_grants(project,owner,remote_session,executor,executor_session,state);
            """)

    def _prepare_private_path(self):
        """Create a private DB or reject an unsafe existing path before SQLite opens it."""
        try:
            info = self.path.lstat()
        except FileNotFoundError:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                info = os.fstat(fd)
            finally:
                os.close(fd)
        else:
            if (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                    info.st_mode & 0o077):
                raise GrantError("unsafe_grant_path")
            fd = os.open(self.path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
            try:
                opened = os.fstat(fd)
                if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.geteuid() or opened.st_mode & 0o077):
                    raise GrantError("unsafe_grant_path")
            finally:
                os.close(fd)
            return
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise GrantError("unsafe_grant_path")

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    def issue(self, *, project, owner, remote_session, executor, executor_session, allowed_event_types,
              expires_at, max_runtime_seconds, max_invocations, authorization):
        project = _identity(project, "project")
        owner = _identity(owner, "owner")
        remote_session = _identity(remote_session, "remote_session")
        executor = _identity(executor, "executor")
        executor_session = _local_session(executor_session)
        event_types = _event_types(allowed_event_types)
        expires_at = _finite_time(expires_at, "expiry")
        if expires_at <= self.clock() or expires_at > self.clock() + 86400:
            raise GrantError("invalid_expiry")
        if type(max_runtime_seconds) is not int or not 1 <= max_runtime_seconds <= 300:
            raise GrantError("invalid_max_runtime")
        # Grants are intentionally one-shot.  A larger number would imply an
        # automatic replay policy this durable store is designed to forbid.
        if type(max_invocations) is not int or max_invocations != 1:
            raise GrantError("invalid_max_invocations")
        authorization = _authorization(authorization)
        grant_id = self.id_factory()
        try:
            grant_id = str(uuid.UUID(grant_id))
        except (ValueError, TypeError, AttributeError):
            raise GrantError("grant_id_unavailable") from None
        now = self.clock()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("INSERT INTO supervisor_grants VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                    grant_id, project, owner, remote_session, executor, executor_session,
                    json.dumps(event_types, separators=(",", ":")), json.dumps(authorization, separators=(",", ":")),
                    expires_at, max_runtime_seconds, 1, "issued", None, None, now, None, None, None,
                ))
                db.commit()
            except BaseException:
                db.rollback()
                raise
        return self.get(grant_id)

    def claim(self, *, grant_id, project, owner, remote_session, executor, executor_session, event_type):
        grant_id = _grant_id(grant_id)
        binding = (_identity(project, "project"), _identity(owner, "owner"), _identity(remote_session, "remote_session"),
                   _identity(executor, "executor"), _local_session(executor_session))
        if not isinstance(event_type, str) or event_type not in EVENT_TYPES:
            raise GrantError("event_not_authorized")
        now = self.clock()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute("SELECT * FROM supervisor_grants WHERE grant_id=?", (grant_id,)).fetchone()
                if not row:
                    raise GrantError("grant_not_found")
                if tuple(row[key] for key in ("project", "owner", "remote_session", "executor", "executor_session")) != binding:
                    raise GrantError("grant_scope_mismatch")
                if event_type not in json.loads(row["event_types"]):
                    raise GrantError("event_not_authorized")
                if row["state"] == "issued" and row["expires_at"] <= now:
                    db.execute("UPDATE supervisor_grants SET state='expired',finished_at=? WHERE grant_id=?", (now, grant_id))
                    db.commit()
                    raise GrantError("grant_expired")
                if row["state"] != "issued":
                    raise GrantError("grant_already_claimed")
                claim_id = str(uuid.uuid4())
                if db.execute("UPDATE supervisor_grants SET state='claimed',claim_id=?,claimed_event_type=?,claimed_at=? WHERE grant_id=? AND state='issued'", (claim_id, event_type, now, grant_id)).rowcount != 1:
                    raise GrantError("grant_already_claimed")
                db.commit()
            except BaseException:
                db.rollback()
                raise
        return self._claim_view(self.get(grant_id))

    def finish(self, *, grant_id, claim_id, outcome, receipt=None):
        grant_id = _grant_id(grant_id)
        claim_id = _claim_id(claim_id)
        if outcome not in OUTCOMES:
            raise GrantError("invalid_outcome")
        safe_receipt = _safe_receipt(receipt)
        encoded = json.dumps(safe_receipt, sort_keys=True, separators=(",", ":"))
        now = self.clock()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute("SELECT * FROM supervisor_grants WHERE grant_id=?", (grant_id,)).fetchone()
                if not row or row["claim_id"] != claim_id:
                    raise GrantError("grant_claim_not_found")
                if row["state"] == "claimed":
                    db.execute("UPDATE supervisor_grants SET state=?,finished_at=?,receipt=? WHERE grant_id=? AND claim_id=? AND state='claimed'",
                               (outcome, now, encoded, grant_id, claim_id))
                    db.commit()
                elif row["state"] == outcome and (row["receipt"] or "{}") == encoded:
                    db.commit()
                else:
                    raise GrantError("grant_already_finished")
            except BaseException:
                db.rollback()
                raise
        return self.get(grant_id)

    def get(self, grant_id):
        grant_id = _grant_id(grant_id)
        with self.connection() as db:
            row = db.execute("SELECT * FROM supervisor_grants WHERE grant_id=?", (grant_id,)).fetchone()
        if not row:
            raise GrantError("grant_not_found")
        return self._view(row)

    @staticmethod
    def _view(row):
        return {
            "grantId": row["grant_id"], "project": row["project"], "owner": row["owner"],
            "remoteSession": row["remote_session"], "executor": row["executor"],
            "executorSession": row["executor_session"], "allowedEventTypes": json.loads(row["event_types"]),
            "authorization": json.loads(row["authorization"]), "expiresAt": row["expires_at"],
            "maxRuntimeSeconds": row["max_runtime_seconds"], "maxInvocations": row["max_invocations"],
            "state": row["state"], "claimId": row["claim_id"], "claimedEventType": row["claimed_event_type"],
            "issuedAt": row["issued_at"], "claimedAt": row["claimed_at"], "finishedAt": row["finished_at"],
            "receipt": json.loads(row["receipt"]) if row["receipt"] else None,
        }

    @staticmethod
    def _claim_view(grant):
        return {key: grant[key] for key in (
            "grantId", "project", "owner", "remoteSession", "executor", "executorSession",
            "state", "claimId", "claimedEventType", "maxRuntimeSeconds", "expiresAt", "authorization",
        )}


def _grant_id(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise GrantError("invalid_grant_id") from None


def _claim_id(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise GrantError("invalid_claim_id") from None
