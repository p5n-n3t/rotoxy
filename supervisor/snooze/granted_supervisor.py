"""One explicit, grant-gated pass from a GuidanceInbox event to HeadlessCodex.

This module is deliberately not a daemon or a scheduler.  A caller must supply
one durable event id and one pre-issued invocation grant.  Worker identity is
derived again from GuidanceInbox registrations; event payload fields never pick
an account, remote session, executor, executable, or local Codex session.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import time

from snooze.guidance import GuidanceInbox
from snooze.headless import CODEX_SESSION, HeadlessCodex, REMOTE_SESSION, _sanitize_advisory
from snooze.supervisor_grants import GrantError, SupervisorGrantStore


IDENTITY = re.compile(r"[A-Za-z0-9_.:@/-]{1,160}\Z")
RESULT_STATES = {"completed", "ambiguous", "rejected", "handoff"}


class GrantedSupervisorError(ValueError):
    """A fixed coordinator error that is safe to surface in local diagnostics."""


def _identity(value, name):
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        raise GrantedSupervisorError(f"invalid_{name}")
    return value


def _event_id(value):
    if type(value) is not int or value < 1:
        raise GrantedSupervisorError("invalid_event_id")
    return value


def _private_directory(path, *, create=False):
    if create:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if (stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or
            info.st_uid != os.geteuid() or info.st_mode & 0o077):
        raise GrantedSupervisorError("private_directory_required")


def _private_file(path):
    info = path.lstat()
    if (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or
            info.st_uid != os.geteuid() or info.st_mode & 0o077):
        raise GrantedSupervisorError("private_config_required")


def _safe_adapter_receipt(value):
    """Keep metadata only; HeadlessCodex is the sole advisory-text producer."""
    if not isinstance(value, dict):
        return {}
    safe = {}
    for key in ("adapter", "state"):
        item = value.get(key)
        if isinstance(item, str) and len(item) <= 160 and re.fullmatch(r"[A-Za-z0-9_.:@/-]*", item):
            safe[key] = item
    for source, target in (("exit_code", "exitCode"), ("elapsed_ms", "elapsedMs"), ("bytes", "bytes")):
        item = value.get(source)
        if type(item) is int and -255 <= item <= 2**31:
            safe[target] = item
    return safe


class GrantedSupervisor:
    """Run an allowlisted local Codex advisory once after a durable grant claim."""

    def __init__(self, *, inbox_path, grants_path, results_path, executable, project_dir, codex_home,
                 sessions, timeout_seconds=120, clock=time.time):
        self.inbox = GuidanceInbox(inbox_path)
        self.grants = SupervisorGrantStore(grants_path, clock=clock)
        self.results_path = Path(results_path).absolute()
        _private_directory(self.results_path.parent, create=True)
        self._prepare_result_path()
        self.clock = clock
        if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 300:
            raise GrantedSupervisorError("invalid_timeout")
        mappings, codex_sessions = self._mappings(sessions)
        self.mappings = mappings
        self.headless = HeadlessCodex(executable=executable, project_dir=project_dir, codex_home=codex_home,
                                      sessions=codex_sessions, timeout_seconds=timeout_seconds)
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS granted_supervisor_results(
                    event_id INTEGER PRIMARY KEY,
                    grant_id TEXT NOT NULL UNIQUE,
                    claim_id TEXT,
                    project TEXT NOT NULL,
                    owner TEXT NOT NULL,
                    remote_session TEXT NOT NULL,
                    executor TEXT NOT NULL,
                    executor_session TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    native_approval INTEGER NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('completed','ambiguous','rejected','handoff')),
                    reason TEXT,
                    advisory TEXT,
                    advisory_truncated INTEGER NOT NULL,
                    receipt TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
            """)

    def _prepare_result_path(self):
        """Create a private result database or reject an unsafe path before SQLite opens it."""
        try:
            info = self.results_path.lstat()
        except FileNotFoundError:
            fd = os.open(self.results_path, os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                info = os.fstat(fd)
            finally:
                os.close(fd)
        else:
            if (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                    info.st_mode & 0o077):
                raise GrantedSupervisorError("unsafe_result_path")
            fd = os.open(self.results_path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
            try:
                opened = os.fstat(fd)
                if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.geteuid() or opened.st_mode & 0o077):
                    raise GrantedSupervisorError("unsafe_result_path")
            finally:
                os.close(fd)
            return
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise GrantedSupervisorError("unsafe_result_path")

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.results_path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    @staticmethod
    def _mappings(raw):
        if not isinstance(raw, list) or not raw or len(raw) > 1000:
            raise GrantedSupervisorError("invalid_session_mappings")
        expected = {"project", "owner", "remoteSession", "executor", "executorSession", "codexSession"}
        mappings, codex_sessions = {}, {}
        for item in raw:
            if not isinstance(item, dict) or set(item) != expected:
                raise GrantedSupervisorError("invalid_session_mappings")
            project = _identity(item["project"], "project")
            owner = _identity(item["owner"], "owner")
            remote = item["remoteSession"]
            if not isinstance(remote, str) or not REMOTE_SESSION.fullmatch(remote):
                raise GrantedSupervisorError("invalid_session_mappings")
            executor = _identity(item["executor"], "executor")
            if executor != "codex-cli":
                raise GrantedSupervisorError("unsupported_executor")
            executor_session = item["executorSession"]
            codex_session = item["codexSession"]
            if (not isinstance(executor_session, str) or not CODEX_SESSION.fullmatch(executor_session) or
                    not isinstance(codex_session, str) or not CODEX_SESSION.fullmatch(codex_session) or
                    executor_session.lower() != codex_session.lower()):
                raise GrantedSupervisorError("invalid_session_mappings")
            key = (project, owner, remote, executor, executor_session.lower())
            if key in mappings or (project, owner, remote) in codex_sessions:
                raise GrantedSupervisorError("duplicate_session_mapping")
            mappings[key] = codex_session.lower()
            codex_sessions[(project, owner, remote)] = codex_session.lower()
        return mappings, codex_sessions

    def _source(self, event_id):
        rows = self.inbox.inbox(after=event_id - 1, limit=1)
        if not rows or rows[0]["id"] != event_id:
            raise GrantedSupervisorError("event_not_found")
        row = rows[0]
        registrations = {item["id"]: item for item in self.inbox.registrations()}
        registration = registrations.get(row["worker"])
        # Canonical events have no singular owner in guidance_events; their
        # authorization lives in viewer grants.  The durable worker
        # registration remains the authoritative source for a headless mapping.
        if (not registration or registration["project"] != row["job"] or
                (row["owner"] is not None and registration["owner"] != row["owner"]) or
                not registration["session_id"]):
            raise GrantedSupervisorError("trusted_registration_missing")
        return {
            "eventId": event_id,
            "project": registration["project"],
            "owner": registration["owner"],
            "remoteSession": registration["session_id"],
            "account": registration["account_id"],
            "eventType": row["kind"],
            "nativeApproval": row["kind"] == "needs_approval",
        }

    def _result(self, event_id):
        with self.connection() as db:
            row = db.execute("SELECT * FROM granted_supervisor_results WHERE event_id=?", (event_id,)).fetchone()
        return self._view(row) if row else None

    @staticmethod
    def _view(row):
        receipt = json.loads(row["receipt"])
        result = {
            "eventId": row["event_id"], "grantId": row["grant_id"], "claimId": row["claim_id"],
            "project": row["project"], "owner": row["owner"], "remoteSession": row["remote_session"],
            "executor": row["executor"], "executorSession": row["executor_session"],
            "eventType": row["event_type"], "nativeApproval": bool(row["native_approval"]),
            "state": row["state"], "reason": row["reason"], "advisory": row["advisory"],
            "advisoryOnly": row["advisory"] is not None, "advisoryTruncated": bool(row["advisory_truncated"]),
            "receipt": receipt,
        }
        return {key: value for key, value in result.items() if value is not None}

    def _persist(self, source, grant, *, state, reason=None, claim_id=None, advisory=None, advisory_truncated=False, receipt=None):
        if state not in RESULT_STATES:
            raise GrantedSupervisorError("invalid_result_state")
        advisory, sanitized_truncated = _sanitize_advisory(advisory)
        safe_receipt = _safe_adapter_receipt(receipt)
        encoded = json.dumps(safe_receipt, sort_keys=True, separators=(",", ":"))
        values = (source["eventId"], grant["grantId"], claim_id, source["project"], source["owner"], source["remoteSession"],
                  grant["executor"], grant["executorSession"], source["eventType"], int(source["nativeApproval"]),
                  state, reason, advisory, int(advisory_truncated or sanitized_truncated), encoded, self.clock())
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                prior = db.execute("SELECT * FROM granted_supervisor_results WHERE event_id=?", (source["eventId"],)).fetchone()
                if prior:
                    if prior["grant_id"] != grant["grantId"]:
                        raise GrantedSupervisorError("event_already_bound")
                    db.commit()
                    return self._view(prior)
                db.execute("INSERT INTO granted_supervisor_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", values)
                row = db.execute("SELECT * FROM granted_supervisor_results WHERE event_id=?", (source["eventId"],)).fetchone()
                db.commit()
                return self._view(row)
            except BaseException:
                db.rollback()
                raise

    def _ack(self, source):
        self.inbox.acknowledge(source["eventId"], owner=source["owner"], job=source["project"])

    def _finish(self, result):
        if result["state"] not in {"completed", "ambiguous", "rejected"} or not result.get("claimId"):
            return
        receipt = result.get("receipt", {})
        self.grants.finish(grant_id=result["grantId"], claim_id=result["claimId"], outcome=result["state"], receipt=receipt)

    def run_once(self, *, event_id, grant_id):
        """Process exactly one trusted inbox event and one already-issued grant."""
        event_id = _event_id(event_id)
        source = self._source(event_id)
        existing = self._result(event_id)
        if existing:
            if existing["grantId"] != grant_id:
                raise GrantedSupervisorError("event_already_bound")
            self._finish(existing)
            self._ack(source)
            return {**existing, "deduplicated": True}
        try:
            grant = self.grants.get(grant_id)
        except GrantError as exc:
            raise GrantedSupervisorError(str(exc)) from None
        binding = (source["project"], source["owner"], source["remoteSession"], grant["executor"], grant["executorSession"])
        if (grant["project"], grant["owner"], grant["remoteSession"], grant["executor"], grant["executorSession"]) != binding:
            result = self._persist(source, grant, state="handoff", reason="grant_scope_mismatch")
            self._ack(source)
            return result
        if binding not in self.mappings:
            result = self._persist(source, grant, state="handoff", reason="server_session_mapping_missing")
            self._ack(source)
            return result
        try:
            claim = self.grants.claim(grant_id=grant_id, project=source["project"], owner=source["owner"],
                                      remote_session=source["remoteSession"], executor=grant["executor"],
                                      executor_session=grant["executorSession"], event_type=source["eventType"])
        except GrantError as exc:
            if str(exc) == "grant_already_claimed":
                latest = self.grants.get(grant_id)
                result = self._persist(source, grant, state="ambiguous", reason="grant_claim_uncertain", claim_id=latest.get("claimId"))
            else:
                result = self._persist(source, grant, state="handoff", reason=str(exc))
            self._ack(source)
            return result
        context = {
            "event_id": "guidance-" + str(source["eventId"]), "project": source["project"], "owner": source["owner"],
            "job": source["project"], "kind": source["eventType"], "severity": source["eventType"],
            "account": source["account"], "session": source["remoteSession"],
        }
        response = self.headless(context, claim["maxRuntimeSeconds"])
        state = {"accepted": "completed", "ambiguous": "ambiguous", "rejected": "rejected"}.get(response.get("state"), "ambiguous")
        adapter_receipt = response.get("receipt", {}) if isinstance(response, dict) else {}
        result = self._persist(source, grant, state=state, claim_id=claim["claimId"],
                               advisory=adapter_receipt.get("advisory") if isinstance(adapter_receipt, dict) else None,
                               advisory_truncated=bool(isinstance(adapter_receipt, dict) and adapter_receipt.get("advisoryTruncated") is True),
                               receipt=adapter_receipt)
        # Result storage precedes grant finalization and source acknowledgment.  A
        # restart can finish this same claim but never launch another process.
        self._finish(result)
        self._ack(source)
        return result


def _read_config(path):
    path = Path(path)
    if not path.is_absolute():
        raise GrantedSupervisorError("config_path_must_be_absolute")
    _private_directory(path.parent)
    _private_file(path)
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        raise GrantedSupervisorError("config_invalid") from None
    fields = {"inboxDb", "grantsDb", "resultsDb", "executable", "projectDir", "codexHome", "sessions", "timeoutSeconds"}
    if not isinstance(raw, dict) or set(raw) != fields:
        raise GrantedSupervisorError("config_invalid")
    return raw


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run one grant-authorized local supervisor pass.")
    parser.add_argument("--config", required=True)
    parser.add_argument("--event-id", type=int, required=True)
    parser.add_argument("--grant-id", required=True)
    args = parser.parse_args(argv)
    config = _read_config(args.config)
    service = GrantedSupervisor(inbox_path=config["inboxDb"], grants_path=config["grantsDb"], results_path=config["resultsDb"],
                                executable=config["executable"], project_dir=config["projectDir"], codex_home=config["codexHome"],
                                sessions=config["sessions"], timeout_seconds=config["timeoutSeconds"])
    print(json.dumps(service.run_once(event_id=args.event_id, grant_id=args.grant_id), sort_keys=True))


if __name__ == "__main__":
    main()
