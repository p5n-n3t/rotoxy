"""Owner-only cached Oracle model inventory. Refresh is explicit and read-only."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
import sqlite3
import stat
import sys
import time
from pathlib import Path
from typing import Any, Callable

from .oracle_fleet_config import _locked as _fleet_lock, _read as _read_fleet
from .oracle_pool import MODEL_NAME_RE, PoolError, SSHOllamaTransport

MAX_INPUT = 8 * 1024
MAX_CACHE = 256 * 1024
MAX_REMOTE_BYTES = 256 * 1024
MAX_MODELS = 256
MAX_TEXT = 160
STATUSES = {"queued", "running", "complete", "failed", "ambiguous", "cancelled", "dispatching"}
_TAGS_SCRIPT = """import json, urllib.request, urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
try:
    with opener.open('http://127.0.0.1:11434/api/tags', timeout=5) as response:
        body = response.read(262145)
        if len(body) > 262144: raise ValueError('response_too_large')
        print(json.dumps({'status': 'healthy', 'body': json.loads(body)}))
except Exception:
    print(json.dumps({'status': 'unavailable', 'body': None}))
"""


def revision(raw: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(hashlib.sha256(raw).digest()[:18]).decode().rstrip("=")


def _private_path(path: Path, create_parent: bool = False) -> None:
    if not path.is_absolute() or "\0" in str(path):
        raise ValueError("invalid_private_path")
    if create_parent:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(path.parent, 0o700)
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or stat.S_ISLNK(parent.st_mode) or parent.st_mode & 0o077 or (hasattr(os, "getuid") and parent.st_uid != os.getuid()):
        raise ValueError("private_directory_invalid")


def _read_cache(path: Path) -> tuple[bytes, dict[str, Any]]:
    if not path.parent.exists():
        return b"", {"version": 1, "fleetRevision": None, "updatedAt": None, "hosts": {}}
    _private_path(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return b"", {"version": 1, "fleetRevision": None, "updatedAt": None, "hosts": {}}
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o077 or info.st_size > MAX_CACHE or (hasattr(os, "getuid") and info.st_uid != os.getuid()):
        raise ValueError("cache_permissions_invalid")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(fd)
        if opened.st_ino != info.st_ino or opened.st_dev != info.st_dev or not stat.S_ISREG(opened.st_mode) or opened.st_mode & 0o077 or opened.st_size > MAX_CACHE:
            raise ValueError("cache_changed")
        raw = os.read(fd, MAX_CACHE + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_CACHE:
        raise ValueError("cache_too_large")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("cache_invalid") from exc
    if type(value) is not dict or set(value) != {"version", "fleetRevision", "updatedAt", "hosts"} or value["version"] != 1 or type(value["hosts"]) is not dict:
        raise ValueError("cache_invalid")
    return raw, value


def _atomic(path: Path, data: bytes) -> None:
    _private_path(path, create_parent=True)
    temp = path.with_name(path.name + f".tmp.{os.getpid()}.{time.time_ns()}")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as out:
            out.write(data); out.flush(); os.fsync(out.fileno())
    finally:
        os.close(fd)
    os.replace(temp, path); os.chmod(path, 0o600)
    dfd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try: os.fsync(dfd)
    finally: os.close(dfd)


@contextmanager
def _cache_lock(path: Path):
    _private_path(path, create_parent=True)
    lock = path.with_name(path.name + ".lock")
    try: fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc: raise ValueError("cache_locked") from exc
    try:
        os.write(fd, f"{os.getpid()}\n".encode()); os.fsync(fd); yield
    finally:
        os.close(fd)
        try: os.unlink(lock)
        except FileNotFoundError: pass


def _write_cache(path: Path, old_raw: bytes, value: dict[str, Any], expected_revision: str) -> tuple[bytes, dict[str, Any]]:
    encoded = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    if len(encoded) > MAX_CACHE: raise ValueError("cache_too_large")
    backup = path.with_name(path.name + ".backup." + revision(old_raw))
    backup_data = old_raw or b'{"absent":true}\n'
    if backup.exists():
        if backup.is_symlink() or backup.read_bytes() != backup_data: raise ValueError("backup_collision")
    else: _atomic(backup, backup_data)
    _atomic(path, encoded)
    return encoded, value


def _fleet(path: Path) -> tuple[bytes, list[dict[str, Any]]]:
    raw, _config, hosts = _read_fleet(path)
    return raw, [dict(host) for host in hosts]


def _endpoint_token(host: dict[str, Any]) -> str:
    material = json.dumps([host.get("ip"), host.get("ssh_host")], separators=(",", ":")).encode()
    return hashlib.sha256(material).hexdigest()[:24]


def _clean_models(body: Any) -> list[dict[str, Any]]:
    if type(body) is not dict or type(body.get("models")) is not list:
        raise ValueError("model_catalog_invalid")
    result, seen = [], set()
    for row in body["models"][:MAX_MODELS]:
        if type(row) is not dict: continue
        name = row.get("name")
        size = row.get("size")
        modified = row.get("modified_at")
        if not isinstance(name, str) or not MODEL_NAME_RE.fullmatch(name) or name in seen: continue
        if type(size) is not int or not 0 <= size <= 2**53 - 1: size = None
        if not isinstance(modified, str) or len(modified) > 64 or not modified.isprintable(): modified = None
        seen.add(name); result.append({"name": name, "size": size, "modifiedAt": modified})
    return result


def _queue_state(db_path: Path, host_ids: list[str]) -> dict[str, Any]:
    unknown = {"available": False, "reason": "queue_state_unavailable", "hosts": {}}
    try:
        info = db_path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o077 or (hasattr(os, "getuid") and info.st_uid != os.getuid()): return unknown
        from urllib.parse import quote
        uri = "file:" + quote(str(db_path), safe="/") + "?mode=ro"
        db = sqlite3.connect(uri, uri=True, timeout=2)
        db.row_factory = sqlite3.Row; db.execute("PRAGMA query_only=ON"); db.execute("BEGIN")
        statuses = {row[0]: int(row[1]) for row in db.execute("SELECT status,COUNT(*) FROM pool_tasks GROUP BY status")}
        if any(name not in STATUSES or type(count) is not int or count < 0 for name, count in statuses.items()):
            db.close(); return {**unknown, "reason": "queue_state_unknown"}
        assigned = {host: {"running": 0, "assigned": 0} for host in host_ids}
        for row in db.execute("SELECT assigned_host,status,COUNT(*) FROM pool_tasks WHERE assigned_host IS NOT NULL GROUP BY assigned_host,status"):
            if row[0] in assigned:
                assigned[row[0]]["assigned"] += int(row[2])
                if row[1] == "running": assigned[row[0]]["running"] += int(row[2])
        db.close()
        blocked = sum(statuses.get(state, 0) for state in ("running", "ambiguous", "dispatching"))
        return {"available": True, "reason": None, "statuses": statuses, "hosts": assigned,
                "applySafeAtRead": blocked == 0 and statuses.get("unknown", 0) == 0}
    except (OSError, sqlite3.Error, KeyError, TypeError):
        return unknown


def _maintenance_value(value: Any) -> dict[str, Any] | None:
    required = {"epoch", "paused", "configRevision", "acknowledged", "blockers", "reason"}
    if type(value) is not dict or set(value) != required:
        return None
    blockers = value["blockers"]
    if (type(value["epoch"]) is not int or value["epoch"] < 0 or type(value["paused"]) is not bool or
            not (value["configRevision"] is None or isinstance(value["configRevision"], str) and len(value["configRevision"]) <= 64) or
            type(value["acknowledged"]) is not bool or type(blockers) is not dict or set(blockers) != {"running", "ambiguous", "dispatching"} or
            any(type(blockers[key]) is not int or blockers[key] < 0 for key in blockers) or
            not (value["reason"] is None or isinstance(value["reason"], str) and len(value["reason"]) <= 200)):
        return None
    return {key: (dict(blockers) if key == "blockers" else value[key]) for key in required}


def _maintenance_readonly(db_path: Path) -> dict[str, Any] | None:
    """Use the core's supported read-only helper; never guess its SQLite schema."""
    try:
        from .oracle_pool import read_maintenance_status
        return _maintenance_value(read_maintenance_status(db_path))
    except ValueError:
        return None
    except (ImportError, AttributeError):
        # Older pool builds do not expose the fence reader, so report unavailable.
        return None


