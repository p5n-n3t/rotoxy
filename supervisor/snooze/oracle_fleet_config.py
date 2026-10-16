"""Owner-only atomic editor for the private Oracle fleet configuration."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
import stat
import sys
import time
from pathlib import Path
from typing import Any

from .oracle_pool import PoolError, default_config, validate_config

MAX_INPUT = 16 * 1024
MAX_CONFIG = 32 * 1024


def _revision(raw: bytes) -> str:
    # Opaque compare-and-swap token; never includes config content.
    import base64
    return base64.urlsafe_b64encode(hashlib.sha256(raw).digest()[:18]).decode().rstrip("=")


def _check_parent(path: Path, *, create: bool = False) -> None:
    if create:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(path.parent, 0o700)
    try:
        parent = path.parent.lstat()
    except OSError as exc:
        raise ValueError("config_directory_unavailable") from exc
    if (not stat.S_ISDIR(parent.st_mode) or stat.S_ISLNK(parent.st_mode) or
            (parent.st_mode & 0o077) or (hasattr(os, "getuid") and parent.st_uid != os.getuid())):
        raise ValueError("config_directory_permissions_invalid")


def _read(path: Path) -> tuple[bytes, dict[str, Any], tuple[dict[str, Any], ...]]:
    if not path.is_absolute() or "\x00" in str(path):
        raise ValueError("invalid_config_path")
    if path.parent.exists():
        _check_parent(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        config, hosts = validate_config(default_config())
        return b"", config, hosts
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or (info.st_mode & 0o077) or (hasattr(os, "getuid") and info.st_uid != os.getuid()) or info.st_size > MAX_CONFIG:
        raise ValueError("config_permissions_invalid")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        opened = os.fstat(fd)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_ino != info.st_ino or opened.st_dev != info.st_dev or
                (opened.st_mode & 0o077) or (hasattr(os, "getuid") and opened.st_uid != os.getuid()) or opened.st_size > MAX_CONFIG):
            raise ValueError("config_changed")
        raw = os.read(fd, MAX_CONFIG + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_CONFIG:
        raise ValueError("config_too_large")
    try:
        config, hosts = validate_config(json.loads(raw))
    except (json.JSONDecodeError, PoolError) as exc:
        raise ValueError("config_invalid") from exc
    return raw, config, hosts


def _atomic_write(path: Path, raw: bytes) -> None:
    _check_parent(path, create=True)
    temp = path.with_name(path.name + f".tmp.{os.getpid()}.{time.time_ns()}")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    finally:
        os.close(fd)
    os.replace(temp, path)
    os.chmod(path, 0o600)
    dir_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _host_input(raw: Any) -> dict[str, Any]:
    if type(raw) is not dict or set(raw) != {"id", "ip", "ssh_host", "enabled", "allowedModels"}:
        raise ValueError("invalid_host")
    if any(not isinstance(raw[key], str) or len(raw[key]) > max_len for key, max_len in (("id", 48), ("ip", 45), ("ssh_host", 253))):
        raise ValueError("invalid_host")
    models = raw["allowedModels"]
    if type(raw["enabled"]) is not bool or type(models) is not list or len(models) > 64 or any(not isinstance(x, str) or len(x) > 160 for x in models):
        raise ValueError("invalid_host")
    return {"id": raw["id"], "ip": raw["ip"], "ssh_host": raw["ssh_host"],
            "enabled": raw["enabled"], "allowedModels": models}


@contextmanager
def _locked(path: Path):
    lock = path.with_name(path.name + ".lock")
    _check_parent(path, create=True)
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise ValueError("config_locked") from exc
    try:
        os.write(fd, f"{os.getpid()}\n".encode())
        os.fsync(fd)
        yield
    finally:
        os.close(fd)
        try:
            os.unlink(lock)
        except FileNotFoundError:
            pass


def _response(raw: bytes, config: dict[str, Any], hosts: tuple[dict[str, Any], ...]) -> dict[str, Any]:
    return {"revision": _revision(raw), "version": config["version"], "default_model": config["default_model"],
            "hosts": list(hosts)}


def apply(path: Path, request: Any) -> dict[str, Any]:
    if type(request) is not dict or request.get("action") not in {"read", "add", "update", "remove"}:
        raise ValueError("invalid_request")
    action = request["action"]
    if action == "read":
        if set(request) != {"action"}:
            raise ValueError("invalid_request")
        raw, config, hosts = _read(path)
        return _response(raw, config, hosts)
    if set(request) != ({"action", "revision", "host"} if action == "add" else
                        {"action", "revision", "targetId", "host"} if action == "update" else
                        {"action", "revision", "targetId"}):
        raise ValueError("invalid_request")
    expected = request.get("revision")
    if not isinstance(expected, str) or len(expected) != 24:
        raise ValueError("invalid_revision")
    with _locked(path):
        old_raw, old_config, old_hosts = _read(path)
        if _revision(old_raw) != expected:
            raise ValueError("revision_conflict")
        hosts = list(old_hosts)
        if action == "add":
            new_host = _host_input(request["host"])
            if any(host["id"] == new_host["id"] for host in hosts):
                raise ValueError("host_exists")
            hosts.append(new_host)
        elif action == "update":
            target = request["targetId"]
            if not isinstance(target, str):
                raise ValueError("invalid_host_id")
            new_host = _host_input(request["host"])
            index = next((i for i, host in enumerate(hosts) if host["id"] == target), None)
            if index is None:
                raise ValueError("host_not_found")
            if any(i != index and host["id"] == new_host["id"] for i, host in enumerate(hosts)):
                raise ValueError("host_exists")
            hosts[index] = new_host
        else:
            target = request["targetId"]
            if not isinstance(target, str):
                raise ValueError("invalid_host_id")
            hosts = [host for host in hosts if host["id"] != target]
            if len(hosts) == len(old_hosts):
                raise ValueError("host_not_found")
        if not hosts:
            raise ValueError("last_host_required")
        candidate = {**old_config, "version": 2, "hosts": hosts}
        try:
            normalized, validated_hosts = validate_config(candidate)
        except PoolError as exc:
            raise ValueError("config_invalid") from exc
        if old_raw:
            backup_bytes = old_raw
        else:
            backup_bytes = b'{"absent":true}\n'
        backup = path.with_name(path.name + ".backup." + _revision(old_raw))
        if backup.exists():
            if backup.is_symlink() or not backup.is_file() or backup.read_bytes() != backup_bytes:
                raise ValueError("backup_collision")
        else:
            _atomic_write(backup, backup_bytes)
        encoded = (json.dumps(normalized, ensure_ascii=False, indent=2) + "\n").encode()
        if len(encoded) > MAX_CONFIG:
            raise ValueError("config_too_large")
        _atomic_write(path, encoded)
        return _response(encoded, normalized, validated_hosts)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Private Oracle fleet registry admin helper")
    parser.add_argument("--config", required=True, help="trusted config path supplied by the local ROTOXY admin")
    args = parser.parse_args(argv)
    try:
        payload = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(payload) > MAX_INPUT:
            raise ValueError("input_too_large")
        result = apply(Path(args.config), json.loads(payload))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        message = str(exc)
        safe = message if message in {"invalid_request", "invalid_host", "invalid_revision", "revision_conflict", "host_exists", "host_not_found", "last_host_required", "config_invalid", "config_locked", "config_permissions_invalid", "config_directory_unavailable", "config_directory_permissions_invalid", "config_changed", "config_too_large", "input_too_large", "backup_collision", "invalid_config_path"} else "fleet_config_failed"
        print(json.dumps({"error": safe}, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
