"""Owner-only inventory and explicitly requested passive probes for private services."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import ipaddress
import json
import os
import re
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

from .oracle_pool import HOST_ID_RE, PoolError, SSHOllamaTransport
from .oracle_fleet_config import _read as _read_fleet_config

MAX_INPUT = 16 * 1024
MAX_CONFIG = 32 * 1024
MAX_PROBE_OUTPUT = 32 * 1024
SERVICE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,47}\Z")
ALIAS = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/+@-]{0,119}\Z")
SSH_ALIAS = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\Z")

_LITELLM_PROBE_SCRIPT = """import json, urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
def get(path, limit):
    with opener.open('http://127.0.0.1:4000' + path, timeout=3) as response:
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError('response_too_large')
        return response.status, body
try:
    health_status, _ = get('/health/liveliness', 8192)
    models_status, body = get('/v1/models', 131072)
    decoded = json.loads(body)
    rows = decoded.get('data') if isinstance(decoded, dict) else None
    aliases = []
    if isinstance(rows, list):
        for row in rows[:100]:
            alias = row.get('id') if isinstance(row, dict) else None
            if isinstance(alias, str) and 0 < len(alias) <= 120 and alias.isprintable() and alias not in aliases:
                aliases.append(alias)
    print(json.dumps({'status': 'healthy' if health_status == 200 and models_status == 200 else 'unavailable', 'aliases': aliases}))
except Exception:
    print(json.dumps({'status': 'unavailable', 'aliases': []}))