def _core_pool(db_path: Path):
    # Mutations use only the core's explicit existing-database-only factory.
    from .oracle_pool import OraclePool
    factory = getattr(OraclePool, "open_maintenance", None)
    if not callable(factory):
        raise ValueError("maintenance_api_unavailable")
    return factory(db_path)


def _maintenance_action(config_path: Path, db_path: Path, cache_path: Path, action: str,
                        expected_revision: str, expected_epoch: int,
                        pool_factory: Callable[[Path], Any] = _core_pool) -> dict[str, Any]:
    if type(expected_epoch) is not int or expected_epoch < 0:
        raise ValueError("maintenance_epoch_invalid")
    with _fleet_lock(config_path):
        fleet_raw, _hosts = _fleet(config_path)
        if revision(fleet_raw) != expected_revision:
            raise ValueError("maintenance_revision_conflict")
        pool = pool_factory(db_path)
        method = getattr(pool, "request_maintenance" if action == "maintenance-request" else "release_maintenance", None)
        if not callable(method):
            raise ValueError("maintenance_api_unavailable")
        fence_revision = expected_revision
        if action == "maintenance-release":
            # Abort the pinned pause even if the operator has since edited the fleet.
            # The displayed current config revision is still checked above; release
            # does not reload that configuration into the running daemon.
            fence = _maintenance_readonly(db_path)
            if fence is None:
                raise ValueError("maintenance_unavailable")
            if fence["epoch"] != expected_epoch:
                raise ValueError("maintenance_epoch_conflict")
            if not fence["paused"] or fence["configRevision"] is None:
                raise ValueError("maintenance_revision_conflict")
            fence_revision = fence["configRevision"]
        result = _maintenance_value(method(config_revision=fence_revision, expected_epoch=expected_epoch))
        if result is None:
            raise ValueError("maintenance_response_invalid")
    view = snapshot(config_path, db_path, cache_path)
    view["maintenance"] = result
    return view


