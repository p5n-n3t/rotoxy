"""Durable, receipt-safe handoff from Agent Workspace messages to a worker.

This module deliberately does not contact a provider.  It records the identity
that an outer delivery adapter must use and makes the dangerous boundary
explicit: persist an ambiguous reservation *before* attempting an upstream
send.  A crash after that reservation is therefore an ambiguous delivery, not
permission to send a duplicate instruction.

Only a message correlated to an existing GuidanceInbox event and monitor
registration can enter the ledger.  Native provider approvals are recorded as
operator-only rejections; this bridge never attempts to answer them.
"""
from __future__ import annotations

from contextlib import closing
import argparse
from hashlib import sha256
import json
import os
import re
import sqlite3
import stat
import sys
import time
from pathlib import Path

from .guidance import identity


HASH_RE = re.compile(r"^[a-f0-9]{64}$")
OUTCOMES = {"accepted", "rejected", "ambiguous"}
MAX_REASON = 128
MAX_CLI_INPUT_BYTES = 8 * 1024


class WorkspaceDeliveryError(ValueError):
    """A stable, non-sensitive rejection suitable for an administrative API."""


def _safe_existing_inbox_path(raw: str | os.PathLike[str]) -> Path:
    path = Path(raw)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise WorkspaceDeliveryError("guidance_inbox_unavailable")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise WorkspaceDeliveryError("guidance_inbox_unavailable")
    return path


def _safe_ledger_path(raw: str | os.PathLike[str]) -> Path:
    path = Path(raw)
    if not path.is_absolute() or path.name in {"", ".", ".."}:
        raise WorkspaceDeliveryError("invalid_ledger_path")
    parent = path.parent
    current = Path("/")
    for part in path.parts[1:-1]:
        current /= part
        if current.is_symlink():
            raise WorkspaceDeliveryError("unsafe_ledger_path")
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if parent.is_symlink() or not parent.is_dir() or stat.S_IMODE(parent.stat().st_mode) & 0o077:
        raise WorkspaceDeliveryError("unsafe_ledger_path")
    if path.is_symlink():
        raise WorkspaceDeliveryError("unsafe_ledger_path")
    if not path.exists():
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
    if path.is_symlink() or not path.is_file():
        raise WorkspaceDeliveryError("unsafe_ledger_path")
    os.chmod(path, 0o600)
    return path


def _reason(value: str, *, field: str) -> str:
    try:
        value = identity(value)
    except ValueError as error:
        raise WorkspaceDeliveryError("invalid_" + field) from error
    if len(value) > MAX_REASON:
        raise WorkspaceDeliveryError("invalid_" + field)
    return value


def _message_hash(value: str) -> str:
    if not isinstance(value, str) or not HASH_RE.fullmatch(value):
        raise WorkspaceDeliveryError("invalid_message_hash")
    return value


def _event_id(value: int) -> int:
    if type(value) is not int or value < 1:
        raise WorkspaceDeliveryError("invalid_guidance_event")
    return value