"""


def _revision(raw: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(hashlib.sha256(raw).digest()[:18]).decode().rstrip("=")


def defaults() -> dict[str, Any]:
    return {"version": 1, "services": [
        {"id": "litellm-ora3", "kind": "litellm", "label": "LiteLLM on ora3", "hostId": "ora3", "enabled": True,
         "probe": {"status": "unknown", "checkedAt": None, "aliases": []}},
        {"id": "desktop-loopback", "kind": "loopback", "label": "Desktop loopback", "hostId": "desktop", "enabled": True,
         "probe": {"status": "unknown", "checkedAt": None, "aliases": []}},
    ]}


def _private_parent(path: Path, create: bool = False) -> None:
    if create:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(path.parent, 0o700)
    try:
        info = path.parent.lstat()
    except OSError as exc:
        raise ValueError("registry_directory_unavailable") from exc
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o077 or (hasattr(os, "getuid") and info.st_uid != os.getuid()):
        raise ValueError("registry_directory_permissions_invalid")


def _validate_service(raw: Any) -> dict[str, Any]:
    fields = {"id", "kind", "label", "hostId", "enabled", "probe"}
    if type(raw) is not dict or set(raw) != fields:
        raise ValueError("registry_invalid")
    service_id, kind, label, host_id = raw["id"], raw["kind"], raw["label"], raw["hostId"]
    if not isinstance(service_id, str) or not SERVICE_ID.fullmatch(service_id):
        raise ValueError("service_id_invalid")
    if not isinstance(kind, str) or kind not in {"litellm", "loopback"}:
        raise ValueError("service_kind_invalid")
    if not isinstance(label, str) or not 1 <= len(label.strip()) <= 80 or not label.isprintable():
        raise ValueError("service_label_invalid")
    if type(raw["enabled"]) is not bool:
        raise ValueError("service_enabled_invalid")
    if kind == "loopback":
        if host_id != "desktop": raise ValueError("service_host_invalid")
    elif not isinstance(host_id, str) or not HOST_ID_RE.fullmatch(host_id):
        raise ValueError("service_host_invalid")
    probe = raw["probe"]
    if type(probe) is not dict or set(probe) != {"status", "checkedAt", "aliases"}:
        raise ValueError("probe_invalid")
    status = probe["status"]
    if not isinstance(status, str) or status not in {"unknown", "healthy", "reachable", "unavailable"}:
        raise ValueError("probe_invalid")
    checked = probe["checkedAt"]
    if checked is not None and (type(checked) not in {int, float} or not 0 <= checked <= 8_640_000_000_000_000):
        raise ValueError("probe_invalid")
    aliases = probe["aliases"]
    if type(aliases) is not list or len(aliases) > 100 or any(not isinstance(x, str) or len(x) > 120 or not x.isprintable() for x in aliases):
        raise ValueError("probe_invalid")
    return {"id": service_id, "kind": kind, "label": label.strip(), "hostId": host_id,
            "enabled": raw["enabled"], "probe": {"status": status, "checkedAt": checked, "aliases": list(dict.fromkeys(aliases))}}


def validate_registry(value: Any) -> dict[str, Any]:
    if type(value) is not dict or set(value) != {"version", "services"} or value["version"] != 1 or type(value["services"]) is not list or len(value["services"]) > 32:
        raise ValueError("registry_invalid")
    services = [_validate_service(item) for item in value["services"]]
    ids = [service["id"] for service in services]
    if len(ids) != len(set(ids)):
        raise ValueError("service_id_duplicate")
    return {"version": 1, "services": services}


def _read(path: Path) -> tuple[bytes, dict[str, Any]]:
    if not path.is_absolute() or "\x00" in str(path): raise ValueError("invalid_registry_path")
    if path.parent.exists(): _private_parent(path)
    try: info = path.lstat()
    except FileNotFoundError: return b"", validate_registry(defaults())
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or (hasattr(os, "getuid") and info.st_uid != os.getuid()) or info.st_size > MAX_CONFIG:
        raise ValueError("registry_permissions_invalid")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_dev != info.st_dev or opened.st_ino != info.st_ino or opened.st_mode & 0o077 or opened.st_size > MAX_CONFIG:
            raise ValueError("registry_changed")
        raw = os.read(fd, MAX_CONFIG + 1)
    finally: os.close(fd)
    if len(raw) > MAX_CONFIG: raise ValueError("registry_too_large")
    try: registry = validate_registry(json.loads(raw))
    except (json.JSONDecodeError, TypeError) as exc: raise ValueError("registry_invalid") from exc
    return raw, registry


def _atomic(path: Path, data: bytes) -> None:
    _private_parent(path, create=True)
    temp = path.with_name(path.name + f".tmp.{os.getpid()}.{time.time_ns()}")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as out:
            out.write(data); out.flush(); os.fsync(out.fileno())
    finally: os.close(fd)
    os.replace(temp, path); os.chmod(path, 0o600)


@contextmanager
def _lock(path: Path):
    _private_parent(path, create=True)
    lock = path.with_name(path.name + ".lock")
    try: fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc: raise ValueError("registry_locked") from exc
    try:
        os.write(fd, f"{os.getpid()}\n".encode()); os.fsync(fd); yield
    finally:
        os.close(fd)
        try: os.unlink(lock)
        except FileNotFoundError: pass


def _view(raw: bytes, registry: dict[str, Any]) -> dict[str, Any]:
    return {"revision": _revision(raw), "registry": registry}


def _fleet_hosts(path: Path) -> dict[str, dict[str, Any]]:
    try:
        _, _, hosts = _read_fleet_config(path)
    except (OSError, ValueError, PoolError) as exc:
        raise ValueError("fleet_config_unavailable") from exc
    return {host["id"]: dict(host) for host in hosts}


def _probe(service: dict[str, Any], fleet_path: Path,
           ssh_probe: Callable[[str, str, str], dict[str, Any]] | None = None) -> dict[str, Any]:
    if service["kind"] == "loopback":
        import socket
        try:
            with socket.create_connection(("127.0.0.1", 2026), timeout=2):
                return {"status": "reachable", "checkedAt": time.time(), "aliases": []}
        except OSError:
            return {"status": "unavailable", "checkedAt": time.time(), "aliases": []}
    host = _fleet_hosts(fleet_path).get(service["hostId"])
    if not host or not host["enabled"]:
        raise ValueError("fleet_host_not_enabled")
    if not host["ip"] or not SSH_ALIAS.fullmatch(host["ssh_host"]):
        raise ValueError("fleet_host_invalid")
    if ssh_probe:
        result = ssh_probe(host["id"], host["ip"], host["ssh_host"])
    else:
        transport = SSHOllamaTransport(hosts=({**host, "enabled": True},))
        result = transport._ssh(host["id"], _LITELLM_PROBE_SCRIPT, timeout=8)
    if type(result) is not dict or result.get("status") not in {"healthy", "unavailable"} or type(result.get("aliases")) is not list:
        raise ValueError("probe_response_invalid")
    aliases = []
    for alias in result["aliases"][:100]:
        if isinstance(alias, str):
            cleaned = alias.strip()
            if 0 < len(cleaned) <= 120 and cleaned.isprintable() and ALIAS.fullmatch(cleaned) and cleaned not in aliases: aliases.append(cleaned)
    return {"status": result["status"], "checkedAt": time.time(), "aliases": aliases}


def apply(path: Path, fleet_path: Path, request: Any,
          ssh_probe: Callable[[str, str, str], dict[str, Any]] | None = None) -> dict[str, Any]:
    if type(request) is not dict or not isinstance(request.get("action"), str) or request.get("action") not in {"read", "add", "update", "remove", "probe"}:
        raise ValueError("request_invalid")
    action = request["action"]
    if action == "read":
        if set(request) != {"action"}: raise ValueError("request_invalid")
        raw, registry = _read(path)
        return _view(raw, registry)
    target = request.get("targetId")
    revision = request.get("revision")
    if not isinstance(revision, str) or len(revision) != 24: raise ValueError("revision_invalid")
    if action == "probe":
        if set(request) != {"action", "revision", "targetId"} or not isinstance(target, str): raise ValueError("request_invalid")
        old_raw, registry = _read(path)
        if _revision(old_raw) != revision: raise ValueError("revision_conflict")
        service = next((row for row in registry["services"] if row["id"] == target), None)
        if not service: raise ValueError("service_not_found")
        if not service["enabled"]: raise ValueError("service_disabled")
        result = _probe(service, fleet_path, ssh_probe)
        with _lock(path):
            current_raw, current = _read(path)
            if _revision(current_raw) != revision: raise ValueError("revision_conflict")
            for row in current["services"]:
                if row["id"] == target: row["probe"] = result
            return _save(path, current_raw, current)
    with _lock(path):
        old_raw, current = _read(path)
        if _revision(old_raw) != revision: raise ValueError("revision_conflict")
        services = current["services"]
        if action == "add":
            if set(request) != {"action", "revision", "service"}: raise ValueError("request_invalid")
            service = _validate_service(request["service"])
            if service["kind"] == "litellm" and service["hostId"] not in _fleet_hosts(fleet_path): raise ValueError("service_host_unapproved")
            if any(row["id"] == service["id"] for row in services): raise ValueError("service_exists")
            services.append(service)
        elif action == "update":
            if set(request) != {"action", "revision", "targetId", "service"} or not isinstance(target, str): raise ValueError("request_invalid")
            service = _validate_service(request["service"])
            if service["kind"] == "litellm" and service["hostId"] not in _fleet_hosts(fleet_path): raise ValueError("service_host_unapproved")
            index = next((i for i, row in enumerate(services) if row["id"] == target), None)
            if index is None: raise ValueError("service_not_found")
            if any(i != index and row["id"] == service["id"] for i, row in enumerate(services)): raise ValueError("service_exists")
            # Keep cached probe data only when the probed endpoint identity is unchanged.
            prior = services[index]
            if (prior["kind"], prior["hostId"]) == (service["kind"], service["hostId"]): service["probe"] = prior["probe"]
            services[index] = service
        else:
            if set(request) != {"action", "revision", "targetId"} or not isinstance(target, str): raise ValueError("request_invalid")
            next_services = [row for row in services if row["id"] != target]
            if len(next_services) == len(services): raise ValueError("service_not_found")
            services[:] = next_services
        return _save(path, old_raw, validate_registry(current))


def _save(path: Path, old_raw: bytes, registry: dict[str, Any]) -> dict[str, Any]:
    backup_data = old_raw if old_raw else b'{"absent":true}\n'
    backup = path.with_name(path.name + ".backup." + _revision(old_raw))
    if backup.exists():
        if backup.is_symlink() or backup.read_bytes() != backup_data: raise ValueError("backup_collision")
    else:
        _atomic(backup, backup_data)
    encoded = (json.dumps(registry, ensure_ascii=False, indent=2) + "\n").encode()
    if len(encoded) > MAX_CONFIG: raise ValueError("registry_too_large")
    _atomic(path, encoded)
    return _view(encoded, registry)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Private service inventory and passive probe helper")
    parser.add_argument("--registry", required=True)
    parser.add_argument("--fleet-config", required=True)
    args = parser.parse_args(argv)
    try:
        request = json.loads(sys.stdin.buffer.read(MAX_INPUT + 1))
        if len(json.dumps(request).encode()) > MAX_INPUT: raise ValueError("request_too_large")
        result = apply(Path(args.registry), Path(args.fleet_config), request)
        output = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        if len(output.encode()) > MAX_PROBE_OUTPUT: raise ValueError("response_too_large")
        print(output)
        return 0
    except (ValueError, OSError, json.JSONDecodeError, PoolError, subprocess.SubprocessError) as exc:
        message = str(exc)
        allowed = {"request_invalid", "revision_invalid", "revision_conflict", "service_id_invalid", "service_kind_invalid", "service_label_invalid", "service_host_invalid", "service_host_unapproved", "service_enabled_invalid", "service_id_duplicate", "service_exists", "service_not_found", "service_disabled", "fleet_host_not_enabled", "fleet_host_invalid", "fleet_config_unavailable", "registry_invalid", "registry_permissions_invalid", "registry_changed", "registry_too_large", "registry_locked", "registry_directory_unavailable", "registry_directory_permissions_invalid", "backup_collision", "probe_response_invalid", "request_too_large", "response_too_large"}
        print(json.dumps({"error": message if message in allowed else "private_services_failed"}, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