def _apply_controller(config_path: Path, db_path: Path):
    """Load the separately-owned coordinator only when its integration is installed."""
    try:
        from .oracle_apply import OracleApplyController
    except (ImportError, AttributeError):
        return None
    return OracleApplyController(config_path, db_path, wait_seconds=15)


def _apply_status_value(value: Any) -> dict[str, Any] | None:
    required = {"daemon", "operation", "maintenance", "ready", "reason"}
    if type(value) is not dict or set(value) != required or type(value["ready"]) is not bool or not (value["reason"] is None or isinstance(value["reason"], str) and len(value["reason"]) <= 200):
        return None
    daemon = value["daemon"]
    daemon_fields = {"available", "instanceId", "loadedRevision", "heartbeatAt", "observedEpoch", "alive"}
    if (type(daemon) is not dict or set(daemon) != daemon_fields or type(daemon["available"]) is not bool or type(daemon["alive"]) is not bool or
            not (daemon["instanceId"] is None or isinstance(daemon["instanceId"], str) and len(daemon["instanceId"]) <= 128) or
            not (daemon["loadedRevision"] is None or isinstance(daemon["loadedRevision"], str) and len(daemon["loadedRevision"]) <= 64) or
            not (daemon["heartbeatAt"] is None or type(daemon["heartbeatAt"]) in (int, float) and daemon["heartbeatAt"] >= 0) or
            not (daemon["observedEpoch"] is None or type(daemon["observedEpoch"]) is int and daemon["observedEpoch"] >= 0)):
        return None
    operation = value["operation"]
    if operation is not None:
        fields = {"applyId", "epoch", "targetRevision", "previousInstance", "status", "error"}
        if (type(operation) is not dict or set(operation) != fields or not isinstance(operation["applyId"], str) or len(operation["applyId"]) > 128 or
                type(operation["epoch"]) is not int or operation["epoch"] < 0 or not isinstance(operation["targetRevision"], str) or len(operation["targetRevision"]) > 64 or
                not (operation["previousInstance"] is None or isinstance(operation["previousInstance"], str) and len(operation["previousInstance"]) <= 128) or
                operation["status"] not in {"prepared", "complete", "failed"} or not (operation["error"] is None or isinstance(operation["error"], str) and len(operation["error"]) <= 200)):
            return None
    if value["maintenance"] is not None and type(value["maintenance"]) is not dict:
        return None
    return value