class WorkspaceDelivery:
    """A private idempotency ledger for a separately implemented delivery adapter.

    `prepare` binds the Agent Workspace message to the exact GuidanceInbox
    registration.  `claim_send` durably records uncertainty before an adapter
    can send.  `record_outcome` can subsequently reconcile that claim with an
    accepted or rejected provider receipt.  No method retries a claimed or
    ambiguous record.
    """

    def __init__(self, ledger_path: str | os.PathLike[str], inbox_path: str | os.PathLike[str]):
        self.path = _safe_ledger_path(ledger_path)
        self.inbox_path = _safe_existing_inbox_path(inbox_path)
        with closing(self._connect()) as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS workspace_deliveries(
                  project TEXT NOT NULL,
                  owner TEXT NOT NULL,
                  workspace_message_id TEXT NOT NULL,
                  guidance_event_id INTEGER NOT NULL,
                  worker TEXT NOT NULL,
                  account_id TEXT NOT NULL,
                  session_id TEXT NOT NULL,
                  model TEXT NOT NULL,
                  message_hash TEXT NOT NULL,
                  request_hash TEXT NOT NULL,
                  state TEXT NOT NULL,
                  outcome_code TEXT,
                  receipt_id TEXT,
                  send_claimed INTEGER NOT NULL DEFAULT 0,
                  created_at REAL NOT NULL,
                  updated_at REAL NOT NULL,
                  PRIMARY KEY(project,owner,workspace_message_id)
                );
                CREATE INDEX IF NOT EXISTS workspace_deliveries_event
                  ON workspace_deliveries(project,owner,guidance_event_id);
                """
            )

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=10000")
        return db

    def _read_binding(self, *, project: str, owner: str, worker: str, guidance_event_id: int) -> dict:
        uri = "file:" + self.inbox_path.as_posix() + "?mode=ro"
        try:
            with closing(sqlite3.connect(uri, uri=True, timeout=10)) as db:
                db.row_factory = sqlite3.Row
                registration = db.execute(
                    "SELECT project,owner,account_id,session_id,model FROM monitor_registrations "
                    "WHERE id=? AND project=? AND owner=?",
                    (worker, project, owner),
                ).fetchone()
                event = db.execute(
                    "SELECT worker,kind,model,owner,job,account_id,session_id,question_json "
                    "FROM guidance_events WHERE id=? AND worker=? AND job=? AND owner=?",
                    (guidance_event_id, worker, project, owner),
                ).fetchone()
        except sqlite3.Error as error:
            raise WorkspaceDeliveryError("guidance_inbox_unavailable") from error
        if registration is None:
            raise WorkspaceDeliveryError("worker_registration_missing")
        if event is None:
            raise WorkspaceDeliveryError("guidance_event_not_owned")
        result = dict(registration)
        result["nativeApproval"] = event["kind"] == "needs_approval"
        # A registration added after an event must not be used to retrofit a
        # provider route.  Account/session identity must be present at event
        # observation time and agree exactly with the registration.
        if event["account_id"] != result["account_id"] or event["session_id"] != result["session_id"]:
            result["eventBindingComplete"] = False
        else:
            result["eventBindingComplete"] = True
        return result

    def _read_binding_by_event(self, *, project: str, guidance_event_id: int) -> tuple[str, str, dict]:
        """Resolve the owner and worker only from the durable GuidanceInbox rows."""
        uri = "file:" + self.inbox_path.as_posix() + "?mode=ro"
        try:
            with closing(sqlite3.connect(uri, uri=True, timeout=10)) as db:
                db.row_factory = sqlite3.Row
                rows = db.execute(
                    "SELECT e.worker,e.owner,e.kind,e.account_id AS event_account_id,e.session_id AS event_session_id,"
                    "r.project,r.owner AS registered_owner,r.account_id,r.session_id,r.model "
                    "FROM guidance_events e JOIN monitor_registrations r "
                    "ON r.id=e.worker AND r.project=e.job AND r.owner=e.owner "
                    "WHERE e.id=? AND e.job=?",
                    (guidance_event_id, project),
                ).fetchall()
        except sqlite3.Error as error:
            raise WorkspaceDeliveryError("guidance_inbox_unavailable") from error
        if len(rows) != 1:
            raise WorkspaceDeliveryError("guidance_event_not_owned")
        row = rows[0]
        if row["registered_owner"] != row["owner"] or row["project"] != project:
            raise WorkspaceDeliveryError("guidance_event_not_owned")
        binding = {
            "project": row["project"], "owner": row["owner"], "account_id": row["account_id"],
            "session_id": row["session_id"], "model": row["model"],
            "nativeApproval": row["kind"] == "needs_approval",
            "eventBindingComplete": row["event_account_id"] == row["account_id"] and row["event_session_id"] == row["session_id"],
        }
        return row["owner"], row["worker"], binding

    @staticmethod
    def _row_view(row: sqlite3.Row, *, may_send: bool = False) -> dict:
        return {
            "project": row["project"],
            "owner": row["owner"],
            "workspaceMessageId": row["workspace_message_id"],
            "guidanceEventId": row["guidance_event_id"],
            "worker": row["worker"],
            "accountId": row["account_id"],
            "sessionId": row["session_id"],
            "model": row["model"],
            "state": row["state"],
            "outcomeCode": row["outcome_code"],
            "receiptId": row["receipt_id"],
            "maySend": may_send,
        }

    @staticmethod
    def _request_hash(*, project: str, owner: str, message_id: str, event_id: int, worker: str, message_hash: str) -> str:
        material = "\x1f".join((project, owner, message_id, str(event_id), worker, message_hash))
        return sha256(material.encode("utf-8")).hexdigest()

    def prepare(
        self,
        *,
        project: str,
        owner: str,
        workspace_message_id: str,
        guidance_event_id: int,
        worker: str,
        message_hash: str,
        now: float | None = None,
    ) -> dict:
        project, owner, workspace_message_id, worker = map(identity, (project, owner, workspace_message_id, worker))
        guidance_event_id, message_hash = _event_id(guidance_event_id), _message_hash(message_hash)
        now = time.time() if now is None else now
        if type(now) not in {int, float}:
            raise WorkspaceDeliveryError("invalid_time")
        request_hash = self._request_hash(
            project=project, owner=owner, message_id=workspace_message_id,
            event_id=guidance_event_id, worker=worker, message_hash=message_hash,
        )
        binding = self._read_binding(project=project, owner=owner, worker=worker, guidance_event_id=guidance_event_id)
        return self._prepare_bound(
            project=project, owner=owner, workspace_message_id=workspace_message_id,
            guidance_event_id=guidance_event_id, worker=worker, message_hash=message_hash,
            request_hash=request_hash, binding=binding, now=now,
        )

    def prepare_by_event(
        self,
        *,
        project: str,
        workspace_message_id: str,
        guidance_event_id: int,
        message_hash: str,
        now: float | None = None,
    ) -> dict:
        """Prepare a delivery without accepting owner, worker, account, or session input."""
        project, workspace_message_id = map(identity, (project, workspace_message_id))
        guidance_event_id, message_hash = _event_id(guidance_event_id), _message_hash(message_hash)
        now = time.time() if now is None else now
        if type(now) not in {int, float}:
            raise WorkspaceDeliveryError("invalid_time")
        owner, worker, binding = self._read_binding_by_event(project=project, guidance_event_id=guidance_event_id)
        request_hash = self._request_hash(
            project=project, owner=owner, message_id=workspace_message_id,
            event_id=guidance_event_id, worker=worker, message_hash=message_hash,
        )
        return self._prepare_bound(
            project=project, owner=owner, workspace_message_id=workspace_message_id,
            guidance_event_id=guidance_event_id, worker=worker, message_hash=message_hash,
            request_hash=request_hash, binding=binding, now=now,
        )

    def _prepare_bound(
        self,
        *,
        project: str,
        owner: str,
        workspace_message_id: str,
        guidance_event_id: int,
        worker: str,
        message_hash: str,
        request_hash: str,
        binding: dict,
        now: float,
    ) -> dict:
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT * FROM workspace_deliveries WHERE project=? AND owner=? AND workspace_message_id=?",
                (project, owner, workspace_message_id),
            ).fetchone()
            if existing:
                if existing["request_hash"] != request_hash:
                    raise WorkspaceDeliveryError("idempotency_conflict")
                db.execute("COMMIT")
                # Preparation does not authorize an upstream request.  The
                # caller must use claim_send, which durably fences one send.
                return self._row_view(existing, may_send=False)
            state, code = "pending", None
            if binding["nativeApproval"]:
                state, code = "rejected", "native_approval_requires_operator"
            elif not binding["eventBindingComplete"]:
                state, code = "rejected", "guidance_event_binding_incomplete"
            db.execute(
                "INSERT INTO workspace_deliveries(project,owner,workspace_message_id,guidance_event_id,worker,account_id,session_id,model,message_hash,request_hash,state,outcome_code,receipt_id,send_claimed,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (project, owner, workspace_message_id, guidance_event_id, worker, binding["account_id"],
                 binding["session_id"], binding["model"], message_hash, request_hash, state, code, None, 0, now, now),
            )
            row = db.execute(
                "SELECT * FROM workspace_deliveries WHERE project=? AND owner=? AND workspace_message_id=?",
                (project, owner, workspace_message_id),
            ).fetchone()
            db.execute("COMMIT")
            return self._row_view(row, may_send=False)
        except BaseException:
            db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    def claim_send(self, *, project: str, owner: str, workspace_message_id: str, now: float | None = None) -> dict:
        """Reserve one send by turning it ambiguous before any provider call."""
        project, owner, workspace_message_id = map(identity, (project, owner, workspace_message_id))
        now = time.time() if now is None else now
        if type(now) not in {int, float}:
            raise WorkspaceDeliveryError("invalid_time")
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM workspace_deliveries WHERE project=? AND owner=? AND workspace_message_id=?",
                (project, owner, workspace_message_id),
            ).fetchone()
            if row is None:
                raise WorkspaceDeliveryError("delivery_not_found")
            if row["state"] != "pending":
                db.execute("COMMIT")
                return self._row_view(row, may_send=False)
            db.execute(
                "UPDATE workspace_deliveries SET state='ambiguous',outcome_code='send_receipt_pending',send_claimed=1,updated_at=? "
                "WHERE project=? AND owner=? AND workspace_message_id=? AND state='pending'",
                (now, project, owner, workspace_message_id),
            )
            row = db.execute(
                "SELECT * FROM workspace_deliveries WHERE project=? AND owner=? AND workspace_message_id=?",
                (project, owner, workspace_message_id),
            ).fetchone()
            db.execute("COMMIT")
            return self._row_view(row, may_send=True)
        except BaseException:
            db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    def record_outcome(
        self,
        *,
        project: str,
        owner: str,
        workspace_message_id: str,
        outcome: str,
        outcome_code: str,
        receipt_id: str | None = None,
        now: float | None = None,
    ) -> dict:
        """Record one terminal provider outcome without issuing a provider request."""
        project, owner, workspace_message_id = map(identity, (project, owner, workspace_message_id))
        if outcome not in OUTCOMES:
            raise WorkspaceDeliveryError("invalid_outcome")
        outcome_code = _reason(outcome_code, field="outcome_code")
        if outcome == "accepted":
            if receipt_id is None:
                raise WorkspaceDeliveryError("accepted_receipt_required")
            receipt_id = _reason(receipt_id, field="receipt_id")
        elif receipt_id is not None:
            raise WorkspaceDeliveryError("receipt_not_allowed")
        now = time.time() if now is None else now
        if type(now) not in {int, float}:
            raise WorkspaceDeliveryError("invalid_time")
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM workspace_deliveries WHERE project=? AND owner=? AND workspace_message_id=?",
                (project, owner, workspace_message_id),
            ).fetchone()
            if row is None:
                raise WorkspaceDeliveryError("delivery_not_found")
            same = row["state"] == outcome and row["outcome_code"] == outcome_code and row["receipt_id"] == receipt_id
            if same:
                db.execute("COMMIT")
                return self._row_view(row)
            if row["state"] in {"accepted", "rejected"}:
                raise WorkspaceDeliveryError("outcome_already_recorded")
            if row["state"] == "pending":
                if outcome == "accepted":
                    raise WorkspaceDeliveryError("delivery_not_claimed")
                db.execute(
                    "UPDATE workspace_deliveries SET state=?,outcome_code=?,receipt_id=NULL,updated_at=? "
                    "WHERE project=? AND owner=? AND workspace_message_id=?",
                    (outcome, outcome_code, now, project, owner, workspace_message_id),
                )
            elif row["state"] == "ambiguous":
                if not row["send_claimed"]:
                    raise WorkspaceDeliveryError("ambiguous_delivery_not_retryable")
                db.execute(
                    "UPDATE workspace_deliveries SET state=?,outcome_code=?,receipt_id=?,updated_at=? "
                    "WHERE project=? AND owner=? AND workspace_message_id=?",
                    (outcome, outcome_code, receipt_id, now, project, owner, workspace_message_id),
                )
            else:
                raise WorkspaceDeliveryError("invalid_delivery_state")
            row = db.execute(
                "SELECT * FROM workspace_deliveries WHERE project=? AND owner=? AND workspace_message_id=?",
                (project, owner, workspace_message_id),
            ).fetchone()
            db.execute("COMMIT")
            return self._row_view(row)
        except BaseException:
            db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    def get(self, *, project: str, owner: str, workspace_message_id: str) -> dict | None:
        project, owner, workspace_message_id = map(identity, (project, owner, workspace_message_id))
        with closing(self._connect()) as db:
            row = db.execute(
                "SELECT * FROM workspace_deliveries WHERE project=? AND owner=? AND workspace_message_id=?",
                (project, owner, workspace_message_id),
            ).fetchone()
        return self._row_view(row) if row else None


def _cli_request() -> dict:
    raw = sys.stdin.buffer.read(MAX_CLI_INPUT_BYTES + 1)
    if len(raw) > MAX_CLI_INPUT_BYTES:
        raise WorkspaceDeliveryError("invalid_request")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WorkspaceDeliveryError("invalid_request") from error
    if not isinstance(value, dict):
        raise WorkspaceDeliveryError("invalid_request")
    return value


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", required=True)
    parser.add_argument("--inbox", required=True)
    args = parser.parse_args()
    try:
        request = _cli_request()
        if set(request) != {"command", "project", "workspaceMessageId", "guidanceEventId", "messageHash"} or request.get("command") != "prepare-by-event":
            raise WorkspaceDeliveryError("invalid_request")
        result = WorkspaceDelivery(args.ledger, args.inbox).prepare_by_event(
            project=request["project"], workspace_message_id=request["workspaceMessageId"],
            guidance_event_id=request["guidanceEventId"], message_hash=request["messageHash"],
        )
        print(json.dumps(result, separators=(",", ":"), sort_keys=True))
        return 0
    except WorkspaceDeliveryError as error:
        print(json.dumps({"error": str(error)}, separators=(",", ":")))
        return 2
    except Exception:
        print('{"error":"workspace_delivery_failed"}')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
