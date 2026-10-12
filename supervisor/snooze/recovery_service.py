"""Private GuidanceInbox-to-RecoveryEngine daemon (no provider actions by default)."""
from __future__ import annotations

from contextlib import contextmanager

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time
from urllib.parse import quote

from snooze.guidance import GuidanceInbox
from snooze.recovery import RecoveryEngine, RecoveryError
from snooze.headless import HeadlessCodex


def _private_file(path: Path, *, required=True):
    if not path.is_absolute():
        raise ValueError("absolute_private_paths_required")
    try:
        info = path.lstat()
    except FileNotFoundError:
        if required:
            raise ValueError("private_file_missing") from None
        return
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ValueError("private_regular_file_required")
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("private_owner_permissions_required")


def _private_directory(path: Path, *, create=False):
    if not path.is_absolute():
        raise ValueError("absolute_private_paths_required")
    if not path.exists() and create:
        path.mkdir(parents=True, mode=0o700)
    try:
        info = path.lstat()
    except OSError as exc:
        raise ValueError("private_state_directory_unavailable") from exc
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("private_owner_permissions_required")


def _read_config(path: Path):
    _private_file(path)
    _private_directory(path.parent)
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("config_unavailable") from exc
    required = {"version", "inboxDb", "stateDb", "intervalSeconds", "maxEventsPerCycle", "projects"}
    if not isinstance(config, dict) or set(config) - (required | {"poolConfig", "poolDb", "headless"}) or not required <= set(config):
        raise ValueError("config_fields_invalid")
    if config["version"] != 1 or type(config["intervalSeconds"]) is not int or not 60 <= config["intervalSeconds"] <= 3600:
        raise ValueError("config_version_or_interval_invalid")
    if type(config["maxEventsPerCycle"]) is not int or not 1 <= config["maxEventsPerCycle"] <= 100:
        raise ValueError("config_event_limit_invalid")
    for key in ("inboxDb", "stateDb", "poolConfig", "poolDb"):
        if key in config and (not isinstance(config[key], str) or not Path(config[key]).is_absolute()):
            raise ValueError("absolute_private_paths_required")
    if "headless" in config:
        headless = config["headless"]
        fields = {"executable", "projectDir", "codexHome", "sessions", "timeoutSeconds"}
        if not isinstance(headless, dict) or set(headless) != fields:
            raise ValueError("headless_config_fields_invalid")
        for key in ("executable", "projectDir", "codexHome"):
            if not isinstance(headless[key], str) or not Path(headless[key]).is_absolute():
                raise ValueError("headless_paths_must_be_absolute")
        exe = Path(headless["executable"])
        if not exe.is_file() or exe.is_symlink() or not os.access(exe, os.X_OK):
            raise ValueError("headless_executable_unavailable")
        project_dir = Path(headless["projectDir"])
        if not project_dir.is_dir() or project_dir.is_symlink():
            raise ValueError("headless_project_directory_unavailable")
        _private_directory(Path(headless["codexHome"]))
        if type(headless["timeoutSeconds"]) is not int or not 1 <= headless["timeoutSeconds"] <= 300:
            raise ValueError("headless_timeout_invalid")
        sessions = headless["sessions"]
        if not isinstance(sessions, list) or len(sessions) > 1000:
            raise ValueError("headless_session_allowlist_invalid")
        for item in sessions:
            if not isinstance(item, dict) or set(item) != {"project", "owner", "session"} or any(
                    not isinstance(item[k], str) or not re.fullmatch(r"[A-Za-z0-9_.:@/-]{1,160}", item[k])
                    for k in ("project", "owner")) or not isinstance(item["session"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", item["session"]):
                raise ValueError("headless_session_allowlist_invalid")
    if not isinstance(config["projects"], list) or not 1 <= len(config["projects"]) <= 100:
        raise ValueError("project_config_invalid")
    seen, scopes = set(), set()
    for item in config["projects"]:
        if not isinstance(item, dict) or set(item) != {"project", "scope", "owners", "policy"}:
            raise ValueError("project_config_invalid")
        for key in ("project", "scope"):
            if not isinstance(item[key], str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", item[key]):
                raise ValueError("project_config_invalid")
        owners = item["owners"]
        if not isinstance(owners, list) or not owners or len(owners) > 50 or not all(
                isinstance(owner, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", owner) for owner in owners):
            raise ValueError("project_owners_invalid")
        key = (item["project"], tuple(sorted(set(owners))))
        if key in seen or item["scope"] in scopes or len(set(owners)) != len(owners):
            raise ValueError("duplicate_project_scope")
        seen.add(key)
        scopes.add(item["scope"])
        try:
            RecoveryEngine._policy(item["policy"])
        except RecoveryError as exc:
            raise ValueError(str(exc)) from exc
    uses_oracle = any(p["policy"]["oracle_advice"] for p in config["projects"])
    if uses_oracle and not {"poolConfig", "poolDb"} <= set(config):
        raise ValueError("oracle_paths_required")
    return config


class RecoveryService:
    """Consumes bounded inbox pages; engine receipts make crashes idempotent."""

    def __init__(self, config, *, oracle_pool=None, resource_verifier=None, clock=time.time):
        self.config, self.clock = config, clock
        inbox_path = Path(config["inboxDb"])
        _private_directory(inbox_path.parent)
        _private_file(inbox_path)
        self.inbox = GuidanceInbox(inbox_path)
        self.state_path = Path(config["stateDb"])
        _private_directory(self.state_path.parent, create=True)
        _private_file(self.state_path, required=False)
        self.oracle_pool = oracle_pool
        self.resource_verifier = resource_verifier
        self.engine = None
        self._policy_digests = {}
        self._init_state()
        self.lock_path = self.state_path.with_suffix(self.state_path.suffix + ".lock")

    def _db(self):
        db = sqlite3.connect(self.state_path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    @contextmanager
    def _connection(self):
        db = self._db()
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _init_state(self):
        old = os.umask(0o077)
        try:
            db = self._db()
            with db:
                db.executescript("""
                  CREATE TABLE IF NOT EXISTS recovery_service_cursor(id INTEGER PRIMARY KEY CHECK(id=1), event_id INTEGER NOT NULL);
                  INSERT OR IGNORE INTO recovery_service_cursor VALUES(1,0);
                  CREATE TABLE IF NOT EXISTS recovery_service_sources(
                    inbox_event_id INTEGER PRIMARY KEY, recovery_event_id TEXT, state TEXT NOT NULL,
                    receipt TEXT NOT NULL, processed REAL NOT NULL, project TEXT, owner TEXT);
                  CREATE TABLE IF NOT EXISTS recovery_service_notifications(
                    recovery_event_id TEXT PRIMARY KEY, project TEXT NOT NULL, owner TEXT NOT NULL,
                    job TEXT NOT NULL, kind TEXT NOT NULL, created REAL NOT NULL);
                  CREATE TABLE IF NOT EXISTS recovery_service_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                """)
                columns = {row[1] for row in db.execute("PRAGMA table_info(recovery_service_sources)")}
                if "project" not in columns:
                    db.execute("ALTER TABLE recovery_service_sources ADD COLUMN project TEXT")
                if "owner" not in columns:
                    db.execute("ALTER TABLE recovery_service_sources ADD COLUMN owner TEXT")
                with self.inbox.connection() as inbox_db:
                    registrations = inbox_db.execute("SELECT id,job,owner FROM guidance_events").fetchall()
                for source in registrations:
                    db.execute("UPDATE recovery_service_sources SET project=COALESCE(project,?),owner=COALESCE(owner,?) WHERE inbox_event_id=?",
                               (source["job"], source["owner"], source["id"]))
            db.close()
            os.chmod(self.state_path, 0o600)
        finally:
            os.umask(old)

    def _adapter(self, action):
        def owner_for(event_id):
            match = re.fullmatch(r"guidance-([1-9][0-9]*)", event_id)
            if not match:
                raise ValueError("guidance_event_binding_missing")
            with self.inbox.connection() as db:
                row = db.execute("SELECT owner FROM guidance_events WHERE id=?", (int(match.group(1)),)).fetchone()
            if not row:
                raise ValueError("guidance_event_binding_missing")
            return row["owner"]
        if action == "notify":
            def notify(context, _timeout):
                with self._connection() as db:
                    db.execute("INSERT OR IGNORE INTO recovery_service_notifications VALUES(?,?,?,?,?,?)",
                               (context["event_id"], context["project"], owner_for(context["event_id"]), context["job"], context["kind"], self.clock()))
                return {"state": "accepted", "receipt": {"adapter": "local-notification", "state": "durable-handoff"}}
            return notify
        if action == "ack-inbox":
            def acknowledge(context, _timeout):
                match = re.fullmatch(r"guidance-([1-9][0-9]*)", context["event_id"])
                if not match:
                    return {"state": "rejected", "definitely_not_started": True}
                self.inbox.acknowledge(int(match.group(1)), owner=owner_for(context["event_id"]), job=context["job"])
                return {"state": "accepted", "receipt": {"adapter": "guidance-inbox-ack", "state": "acknowledged"}}
            return acknowledge
        if action == "headless" and "headless" in self.config:
            cfg = self.config["headless"]
            allowed = [(x["project"], x["owner"], x["session"]) for x in cfg["sessions"]]
            runner = HeadlessCodex(executable=cfg["executable"], project_dir=cfg["projectDir"],
                codex_home=cfg["codexHome"], sessions=allowed, timeout_seconds=cfg["timeoutSeconds"])
            def resume(context, timeout):
                owner = owner_for(context["event_id"])
                return runner({**dict(context), "owner": owner}, timeout)
            return resume
        return None

    def _setup_engine(self):
        adapters = {name: fn for name in ("notify", "ack-inbox", "headless") if (fn := self._adapter(name))}
        if self.oracle_pool is None and any(p["policy"]["oracle_advice"] for p in self.config["projects"]):
            pool_config = Path(self.config["poolConfig"])
            _private_directory(pool_config.parent)
            _private_file(pool_config)
            from snooze.oracle_pool import OraclePool
            self.oracle_pool = OraclePool(config_path=self.config["poolConfig"], db_path=self.config["poolDb"])
        self.engine = RecoveryEngine(self.state_path, adapters=adapters, oracle_pool=self.oracle_pool,
                                     resource_verifier=self.resource_verifier, clock=self.clock)
        for project in self.config["projects"]:
            policy = project["policy"]
            digest = hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            meta_key = "policy:" + project["scope"]
            with self._connection() as db:
                row = db.execute("SELECT value FROM recovery_service_meta WHERE key=?", (meta_key,)).fetchone()
            if row is None or row["value"] != digest:
                self.engine.configure(project["scope"], policy)
                with self._connection() as db:
                    db.execute("INSERT INTO recovery_service_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (meta_key, digest))
        # Bindings come only from the private GuidanceInbox registration table.
        headless_allowlist = {(x["project"], x["owner"], x["session"]) for x in self.config.get("headless", {}).get("sessions", [])}
        for row in self.inbox.registrations():
            for project in self.config["projects"]:
                if row["project"] == project["project"] and row["owner"] in project["owners"]:
                    can_resume = ("headless" in self.config and row["model"].lower() == "codex" and
                                  (row["project"], row["owner"], row["session_id"]) in headless_allowlist)
                    self.engine.register_session(scope=project["scope"], project=row["project"], job=row["project"],
                        account=row["account_id"], session=row["session_id"], adapter="codex" if can_resume else "unverified")

    def _scope(self, project, owner):
        return next((item for item in self.config["projects"] if item["project"] == project and owner in item["owners"]), None)

    def _process(self, row):
        source_id = row["id"]
        event_id = "guidance-" + str(source_id)
        with self._connection() as db:
            prior = db.execute("SELECT receipt FROM recovery_service_sources WHERE inbox_event_id=?", (source_id,)).fetchone()
        if prior:
            self.inbox.acknowledge(source_id, owner=row["owner"], job=row["job"])
            return json.loads(prior["receipt"])
        project = self._scope(row["job"], row["owner"])
        registrations = {r["id"]: r for r in self.inbox.registrations()}
        binding = registrations.get(row["worker"])
        if not project or not binding or binding["project"] != row["job"] or binding["owner"] != row["owner"]:
            receipt = {"eventId": event_id, "state": "handoff", "reason": "trusted_registration_or_project_policy_missing"}
            with self._connection() as db:
                db.execute("INSERT OR IGNORE INTO recovery_service_sources(inbox_event_id,recovery_event_id,state,receipt,processed,project,owner) VALUES(?,?,?,?,?,?,?)",
                           (source_id, None, "handoff", json.dumps(receipt, sort_keys=True), self.clock(), row["job"], row["owner"]))
        else:
            kind = "idle" if row["kind"] == "idle_needs_review" else row["kind"]
            event = {"event_id": event_id, "scope": project["scope"], "project": row["job"], "job": row["job"],
                     "kind": kind, "severity": kind, "account": binding["account_id"], "session": binding["session_id"]}
            self.engine.ingest(event)
            receipt = self.engine.run(event_id)
            with self._connection() as db:
                db.execute("INSERT OR IGNORE INTO recovery_service_sources(inbox_event_id,recovery_event_id,state,receipt,processed,project,owner) VALUES(?,?,?,?,?,?,?)",
                           (source_id, event_id, receipt["state"], json.dumps(receipt, sort_keys=True), self.clock(), row["job"], row["owner"]))
        # Ack only after the local receipt is durable. A crash before cursor advance replays safely.
        self.inbox.acknowledge(source_id, owner=row["owner"], job=row["job"])
        return receipt

    def run_once(self):
        self.lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            lock_stat = os.fstat(fd)
            if lock_stat.st_uid != os.getuid() or lock_stat.st_mode & 0o077 or not stat.S_ISREG(lock_stat.st_mode):
                raise RuntimeError("private_lock_permissions_required")
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise RuntimeError("recovery_service_already_running")
        processed = 0
        try:
            self._setup_engine()
            with self._connection() as db:
                cursor = db.execute("SELECT event_id FROM recovery_service_cursor WHERE id=1").fetchone()[0]
            rows = self.inbox.inbox(after=cursor, limit=min(self.config["maxEventsPerCycle"], 100))
            for row in rows:
                self._process(row)
                with self._connection() as db:
                    db.execute("UPDATE recovery_service_cursor SET event_id=MAX(event_id,?) WHERE id=1", (row["id"],))
                processed += 1
            with self._connection() as db:
                local_pending = db.execute("SELECT COUNT(*) FROM recovery_service_sources WHERE state='handoff'").fetchone()[0]
            pending = len(self.engine.pending_handoffs(limit=100)) + local_pending
            return {"processed": processed, "cursor": rows[-1]["id"] if rows else cursor,
                    "pendingHandoffs": pending, "stateDb": str(self.state_path)}
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def serve(self, stop=lambda: False):
        while not stop():
            try:
                print(json.dumps(self.run_once(), sort_keys=True), flush=True)
            except Exception as exc:
                print(json.dumps({"error": type(exc).__name__}), file=sys.stderr, flush=True)
            for _ in range(self.config["intervalSeconds"]):
                if stop():
                    break
                time.sleep(1)


def _redacted_advice(value):
    if not isinstance(value, str):
        return None
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", value)
    value = re.sub(r"(?i)\bBearer\s+[^\s,;]+", "Bearer [REDACTED]", value)
    value = re.sub(r"(?i)(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+", r"\1\2[REDACTED]", value)
    value = re.sub(r"(?i)\b(?:sk|ghp|gho|github_pat)_[A-Za-z0-9_]{12,}\b", "[REDACTED]", value)
    return value[:1200]


def read_recovery_snapshot(db_path, *, project, owners, after=0, limit=20, oracle_db_path=None):
    """Read a project/owner-scoped, bounded projection without opening the DB for writes."""
    if not isinstance(project, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", project):
        raise ValueError("invalid_project")
    if (not isinstance(owners, list) or not owners or len(owners) > 50 or
            any(not isinstance(owner, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", owner) for owner in owners)):
        raise ValueError("invalid_owners")
    if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError("invalid_page")
    path = Path(db_path)
    try:
        _private_directory(path.parent)
        _private_file(path)
        uri = "file:" + quote(str(path), safe="/") + "?mode=ro"
        db = sqlite3.connect(uri, uri=True, timeout=2)
        db.row_factory = sqlite3.Row
    except (OSError, ValueError, sqlite3.Error):
        return {"available": False, "project": project, "state": "unavailable", "cursor": after,
                "decisions": [], "pendingHandoffs": [], "notifyReceipts": [], "oracleAdvice": []}
    try:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required = {"recovery_service_sources", "recovery_events", "recovery_actions", "recovery_service_cursor", "recovery_service_notifications", "recovery_advice"}
        if not required <= tables:
            return {"available": True, "project": project, "state": "not_initialized", "cursor": after,
                    "decisions": [], "pendingHandoffs": [], "notifyReceipts": [], "oracleAdvice": []}
        source_columns = {row[1] for row in db.execute("PRAGMA table_info(recovery_service_sources)")}
        if not {"project", "owner"} <= source_columns:
            return {"available": True, "project": project, "state": "upgrade_required", "cursor": after,
                    "decisions": [], "pendingHandoffs": [], "notifyReceipts": [], "oracleAdvice": []}
        marks = ",".join("?" for _ in set(owners))
        owner_args = tuple(dict.fromkeys(owners))
        args = (project, *owner_args)
        rows = db.execute(f"""SELECT s.inbox_event_id,s.recovery_event_id,s.state AS source_state,s.processed,s.receipt,
                    e.kind,e.severity,e.state AS event_state,e.decision,e.created,e.updated
                    FROM recovery_service_sources s LEFT JOIN recovery_events e ON e.event_id=s.recovery_event_id
                    WHERE s.project=? AND s.owner IN ({marks}) AND s.inbox_event_id>? ORDER BY s.inbox_event_id DESC LIMIT ?""",
                          (*args, after, limit)).fetchall()
        cursor = db.execute(f"SELECT COALESCE(MAX(inbox_event_id),0) FROM recovery_service_sources WHERE project=? AND owner IN ({marks})",
                            args).fetchone()[0]
        decisions = []
        handoffs = []
        for row in rows:
            decision = None
            if row["decision"]:
                try:
                    raw = json.loads(row["decision"])
                    if isinstance(raw, dict):
                        decision = {key: raw[key] for key in ("level", "outcome", "reason", "action", "attempt", "error")
                                    if isinstance(raw.get(key), (str, int, bool)) and not isinstance(raw.get(key), float)}
                except (TypeError, json.JSONDecodeError):
                    pass
            if decision is None:
                try:
                    source_receipt = json.loads(row["receipt"])
                    if isinstance(source_receipt, dict) and isinstance(source_receipt.get("reason"), str):
                        decision = {"outcome": "human_handoff", "reason": source_receipt["reason"][:160]}
                except (TypeError, json.JSONDecodeError):
                    pass
            item = {"eventId": row["recovery_event_id"] or "guidance-" + str(row["inbox_event_id"]),
                    "kind": row["kind"] or "unbound", "state": row["event_state"] or row["source_state"],
                    "at": row["created"] or row["processed"], "decision": decision}
            if decision or row["recovery_event_id"]:
                decisions.append(item)
            if row["source_state"] == "handoff" or row["event_state"] == "handoff":
                handoffs.append(item)
        notifications = [dict(row) for row in db.execute(
            f"SELECT recovery_event_id AS eventId,project,kind,created AS at FROM recovery_service_notifications WHERE project=? AND owner IN ({marks}) ORDER BY created DESC LIMIT ?",
            (*args, limit)).fetchall()]
        advice_rows = db.execute(f"""SELECT a.event_id,a.job_id,a.state,a.error_code,a.created AS at,e.kind
                    FROM recovery_advice a JOIN recovery_events e ON e.event_id=a.event_id
                    JOIN recovery_service_sources s ON s.recovery_event_id=e.event_id
                    WHERE s.project=? AND s.owner IN ({marks}) ORDER BY a.created DESC LIMIT ?""",
                                 (*args, min(limit, 10))).fetchall()
        advice = [{"eventId": row["event_id"], "jobId": row["job_id"], "status": row["state"], "error": row["error_code"],
                   "kind": row["kind"], "at": row["at"]} for row in advice_rows]
        state = rows[0]["event_state"] or rows[0]["source_state"] if rows else "waiting_for_events"
        result = {"available": True, "project": project, "state": state, "cursor": cursor,
                  "decisions": decisions[:limit], "pendingHandoffs": handoffs[:limit],
                  "notifyReceipts": notifications, "oracleAdvice": advice}
    finally:
        db.close()
    if oracle_db_path and advice:
        oracle_path = Path(oracle_db_path)
        try:
            _private_directory(oracle_path.parent)
            _private_file(oracle_path)
            uri = "file:" + quote(str(oracle_path), safe="/") + "?mode=ro"
            pool = sqlite3.connect(uri, uri=True, timeout=1)
            pool.row_factory = sqlite3.Row
            try:
                for item in advice:
                    job = pool.execute("SELECT status,result,actual_model,model,updated FROM pool_tasks WHERE id=?", (item["jobId"],)).fetchone()
                    if job:
                        item["status"] = job["status"]
                        item["model"] = job["actual_model"] or job["model"]
                        item["at"] = job["updated"]
                        if job["status"] == "complete":
                            item["result"] = _redacted_advice(job["result"])
                            item["advisoryOnly"] = True
            finally:
                pool.close()
        except (OSError, ValueError, sqlite3.Error):
            pass
    return result


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--db", type=Path)
    parser.add_argument("--project")
    parser.add_argument("--owners", nargs="*")
    parser.add_argument("--after", type=int, default=0)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--oracle-db", type=Path)
    parser.add_argument("--snapshot", action="store_true")
    parser.add_argument("command", nargs="?", choices=("serve",))
    parser.add_argument("--once", dest="once", action="store_true")
    args = parser.parse_args(argv)
    if args.snapshot:
        if not args.db or not args.project or args.owners is None:
            parser.error("--snapshot requires trusted --db, --project and --owners arguments")
        print(json.dumps(read_recovery_snapshot(args.db, project=args.project, owners=args.owners,
              after=args.after, limit=args.limit, oracle_db_path=args.oracle_db), sort_keys=True))
        return 0
    if not args.config:
        parser.error("--config is required for service mode")
    service = RecoveryService(_read_config(args.config))
    if args.once or args.command != "serve":
        print(json.dumps(service.run_once(), sort_keys=True))
        return 0
    stopping = False
    import signal
    def stop(_sig, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    service.serve(lambda: stopping)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