def _read_apply_status(config_path: Path, db_path: Path, controller_factory: Callable[[Path, Path], Any] = _apply_controller) -> dict[str, Any] | None:
    try:
        controller = controller_factory(config_path, db_path)
        if controller is None:
            return None
        return _apply_status_value(controller.status())
    except (ImportError, AttributeError, ValueError, OSError, sqlite3.Error):
        return None


def snapshot(config_path: Path, db_path: Path, cache_path: Path,
             controller_factory: Callable[[Path, Path], Any] = _apply_controller) -> dict[str, Any]:
    fleet_raw, hosts = _fleet(config_path)
    cache_raw, cache = _read_cache(cache_path)
    stored = cache["hosts"] if type(cache.get("hosts")) is dict else {}
    queue = _queue_state(db_path, [h["id"] for h in hosts])
    rows = []
    for host in hosts:
        candidate = stored.get(host["id"], {}) if type(stored.get(host["id"], {})) is dict else {}
        saved = candidate if candidate.get("endpoint") == _endpoint_token(host) else {}
        installed = saved.get("models", []) if isinstance(saved.get("models"), list) else []
        rows.append({"id": host["id"], "enabled": host["enabled"], "allowedModels": host["allowedModels"],
                     "hostStatus": saved.get("status", "unknown"), "models": installed,
                     "observedAt": saved.get("observedAt"), "load": queue["hosts"].get(host["id"]) if queue["available"] else None})
    return {"cacheRevision": revision(cache_raw), "configRevision": revision(fleet_raw), "cacheUpdatedAt": cache.get("updatedAt"),
            "hosts": rows, "queue": queue, "maintenance": _maintenance_readonly(db_path),
            "applyStatus": _read_apply_status(config_path, db_path, controller_factory),
            "apply": {"mode": "previewOnly", "blockedReason": "Restart/reload protocol is not yet validated; changes remain preview-only."}}


def refresh(config_path: Path, db_path: Path, cache_path: Path, expected_cache_revision: str,
            ssh_probe: Callable[[dict[str, Any], str], Any] | None = None) -> dict[str, Any]:
    fleet_raw, hosts = _fleet(config_path)
    old_raw, old = _read_cache(cache_path)
    if revision(old_raw) != expected_cache_revision: raise ValueError("cache_revision_conflict")
    refreshed = {}
    for host in hosts:
        if not host["enabled"]:
            refreshed[host["id"]] = {"endpoint": _endpoint_token(host), "status": "disabled", "models": [], "observedAt": None}; continue
        try:
            response = ssh_probe(host, _TAGS_SCRIPT) if ssh_probe else SSHOllamaTransport(hosts=(host,))._ssh(host["id"], _TAGS_SCRIPT, timeout=8)
            if type(response) is not dict or response.get("status") != "healthy": raise ValueError("catalog_unavailable")
            payload = response.get("body")
            if payload is None and "models" in response: payload = response
            refreshed[host["id"]] = {"endpoint": _endpoint_token(host), "status": "healthy", "models": _clean_models(payload), "observedAt": time.time()}
        except Exception:
            refreshed[host["id"]] = {"endpoint": _endpoint_token(host), "status": "unavailable", "models": [], "observedAt": time.time()}
    value = {"version": 1, "fleetRevision": revision(fleet_raw), "updatedAt": time.time(), "hosts": refreshed}
    with _cache_lock(cache_path):
        current_raw, _current = _read_cache(cache_path)
        if revision(current_raw) != expected_cache_revision: raise ValueError("cache_revision_conflict")
        _write_cache(cache_path, current_raw, value, expected_cache_revision)
    return snapshot(config_path, db_path, cache_path)


def apply_preview(config_path: Path, db_path: Path, cache_path: Path, expected_config_revision: str) -> dict[str, Any]:
    current = snapshot(config_path, db_path, cache_path)
    if current["configRevision"] != expected_config_revision: raise ValueError("config_revision_conflict")
    queue = current["queue"]
    if not queue["available"]:
        reason = queue["reason"]
    elif not queue.get("applySafeAtRead"):
        reason = "Queue has running, ambiguous, dispatching, or unknown task state."
    else:
        reason = "Restart/reload protocol is not yet validated; changes remain preview-only."
    current["apply"] = {"mode": "previewOnly", "blockedReason": reason}
    return current


