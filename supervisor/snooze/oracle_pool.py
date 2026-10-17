"""Private, durable, bounded text-only Ollama pool for the approved Oracle hosts.

The only remote operation is a fixed Python snippet sent over the configured
SSH aliases. Prompts and results travel on SSH stdin/stdout, never in the
remote command string. No shell, tools, agent loop, or hosted inference is used.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import ipaddress
import math
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


HOSTS = (
    {"id": "ora1", "ip": "100.65.151.42", "ssh_host": "shh-ora1.ziopsyop.tech"},
    {"id": "ora3", "ip": "100.114.191.111", "ssh_host": "shh-ora3.ziopsyop.tech"},
    {"id": "ora5", "ip": "100.112.7.115", "ssh_host": "shh-ora5.ziopsyop.tech"},
)
HOST_BY_ID = {host["id"]: host for host in HOSTS}
APPROVED_MODELS = ("qwen3.5:9b", "tev1:0.8b", "gpt-oss:20b")
DEFAULT_HOST_MODELS = APPROVED_MODELS
DEFAULT_MODEL = "qwen3.5:9b"
HOST_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,47}\Z")
SSH_ALIAS_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\Z")
MODEL_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,159}\Z")
MAX_TEXT_CHARS = 4000
MAX_RESULT_BYTES = 16 * 1024
MAX_PENDING = 100
MAX_BATCH = 12
MAX_RETAINED = 10_000
MAX_EVENTS = 10_000
MAX_CATALOG_MODELS = 64
MAX_EVENT_PAGE = 200
INFERENCE_TIMEOUT = 240
CATALOG_TIMEOUT = 20
TASK_ID_RE = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z")
SOURCE_RE = re.compile(r"[A-Za-z0-9_.:@/-]{1,128}\Z")
MAINTENANCE_REVISION_RE = re.compile(r"[A-Za-z0-9_-]{24}\Z")
MAINTENANCE_TABLE_COLUMNS = ("id", "epoch", "paused", "config_revision", "acknowledged", "requested_at")
KNOWN_TASK_STATUSES = {"queued", "running", "dispatching", "complete", "failed", "ambiguous", "cancelled"}
BOOT_ID = Path("/proc/sys/kernel/random/boot_id")


def default_config() -> dict[str, Any]:
    return {"version": 1, "default_model": DEFAULT_MODEL, "max_context": 4096,
            "max_predict": 512, "max_total_running": 3, "max_running_per_host": 1,
            "inference_timeout_seconds": INFERENCE_TIMEOUT}


def validate_config(config: Any) -> tuple[dict[str, Any], tuple[dict[str, Any], ...]]:
    """Validate the trusted private v1/v2 fleet file without widening its policy."""
    defaults = default_config()
    if type(config) is not dict:
        raise PoolError("unsupported_config")
    if config == defaults:
        hosts = tuple({**host, "enabled": True, "allowedModels": list(DEFAULT_HOST_MODELS)} for host in HOSTS)
        return defaults, hosts
    base_keys = set(defaults) | {"hosts"}
    if set(config) != base_keys or config.get("version") != 2:
        raise PoolError("unsupported_config")
    for key, expected in defaults.items():
        if key == "version":
            continue
        if type(config.get(key)) is not type(expected) or config.get(key) != expected:
            raise PoolError("unsupported_config")
    raw_hosts = config.get("hosts")
    if type(raw_hosts) is not list or not 1 <= len(raw_hosts) <= 32:
        raise PoolError("unsupported_config")
    hosts, ids, ips, aliases = [], set(), set(), set()
    for raw in raw_hosts:
        if type(raw) is not dict or set(raw) != {"id", "ip", "ssh_host", "enabled", "allowedModels"}:
            raise PoolError("unsupported_config")
        host_id, ip, alias = raw["id"], raw["ip"], raw["ssh_host"]
        if not isinstance(host_id, str) or not HOST_ID_RE.fullmatch(host_id):
            raise PoolError("unsupported_config")
        try:
            parsed_ip = ipaddress.ip_address(ip)
        except (ValueError, TypeError):
            raise PoolError("unsupported_config") from None
        if parsed_ip.version != 4 or parsed_ip not in ipaddress.ip_network("100.64.0.0/10"):
            raise PoolError("unsupported_config")
        if not isinstance(alias, str) or not SSH_ALIAS_RE.fullmatch(alias) or ".." in alias:
            raise PoolError("unsupported_config")
        if type(raw["enabled"]) is not bool:
            raise PoolError("unsupported_config")
        models = raw["allowedModels"]
        if type(models) is not list or len(models) > 64 or (raw["enabled"] and not models):
            raise PoolError("unsupported_config")
        if any(not isinstance(model, str) or not MODEL_NAME_RE.fullmatch(model) for model in models):
            raise PoolError("unsupported_config")
        if len(set(models)) != len(models) or host_id in ids or str(parsed_ip) in ips or alias in aliases:
            raise PoolError("unsupported_config")
        ids.add(host_id); ips.add(str(parsed_ip)); aliases.add(alias)
        hosts.append({"id": host_id, "ip": str(parsed_ip), "ssh_host": alias,
                      "enabled": raw["enabled"], "allowedModels": list(models)})
    enabled_models = {model for host in hosts if host["enabled"] for model in host["allowedModels"]}
    if not enabled_models or config["default_model"] not in enabled_models:
        raise PoolError("unsupported_config")
    normalized = {**defaults, "version": 2, "hosts": hosts}
    return normalized, tuple(hosts)


class PoolError(RuntimeError):
    """An expected, safe-to-display pool error."""


@dataclass(frozen=True)
class HostCapability:
    """Last-known model capability plus current catalog health for one fixed host."""

    host_id: str
    models: frozenset[str]
    healthy: bool
    enabled: bool = True


class _ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def _private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(path, 0o700)
    except OSError as exc:
        raise PoolError("private_state_directory_unavailable") from exc


def _process_identity(pid: int | None = None) -> tuple[int, str, str]:
    pid = os.getpid() if pid is None else int(pid)
    try:
        boot = BOOT_ID.read_text().strip()
        stat = Path(f"/proc/{pid}/stat").read_text()
        fields = stat[stat.rfind(")") + 2 :].split()
        start = fields[19]  # proc stat field 22 (starttime), after fields 3..22
        return pid, boot, start
    except (OSError, IndexError):
        return pid, "unknown", "unknown"


def _identity_alive(pid: int, boot: str, start: str) -> bool:
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError, OSError):
        return False
    current_pid, current_boot, current_start = _process_identity(pid)
    return current_pid == pid and current_boot == boot and current_start == start


class SSHOllamaTransport:
    """Fixed-host SSH transport; it never evaluates caller-controlled commands."""

    _CATALOG_SCRIPT = (
        "import json,urllib.request;"
        "r=urllib.request.urlopen('http://127.0.0.1:11434/api/tags',timeout=8);"
        "print(json.dumps(json.loads(r.read(131072))))"
    )
    # Keep the code as a constant literal. HTTP errors become structured output
    # so an Ollama rejection is distinguishable from a lost SSH connection.
    _GENERATE_SCRIPT = (
        "import json,sys,urllib.request,urllib.error;"
        "d=json.load(sys.stdin);"
        "q=urllib.request.Request('http://127.0.0.1:11434/api/generate',"
        "data=json.dumps(d).encode(),headers={'Content-Type':'application/json'});"
        "\ntry:\n r=urllib.request.urlopen(q,timeout=220);"
        "\n print(json.dumps(json.loads(r.read(65536))))"
        "\nexcept urllib.error.HTTPError as e:\n print(json.dumps({'_http_error':int(e.code)}))"
    )

    def __init__(self, *, timeout: int = INFERENCE_TIMEOUT, hosts: tuple[dict[str, Any], ...] = HOSTS):
        self.timeout = timeout
        self.hosts = {host["id"]: host for host in hosts}

    @staticmethod
    def _host(host_id: str, hosts: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
        try:
            return (HOST_BY_ID if hosts is None else hosts)[host_id]
        except KeyError as exc:
            raise PoolError("host_not_allowed") from exc

    def _ssh(self, host_id: str, remote_script: str, payload: bytes = b"", *, timeout: int):
        host = self._host(host_id, self.hosts)
        if not host.get("enabled", True):
            raise PoolError("host_disabled")
        ssh = shutil.which("ssh")
        if not ssh:
            raise PoolError("ssh_unavailable")
        key_alias = f"[{host['ssh_host']}]:6722"
        argv = [
            ssh, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", f"HostName={host['ip']}", "-o", f"HostKeyAlias={key_alias}",
                    "-o", "ConnectTimeout=10", host_id, "python3", "-c", shlex.quote(remote_script),
        ]
        try:
            proc = subprocess.run(argv, input=payload, capture_output=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            raise PoolError("timeout") from exc
        except OSError as exc:
            raise PoolError("ssh_unavailable") from exc
        if proc.returncode:
            # SSH may have lost its connection after Ollama accepted a request.
            raise PoolError("transport_exit")
        if len(proc.stdout) > 128 * 1024:
            raise PoolError("response_too_large")
        try:
            return json.loads(proc.stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PoolError("invalid_response") from exc

    def catalog(self, host_id: str) -> list[str]:
        response = self._ssh(host_id, self._CATALOG_SCRIPT, timeout=CATALOG_TIMEOUT)
        models = response.get("models") if isinstance(response, dict) else None
        if not isinstance(models, list):
            raise PoolError("invalid_catalog")
        names = []
        for item in models[:MAX_CATALOG_MODELS]:
            name = item.get("name") if isinstance(item, dict) else None
            if isinstance(name, str) and 0 < len(name) <= 160 and name not in names:
                names.append(name)
        return names

    def generate(self, host_id: str, model: str, prompt: str) -> dict[str, Any]:
        payload = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "think": False,
            "options": {"num_ctx": 4096, "num_predict": 512},
        }
        raw = self._ssh(host_id, self._GENERATE_SCRIPT, json.dumps(payload).encode("utf-8"),
                        timeout=self.timeout)
        if not isinstance(raw, dict):
            raise PoolError("invalid_response")
        if isinstance(raw.get("_http_error"), int):
            raise PoolError(f"remote_http_{raw['_http_error']}")
        response = raw.get("response")
        actual_model = raw.get("model")
        if not isinstance(response, str) or not isinstance(actual_model, str):
            if "error" in raw:
                raise PoolError("generation_failed")
            raise PoolError("invalid_response")
        raw["response"] = response.encode("utf-8")[:MAX_RESULT_BYTES].decode("utf-8", errors="ignore")
        raw["model"] = actual_model[:160]
        return raw


class OraclePool:
    """Durable queue and bounded worker pool.

    The default state directory is private under ``~/.local/state``. An
    injected transport is intended for deterministic unit tests only.
    """

    def __init__(self, config_path: str | Path | None = None, db_path: str | Path | None = None,
                 transport: Any | None = None):
        home = Path.home()
        canonical = home / ".local/state/rotoxy"
        legacy = home / ".local/state/token2oauth"
        known_state = ("config.json", "queue.sqlite3")
        has_state = lambda root: any((root / "oracle-pool" / relative).exists() for relative in known_state)
        state_root = canonical if has_state(canonical) or not has_state(legacy) else legacy
        base = state_root / "oracle-pool"
        self.config_path = Path(config_path) if config_path else base / "config.json"
        self.db_path = Path(db_path) if db_path else base / "queue.sqlite3"
        self.base = self.config_path.parent if config_path else base
        _private_directory(self.base)
        _private_directory(self.db_path.parent)
        self.config, self.hosts = self._ensure_config()
        self.host_by_id = {host["id"]: host for host in self.hosts}
        self.available_models = frozenset(model for host in self.hosts
                                          if host["enabled"] for model in host["allowedModels"])
        self.transport = transport or SSHOllamaTransport(hosts=self.hosts)
        if isinstance(self.transport, SSHOllamaTransport):
            self.transport.hosts = self.host_by_id
        self._identity = _process_identity()
        self._init_db()
        self._recover_stale_claims()

    def _ensure_config(self) -> tuple[dict[str, Any], tuple[dict[str, Any], ...]]:
        defaults = default_config()
        if not self.config_path.exists():
            self.config_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(self.config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(defaults, stream, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
        try:
            mode = self.config_path.stat().st_mode & 0o777
            if mode & 0o077:
                raise PoolError("config_permissions_not_private")
            config = json.loads(self.config_path.read_text(encoding="utf-8"))
        except PoolError:
            raise
        except (OSError, json.JSONDecodeError) as exc:
            raise PoolError("config_unavailable") from exc
        normalized, hosts = validate_config(config)
        return normalized, hosts

    def _connect(self):
        db = sqlite3.connect(self.db_path, timeout=20, isolation_level=None,
                             factory=_ClosingConnection)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=20000")
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def _init_db(self) -> None:
        if not self.db_path.exists():
            fd = os.open(self.db_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)
        os.chmod(self.db_path, 0o600)
        with self._connect() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS pool_tasks(
              id TEXT PRIMARY KEY, text TEXT NOT NULL, text_hash TEXT NOT NULL,
              source TEXT, model TEXT NOT NULL, status TEXT NOT NULL,
              created REAL NOT NULL, updated REAL NOT NULL,
              assigned_host TEXT, claim_token TEXT, claim_pid INTEGER,
              claim_boot TEXT, claim_start TEXT, attempts INTEGER NOT NULL DEFAULT 0,
              error_code TEXT, result TEXT, actual_model TEXT,
              prompt_tokens INTEGER, eval_tokens INTEGER, remote_seconds REAL,
              elapsed_seconds REAL);
            CREATE INDEX IF NOT EXISTS pool_tasks_queue ON pool_tasks(status,created,id);
            CREATE INDEX IF NOT EXISTS pool_tasks_host ON pool_tasks(assigned_host,status);
            CREATE TABLE IF NOT EXISTS pool_hosts(
              id TEXT PRIMARY KEY, models TEXT NOT NULL DEFAULT '[]',
              updated REAL, error_code TEXT, assigned INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS pool_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pool_maintenance(
              id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL,
              paused INTEGER NOT NULL, config_revision TEXT,
              acknowledged INTEGER NOT NULL, requested_at REAL);
            CREATE TABLE IF NOT EXISTS pool_events(
              id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT NOT NULL,
              at REAL NOT NULL, data TEXT NOT NULL);
            """)
            db.execute("PRAGMA journal_mode=DELETE")
            db.execute("INSERT OR IGNORE INTO pool_maintenance(id,epoch,paused,config_revision,acknowledged,requested_at) VALUES(1,0,0,NULL,0,NULL)")
            for host in self.hosts:
                db.execute("INSERT OR IGNORE INTO pool_hosts(id) VALUES(?)", (host["id"],))
            self._maintenance_row(db)
        os.chmod(self.db_path, 0o600)

    @staticmethod
    def _maintenance_row(db: sqlite3.Connection) -> sqlite3.Row:
        try:
            columns = tuple(row[1] for row in db.execute("PRAGMA table_info(pool_maintenance)"))
            if columns != MAINTENANCE_TABLE_COLUMNS:
                raise ValueError("maintenance_unavailable")
            rows = db.execute("SELECT id,epoch,paused,config_revision,acknowledged,requested_at FROM pool_maintenance").fetchall()
        except sqlite3.DatabaseError as exc:
            raise ValueError("maintenance_unavailable") from exc
        if len(rows) != 1 or rows[0]["id"] != 1:
            raise ValueError("maintenance_unavailable")
        row = rows[0]
        if (type(row["epoch"]) is not int or row["epoch"] < 0 or type(row["paused"]) is not int or row["paused"] not in (0, 1)
                or type(row["acknowledged"]) is not int or row["acknowledged"] not in (0, 1)
                or (row["config_revision"] is not None and (not isinstance(row["config_revision"], str) or not MAINTENANCE_REVISION_RE.fullmatch(row["config_revision"])) )
                or (row["requested_at"] is not None and (not isinstance(row["requested_at"], (int, float)) or not math.isfinite(row["requested_at"]) or row["requested_at"] < 0))
                or (row["paused"] == 0 and (row["config_revision"] is not None or row["acknowledged"] != 0 or row["requested_at"] is not None))
                or (row["paused"] == 1 and (row["config_revision"] is None or row["requested_at"] is None))):
            raise ValueError("maintenance_unavailable")
        return row

    @staticmethod
    def _maintenance_blockers(db: sqlite3.Connection) -> dict[str, int]:
        try:
            rows = db.execute("SELECT status,COUNT(*) AS n FROM pool_tasks GROUP BY status").fetchall()
        except sqlite3.DatabaseError as exc:
            raise ValueError("maintenance_unavailable") from exc
        counts = {row["status"]: row["n"] for row in rows}
        unknown = sum(n for status, n in counts.items() if status not in KNOWN_TASK_STATUSES)
        return {"running": counts.get("running", 0), "ambiguous": counts.get("ambiguous", 0),
                "dispatching": counts.get("dispatching", 0) + unknown}

    @staticmethod
    def _maintenance_dto(row: sqlite3.Row, blockers: dict[str, int]) -> dict[str, Any]:
        paused = bool(row["paused"])
        acknowledged = bool(row["acknowledged"]) and not any(blockers.values())
        reason = None if not paused else ("draining" if any(blockers.values()) else "paused" if acknowledged else "awaiting_daemon_ack")
        return {"epoch": row["epoch"], "paused": paused, "configRevision": row["config_revision"],
                "acknowledged": acknowledged, "blockers": blockers, "reason": reason}

    def maintenance_status(self) -> dict[str, Any]:
        """Read the durable fence without acknowledging or changing it."""
        with self._connect() as db:
            db.execute("BEGIN")
            row = self._maintenance_row(db)
            result = self._maintenance_dto(row, self._maintenance_blockers(db))
            db.commit()
            return result

    def request_maintenance(self, config_revision: str, expected_epoch: int) -> dict[str, Any]:
        if not isinstance(config_revision, str) or not MAINTENANCE_REVISION_RE.fullmatch(config_revision):
            raise ValueError("maintenance_revision_conflict")
        if type(expected_epoch) is not int or expected_epoch < 0:
            raise ValueError("maintenance_epoch_conflict")
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._maintenance_row(db)
            if row["paused"]:
                if row["config_revision"] == config_revision and expected_epoch == row["epoch"] - 1:
                    result = self._maintenance_dto(row, self._maintenance_blockers(db)); db.commit(); return result
                if row["config_revision"] != config_revision and expected_epoch == row["epoch"]:
                    raise ValueError("maintenance_revision_conflict")
                raise ValueError("maintenance_epoch_conflict")
            if row["epoch"] != expected_epoch:
                raise ValueError("maintenance_epoch_conflict")
            db.execute("UPDATE pool_maintenance SET epoch=epoch+1,paused=1,config_revision=?,acknowledged=0,requested_at=? WHERE id=1 AND epoch=? AND paused=0",
                       (config_revision, time.time(), expected_epoch))
            updated = self._maintenance_row(db)
            result = self._maintenance_dto(updated, self._maintenance_blockers(db)); db.commit(); return result

    def release_maintenance(self, expected_epoch: int, config_revision: str) -> dict[str, Any]:
        if type(expected_epoch) is not int or expected_epoch < 0:
            raise ValueError("maintenance_epoch_conflict")
        if not isinstance(config_revision, str) or not MAINTENANCE_REVISION_RE.fullmatch(config_revision):
            raise ValueError("maintenance_revision_conflict")
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._maintenance_row(db)
            if row["epoch"] != expected_epoch:
                raise ValueError("maintenance_epoch_conflict")
            if not row["paused"] or row["config_revision"] != config_revision:
                raise ValueError("maintenance_revision_conflict")
            db.execute("UPDATE pool_maintenance SET epoch=epoch+1,paused=0,config_revision=NULL,acknowledged=0,requested_at=NULL WHERE id=1 AND epoch=? AND paused=1 AND config_revision=?",
                       (expected_epoch, config_revision))
            updated = self._maintenance_row(db)
            result = self._maintenance_dto(updated, self._maintenance_blockers(db)); db.commit(); return result

    @staticmethod
    def _event(db: sqlite3.Connection, task_id: str | None, kind: str, data: dict[str, Any], now: float):
        safe = {key: data[key] for key in (
            "status", "model", "host", "actual_model", "error_code", "prompt_tokens",
            "eval_tokens", "remote_seconds", "elapsed_seconds", "source"
        ) if key in data}
        db.execute("INSERT INTO pool_events(task_id,kind,at,data) VALUES(?,?,?,?)",
                   (task_id, kind, now, json.dumps(safe, separators=(",", ":"))))
        db.execute("DELETE FROM pool_events WHERE id NOT IN (SELECT id FROM pool_events ORDER BY id DESC LIMIT ?)",
                   (MAX_EVENTS,))

    def _recover_stale_claims(self) -> None:
        now = time.time()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute("SELECT id,claim_pid,claim_boot,claim_start,model,assigned_host FROM pool_tasks WHERE status='running'").fetchall()
            for row in rows:
                if row["claim_pid"] is not None and _identity_alive(row["claim_pid"], row["claim_boot"], row["claim_start"]):
                    continue
                db.execute("UPDATE pool_tasks SET status='ambiguous',error_code='worker_disappeared',updated=?,claim_token=NULL WHERE id=? AND status='running'",
                           (now, row["id"]))
                self._event(db, row["id"], "ambiguous", {"status": "ambiguous", "model": row["model"],
                            "host": row["assigned_host"], "error_code": "worker_disappeared"}, now)
            db.commit()

    def _validate_task(self, text: str, model: str, job_id: str | None, source: str | None):
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
            raise ValueError(f"Task text must contain 1 to {MAX_TEXT_CHARS} characters")
        if any(ord(char) == 0 for char in text):
            raise ValueError("Task text contains an invalid character")
        if model not in self.available_models:
            raise ValueError("Model is not available on an enabled host")
        if job_id is not None and (not isinstance(job_id, str) or not TASK_ID_RE.fullmatch(job_id)):
            raise ValueError("Invalid task ID")
        if source is not None and (not isinstance(source, str) or not SOURCE_RE.fullmatch(source)):
            raise ValueError("Invalid source reference")

    def submit(self, text: str, *, model: str = DEFAULT_MODEL, job_id: str | None = None,
               source: str | None = None) -> dict[str, Any]:
        return self.submit_batch([{"text": text, "model": model, "job_id": job_id,
                                   "source": source}])[0]

    def submit_batch(self, tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Atomically enqueue up to MAX_BATCH independent prompts.

        Each list entry is one indivisible task; this method never segments or
        rewrites prompts. Repeating an existing ID is accepted only when its
        content, model, and source are identical, matching ``submit`` semantics.
        """
        if type(tasks) is not list or not 1 <= len(tasks) <= MAX_BATCH:
            raise ValueError(f"Batch must contain 1 to {MAX_BATCH} independent tasks")
        import hashlib

        normalized = []
        seen_ids = set()
        for item in tasks:
            if type(item) is not dict or set(item) - {"text", "model", "job_id", "source"}:
                raise ValueError("Invalid batch task fields")
            text = item.get("text")
            model = item.get("model", DEFAULT_MODEL)
            job_id = item.get("job_id") or str(uuid.uuid4())
            source = item.get("source")
            self._validate_task(text, model, job_id, source)
            if job_id in seen_ids:
                raise ValueError("Duplicate task ID in batch")
            seen_ids.add(job_id)
            digest = hashlib.sha256(json.dumps([text, model, source], ensure_ascii=False,
                                               separators=(",", ":")).encode("utf-8")).hexdigest()
            normalized.append({"id": job_id, "text": text, "model": model,
                               "source": source, "digest": digest})
        now = time.time()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            inserts = []
            for task in normalized:
                prior = db.execute("SELECT text_hash FROM pool_tasks WHERE id=?", (task["id"],)).fetchone()
                if prior:
                    if prior["text_hash"] != task["digest"]:
                        raise ValueError("Task ID already exists with different content")
                else:
                    inserts.append(task)
            pending = db.execute("SELECT COUNT(*) FROM pool_tasks WHERE status='queued'").fetchone()[0]
            retained = db.execute("SELECT COUNT(*) FROM pool_tasks").fetchone()[0]
            if pending + len(inserts) > MAX_PENDING:
                raise PoolError("queue_full")
            if retained + len(inserts) > MAX_RETAINED:
                raise PoolError("retention_full_run_cleanup")
            for task in inserts:
                db.execute("INSERT INTO pool_tasks(id,text,text_hash,source,model,status,created,updated) VALUES(?,?,?,?,?,'queued',?,?)",
                           (task["id"], task["text"], task["digest"], task["source"], task["model"], now, now))
                self._event(db, task["id"], "queued", {"status": "queued", "model": task["model"],
                            "source": task["source"]}, now)
            db.commit()
            rows = [db.execute("SELECT * FROM pool_tasks WHERE id=?", (task["id"],)).fetchone()
                    for task in normalized]
            return [self._public_task(row) for row in rows]

    def cancel(self, job_id: str) -> dict[str, Any]:
        """Cancel queued work only; a dispatched inference cannot be safely recalled."""
        if not isinstance(job_id, str) or not TASK_ID_RE.fullmatch(job_id):
            raise ValueError("Invalid task ID")
        now = time.time()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status,model,source FROM pool_tasks WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise KeyError("task_not_found")
            if row["status"] == "running":
                raise PoolError("task_inference_not_cancellable")
            if row["status"] == "queued":
                db.execute("UPDATE pool_tasks SET status='cancelled',updated=? WHERE id=? AND status='queued'",
                           (now, job_id))
                self._event(db, job_id, "cancelled", {"status": "cancelled", "model": row["model"],
                            "source": row["source"]}, now)
            db.commit()
        status = self.status(job_id)["status"]
        return {"id": job_id, "status": status, "cancelled": status == "cancelled"}

    def _public_task(self, row: sqlite3.Row) -> dict[str, Any]:
        return {key: row[key] for key in ("id", "status", "model", "source", "created", "updated",
                "assigned_host", "attempts", "error_code", "actual_model", "prompt_tokens", "eval_tokens",
                "remote_seconds", "elapsed_seconds")}

    def status(self, job_id: str | None = None) -> Any:
        with self._connect() as db:
            if job_id is not None:
                row = db.execute("SELECT * FROM pool_tasks WHERE id=?", (job_id,)).fetchone()
                if row is None:
                    raise KeyError("task_not_found")
                return self._public_task(row)
            rows = db.execute("SELECT * FROM pool_tasks ORDER BY created DESC,id DESC LIMIT 200").fetchall()
            counts = {row[0]: row[1] for row in db.execute("SELECT status,COUNT(*) FROM pool_tasks GROUP BY status")}
            return {"counts": counts, "tasks": [self._public_task(row) for row in rows]}

    def results(self, job_id: str | None = None) -> Any:
        with self._connect() as db:
            if job_id is not None:
                row = db.execute("SELECT id,status,result,actual_model,prompt_tokens,eval_tokens,remote_seconds,elapsed_seconds,error_code FROM pool_tasks WHERE id=?", (job_id,)).fetchone()
                if row is None:
                    raise KeyError("task_not_found")
                return dict(row)
            rows = db.execute("SELECT id,status,result,actual_model,prompt_tokens,eval_tokens,remote_seconds,elapsed_seconds,error_code FROM pool_tasks WHERE result IS NOT NULL ORDER BY updated DESC,id LIMIT 100").fetchall()
            return [dict(row) for row in rows]

    def events(self, *, after: int = 0, limit: int = 100) -> dict[str, Any]:
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= MAX_EVENT_PAGE:
            raise ValueError("Invalid event cursor or page size")
        with self._connect() as db:
            rows = db.execute("SELECT id,task_id,kind,at,data FROM pool_events WHERE id>? ORDER BY id LIMIT ?", (after, limit + 1)).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        entries = [{"id": r["id"], "task_id": r["task_id"], "kind": r["kind"], "at": r["at"], **json.loads(r["data"])} for r in rows]
        return {"events": entries, "next": rows[-1]["id"] if rows else after, "has_more": has_more}

    def catalog(self, *, refresh: bool = False) -> dict[str, Any]:
        if refresh:
            for host in self.hosts:
                host_id = host["id"]
                if not host["enabled"]:
                    continue
                try:
                    names = self.transport.catalog(host_id)
                    error = None
                except PoolError as exc:
                    names, error = None, str(exc)
                except Exception:
                    names, error = None, "catalog_error"
                now = time.time()
                with self._connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    if names is not None:
                        db.execute("UPDATE pool_hosts SET models=?,updated=?,error_code=NULL WHERE id=?",
                                   (json.dumps(names), now, host_id))
                    else:
                        db.execute("UPDATE pool_hosts SET updated=?,error_code=? WHERE id=?",
                                   (now, error, host_id))
                    db.commit()
        with self._connect() as db:
            rows = db.execute("SELECT id,models,updated,error_code,assigned FROM pool_hosts ORDER BY id").fetchall()
        return {"hosts": [{"id": r["id"], "ip": self.host_by_id[r["id"]]["ip"],
                            "enabled": self.host_by_id[r["id"]]["enabled"],
                            "allowedModels": self.host_by_id[r["id"]]["allowedModels"],
                            "models": [m for m in json.loads(r["models"])
                                       if m in self.host_by_id[r["id"]]["allowedModels"]],
                            "updated": r["updated"], "error_code": r["error_code"], "assigned": r["assigned"]}
                           for r in rows if r["id"] in self.host_by_id]}

    def _claim(self, limit: int = 3) -> list[dict[str, Any]]:
        pid, boot, start = self._identity
        claimed = []
        now = time.time()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            maintenance = self._maintenance_row(db)
            if maintenance["paused"]:
                blockers = self._maintenance_blockers(db)
                acknowledged = int(not any(blockers.values()))
                if maintenance["acknowledged"] != acknowledged:
                    db.execute("UPDATE pool_maintenance SET acknowledged=? WHERE id=1", (acknowledged,))
                db.commit()
                return []
            running = db.execute("SELECT COUNT(*) FROM pool_tasks WHERE status='running'").fetchone()[0]
            enabled_hosts = [host for host in self.hosts if host["enabled"]]
            maximum = min(self.config["max_total_running"], len(enabled_hosts))
            capacity = min(maximum, limit, maximum - running)
            if capacity <= 0:
                db.commit()
                return []
            host_rows = db.execute("SELECT id,models,assigned,error_code FROM pool_hosts").fetchall()
            host_map = {row["id"]: HostCapability(row["id"], frozenset(json.loads(row["models"])),
                         row["error_code"] is None, self.host_by_id.get(row["id"], {}).get("enabled", False))
                        for row in host_rows if row["id"] in self.host_by_id}
            assigned_map = {row["id"]: row["assigned"] for row in host_rows}
            candidates = db.execute("SELECT id,text,model,source FROM pool_tasks WHERE status='queued' ORDER BY created,id LIMIT ?", (MAX_PENDING,)).fetchall()
            cursor_row = db.execute("SELECT value FROM pool_meta WHERE key='round_robin_cursor'").fetchone()
            cursor = cursor_row[0] if cursor_row else (enabled_hosts[-1]["id"] if enabled_hosts else "")
            for task in candidates:
                if len(claimed) >= capacity:
                    break
                busy = {row[0] for row in db.execute("SELECT DISTINCT assigned_host FROM pool_tasks WHERE status='running'")}
                order = [h["id"] for h in enabled_hosts]
                try:
                    pivot = order.index(cursor)
                    order = order[pivot + 1:] + order[:pivot + 1]
                except ValueError:
                    pass
                eligible = [h for h in order if h in host_map and h not in busy and host_map[h].enabled
                            and host_map[h].healthy and task["model"] in host_map[h].models
                            and task["model"] in self.host_by_id[h]["allowedModels"]]
                if not eligible:
                    continue
                # Assigned count is the durable fair-share score; round-robin order
                # deterministically breaks ties across worker processes.
                host_id = min(eligible, key=lambda h: (assigned_map[h], order.index(h)))
                token = secrets.token_urlsafe(18)
                db.execute("UPDATE pool_tasks SET status='running',assigned_host=?,claim_token=?,claim_pid=?,claim_boot=?,claim_start=?,attempts=attempts+1,updated=? WHERE id=? AND status='queued'",
                           (host_id, token, pid, boot, start, now, task["id"]))
                db.execute("UPDATE pool_hosts SET assigned=assigned+1 WHERE id=?", (host_id,))
                assigned_map[host_id] += 1
                self._event(db, task["id"], "running", {"status": "running", "model": task["model"], "host": host_id, "source": task["source"]}, now)
                claimed.append({"id": task["id"], "text": task["text"], "model": task["model"],
                                "host": host_id, "token": token, "source": task["source"]})
                cursor = host_id
            db.execute("INSERT INTO pool_meta(key,value) VALUES('round_robin_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (cursor,))
            db.commit()
        return claimed

    def _execute(self, task: dict[str, Any]) -> dict[str, Any]:
        started = time.monotonic()
        now = time.time()
        try:
            response = self.transport.generate(task["host"], task["model"], task["text"])
            elapsed = time.monotonic() - started
            result = response["response"]
            actual_model = response["model"]
            prompt_tokens = response.get("prompt_eval_count")
            eval_tokens = response.get("eval_count")
            remote_ns = response.get("total_duration")
            remote_seconds = remote_ns / 1_000_000_000 if isinstance(remote_ns, (int, float)) and remote_ns >= 0 else None
            for name, value in (("prompt_tokens", prompt_tokens), ("eval_tokens", eval_tokens)):
                if not isinstance(value, int) or value < 0 or value > 10_000_000:
                    if name == "prompt_tokens": prompt_tokens = None
                    else: eval_tokens = None
            if not isinstance(actual_model, str) or not actual_model or len(actual_model) > 160:
                raise PoolError("invalid_response")
            if not isinstance(result, str):
                raise PoolError("invalid_response")
            result = result.encode("utf-8")[:MAX_RESULT_BYTES].decode("utf-8", errors="ignore")
            status, error_code = "complete", None
        except PoolError as exc:
            elapsed = time.monotonic() - started
            error_code = str(exc)
            # Once a request may have reached Ollama, do not retry it automatically.
            ambiguous = (error_code in {"timeout", "transport_exit", "invalid_response", "response_too_large", "ssh_unavailable"}
                         or error_code.startswith("remote_http_5"))
            status = "ambiguous" if ambiguous else "failed"
            result, actual_model, prompt_tokens, eval_tokens, remote_seconds = None, None, None, None, None
        except Exception:
            elapsed = time.monotonic() - started
            status, error_code = "ambiguous", "worker_error"
            result, actual_model, prompt_tokens, eval_tokens, remote_seconds = None, None, None, None, None
        finished = time.time()
        safe = {"status": status, "model": task["model"], "host": task["host"],
                "actual_model": actual_model, "error_code": error_code, "prompt_tokens": prompt_tokens,
                "eval_tokens": eval_tokens, "remote_seconds": remote_seconds, "elapsed_seconds": elapsed,
                "source": task["source"]}
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            updated = db.execute("UPDATE pool_tasks SET status=?,updated=?,error_code=?,result=?,actual_model=?,prompt_tokens=?,eval_tokens=?,remote_seconds=?,elapsed_seconds=?,claim_token=NULL WHERE id=? AND status='running' AND claim_token=?",
                                 (status, finished, error_code, result, actual_model, prompt_tokens, eval_tokens,
                                  remote_seconds, elapsed, task["id"], task["token"])).rowcount
            if updated:
                self._event(db, task["id"], status, safe, finished)
            db.commit()
        return {"id": task["id"], **safe}

    def run_once(self) -> dict[str, Any]:
        tasks = self._claim(limit=3)
        if not tasks:
            return {"claimed": 0, "completed": [], "running": self.status()["counts"].get("running", 0)}
        with concurrent.futures.ThreadPoolExecutor(max_workers=3, thread_name_prefix="oracle-pool") as executor:
            futures = [executor.submit(self._execute, task) for task in tasks]
            completed = [future.result() for future in futures]
        return {"claimed": len(tasks), "completed": completed, "running": self.status()["counts"].get("running", 0)}

    def cleanup(self, *, older_than_seconds: int = 30 * 86400) -> dict[str, int]:
        if type(older_than_seconds) is not int or not 86400 <= older_than_seconds <= 3650 * 86400:
            raise ValueError("Cleanup age must be between 1 and 3650 days")
        cutoff = time.time() - older_than_seconds
        terminal = ("complete", "failed", "ambiguous", "cancelled")
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            ids = [row[0] for row in db.execute("SELECT id FROM pool_tasks WHERE status IN (?,?,?,?) AND updated<?",
                                                (*terminal, cutoff))]
            if ids:
                db.executemany("DELETE FROM pool_events WHERE task_id=?", ((task_id,) for task_id in ids))
                db.executemany("DELETE FROM pool_tasks WHERE id=?", ((task_id,) for task_id in ids))
            old_events = db.execute("DELETE FROM pool_events WHERE at<?", (cutoff,)).rowcount
            db.commit()
        return {"tasks_deleted": len(ids), "events_deleted": old_events}


def read_maintenance_status(db_path: str | Path) -> dict[str, Any]:
    """Read existing private maintenance state without initializing or acknowledging it."""
    path = Path(db_path)
    try:
        if not path.is_absolute() or "\x00" in str(path) or any(part.is_symlink() for part in (path, *path.parents)):
            raise ValueError("maintenance_unavailable")
        info = path.lstat()
        parent = path.parent.lstat()
        if (not path.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077
                or not path.parent.is_dir() or path.parent.is_symlink() or parent.st_uid != os.getuid() or parent.st_mode & 0o077):
            raise ValueError("maintenance_unavailable")
        uri = path.as_uri() + "?mode=ro"
        db = sqlite3.connect(uri, uri=True, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        try:
            db.execute("BEGIN")
            columns = tuple(row[1] for row in db.execute("PRAGMA table_info(pool_maintenance)"))
            task_columns = tuple(row[1] for row in db.execute("PRAGMA table_info(pool_tasks)"))
            if columns != MAINTENANCE_TABLE_COLUMNS or "status" not in task_columns:
                raise ValueError("maintenance_unavailable")
            row = OraclePool._maintenance_row(db)
            result = OraclePool._maintenance_dto(row, OraclePool._maintenance_blockers(db))
            db.commit()
            return result
        finally:
            db.close()
    except ValueError:
        raise
    except (OSError, sqlite3.DatabaseError, RuntimeError) as exc:
        raise ValueError("maintenance_unavailable") from exc


def _json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Private bounded Oracle Ollama text-task pool")
    parser.add_argument("--config", help="private config path")
    parser.add_argument("--db", help="private SQLite path")
    sub = parser.add_subparsers(dest="command", required=True)
    catalog = sub.add_parser("catalog", help="show cached model catalogs; --refresh checks the three fixed VMs")
    catalog.add_argument("--refresh", action="store_true")
    submit = sub.add_parser("submit", help="submit bounded task text from a private file or stdin")
    source_group = submit.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--file", help="read task text from file; use - for stdin")
    source_group.add_argument("--stdin", action="store_true", help="read task text from stdin")
    submit.add_argument("--model", default=DEFAULT_MODEL)
    submit.add_argument("--id")
    submit.add_argument("--source")
    batch = sub.add_parser("submit-batch", help="atomically queue independent tasks; never runs inference")
    batch.add_argument("--stdin-json", action="store_true", required=True)
    cancel = sub.add_parser("cancel", help="cancel queued work only")
    cancel.add_argument("--id", required=True)
    status = sub.add_parser("status", help="show safe status metadata")
    status.add_argument("--id")
    results = sub.add_parser("results", help="read text result by ID, or latest available results")
    results.add_argument("--id")
    events = sub.add_parser("events", help="read the bounded safe event inbox")
    events.add_argument("--after", type=int, default=0)
    events.add_argument("--limit", type=int, default=100)
    maintenance_request = sub.add_parser("maintenance-request", help="pause new claims and request a drain acknowledgement")
    maintenance_request.add_argument("--revision", required=True)
    maintenance_request.add_argument("--epoch", required=True, type=int)
    maintenance_release = sub.add_parser("maintenance-release", help="abort maintenance and resume claims without restarting")
    maintenance_release.add_argument("--revision", required=True)
    maintenance_release.add_argument("--epoch", required=True, type=int)
    sub.add_parser("maintenance-status", help="read the current maintenance fence")
    sub.add_parser("run-once", help="run up to three queued jobs; requires a refreshed model catalog")
    sub.add_parser("serve", help="run a local polling worker; no inference occurs while the queue is empty")
    cleanup = sub.add_parser("cleanup", help="remove terminal tasks and events older than the retention age")
    cleanup.add_argument("--older-than-days", type=int, default=30)
    args = parser.parse_args(argv)
    try:
        pool = OraclePool(args.config, args.db)
        if args.command == "catalog":
            _json(pool.catalog(refresh=args.refresh))
        elif args.command == "submit":
            text = Path(args.file).read_text(encoding="utf-8") if args.file and args.file != "-" else sys.stdin.read()
            _json(pool.submit(text, model=args.model, job_id=args.id, source=args.source))
        elif args.command == "submit-batch":
            payload = sys.stdin.buffer.read(512 * 1024 + 1)
            if len(payload) > 512 * 1024:
                raise ValueError("Batch input too large")
            request = json.loads(payload)
            if type(request) is not dict or set(request) != {"tasks"}:
                raise ValueError("Invalid batch request")
            _json(pool.submit_batch(request["tasks"]))
        elif args.command == "cancel":
            _json(pool.cancel(args.id))
        elif args.command == "status":
            _json(pool.status(args.id))
        elif args.command == "results":
            _json(pool.results(args.id))
        elif args.command == "events":
            _json(pool.events(after=args.after, limit=args.limit))
        elif args.command == "maintenance-status":
            _json(pool.maintenance_status())
        elif args.command == "maintenance-request":
            _json(pool.request_maintenance(args.revision, args.epoch))
        elif args.command == "maintenance-release":
            _json(pool.release_maintenance(args.epoch, args.revision))
        elif args.command == "run-once":
            _json(pool.run_once())
        elif args.command == "cleanup":
            _json(pool.cleanup(older_than_seconds=args.older_than_days * 86400))
        elif args.command == "serve":
            stopped = threading.Event()
            for signum in (signal.SIGINT, signal.SIGTERM):
                signal.signal(signum, lambda *_: stopped.set())
            while not stopped.is_set():
                outcome = pool.run_once()
                if outcome["claimed"]:
                    _json(outcome)
                else:
                    stopped.wait(2)
        return 0
    except (PoolError, ValueError, KeyError, OSError) as exc:
        # The bounded MCP bridge reads structured failures from stdout and discards stderr.
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