def apply_request(config_path: Path, db_path: Path, cache_path: Path, request: Any,
                  ssh_probe: Callable[[dict[str, Any], str], Any] | None = None,
                  pool_factory: Callable[[Path], Any] = _core_pool,
                  controller_factory: Callable[[Path, Path], Any] = _apply_controller) -> dict[str, Any]:
    if type(request) is not dict or not isinstance(request.get("action"), str): raise ValueError("request_invalid")
    if request["action"] == "read" and set(request) == {"action"}: return snapshot(config_path, db_path, cache_path, controller_factory)
    if request["action"] == "refresh" and set(request) == {"action", "expectedCacheRevision"}:
        token = request["expectedCacheRevision"]
        if not isinstance(token, str) or len(token) != 24: raise ValueError("revision_invalid")
        return refresh(config_path, db_path, cache_path, token, ssh_probe)
    if request["action"] == "apply" and set(request) == {"action", "expectedConfigRevision"}:
        token = request["expectedConfigRevision"]
        if not isinstance(token, str) or len(token) != 24: raise ValueError("revision_invalid")
        current = apply_preview(config_path, db_path, cache_path, token)
        current["applyStatus"] = _read_apply_status(config_path, db_path, controller_factory)
        return current
    if request["action"] == "apply-config" and set(request) == {"action", "expectedConfigRevision", "expectedEpoch"}:
        token, epoch = request["expectedConfigRevision"], request["expectedEpoch"]
        if not isinstance(token, str) or len(token) != 24: raise ValueError("apply_revision_invalid")
        if type(epoch) is not int or epoch < 0: raise ValueError("apply_epoch_invalid")
        current = snapshot(config_path, db_path, cache_path, controller_factory)
        if current["configRevision"] != token: raise ValueError("apply_revision_conflict")
        controller = controller_factory(config_path, db_path)
        if controller is None: raise ValueError("apply_coordinator_unavailable")
        status = _apply_status_value(controller.apply(expected_config_revision=token, expected_epoch=epoch))
        if status is None: raise ValueError("apply_status_invalid")
        current["applyStatus"] = status
        return current
    if request["action"] in {"maintenance-request", "maintenance-release"} and set(request) == {"action", "expectedConfigRevision", "expectedEpoch"}:
        token, epoch = request["expectedConfigRevision"], request["expectedEpoch"]
        if not isinstance(token, str) or len(token) != 24: raise ValueError("maintenance_revision_invalid")
        if type(epoch) is not int or epoch < 0: raise ValueError("maintenance_epoch_invalid")
        return _maintenance_action(config_path, db_path, cache_path, request["action"], token, epoch, pool_factory)
    raise ValueError("request_invalid")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True); parser.add_argument("--db", required=True); parser.add_argument("--cache", required=True)
    args = parser.parse_args(argv)
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT: raise ValueError("request_too_large")
        out = apply_request(Path(args.config), Path(args.db), Path(args.cache), json.loads(raw))
        encoded = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode()) > MAX_CACHE: raise ValueError("response_too_large")
        print(encoded); return 0
    except (ValueError, OSError, sqlite3.Error, json.JSONDecodeError, PoolError) as exc:
        known = {"request_invalid", "request_too_large", "revision_invalid", "cache_revision_conflict", "config_revision_conflict", "maintenance_revision_invalid", "maintenance_epoch_invalid", "maintenance_epoch_conflict", "maintenance_revision_conflict", "maintenance_api_unavailable", "maintenance_response_invalid", "apply_revision_invalid", "apply_epoch_invalid", "apply_revision_conflict", "apply_epoch_conflict", "apply_coordinator_unavailable", "apply_not_ready", "apply_status_invalid", "cache_locked", "cache_invalid", "cache_too_large", "cache_permissions_invalid", "private_directory_invalid", "invalid_private_path", "backup_collision", "queue_state_unavailable", "fleet_config_unavailable"}
        msg = str(exc)
        print(json.dumps({"error": msg if msg in known else "oracle_model_inventory_failed"}, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
