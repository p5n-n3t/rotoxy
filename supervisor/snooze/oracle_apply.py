"""Owner-only coordinator for a fenced Oracle pool config apply/restart."""
from __future__ import annotations

from contextlib import contextmanager
import base64
import hashlib
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import time
from typing import Any, Callable

from .oracle_fleet_config import _locked as _fleet_lock, _read as _read_fleet

REVISION_RE = re.compile(r"[A-Za-z0-9_-]{24}\Z")
INSTANCE_RE = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z")
APPLY_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
MAX_WAIT_SECONDS = 15.0
HEARTBEAT_MAX_AGE = 10.0
HEARTBEAT_FUTURE_SKEW = 5.0
POLL_SECONDS = 0.2
SAFE_OPERATION_ERRORS = {None, "restart_ambiguous", "daemon_not_observed", "config_revision_changed", "previous_instance_unavailable"}
SAFE_ERRORS = {
    "maintenance_unavailable", "maintenance_epoch_conflict", "maintenance_revision_conflict",
    "daemon_unavailable", "core_api_unavailable", "config_apply_unavailable", "config_apply_conflict",
    "config_revision_conflict", "apply_locked", "config_locked", "invalid_config_path",
    "config_permissions_invalid", "config_directory_permissions_invalid",
}


def _revision(raw: bytes) -> str:
    """Match oracle_model_admin.revision exactly without importing the UI adapter."""
    return base64.urlsafe_b64encode(hashlib.sha256(raw).digest()[:18]).decode().rstrip("=")


def _load_core() -> dict[str, Any]:
    # Import at call time: older core builds must remain safely unavailable.
    from . import oracle_pool
    names = ("read_maintenance_status", "read_daemon_status", "read_config_apply_status")
    pool = getattr(oracle_pool, "OraclePool", None)
    values = {name: getattr(oracle_pool, name, None) for name in names}
    values["OraclePool"] = pool
    if not callable(pool) or any(not callable(values[name]) for name in names):
        raise ValueError("core_api_unavailable")
    return values


def _maintenance(value: Any) -> dict[str, Any] | None:
    keys = {"epoch", "paused", "configRevision", "acknowledged", "blockers", "reason"}
    if type(value) is not dict or set(value) != keys:
        return None
    b = value["blockers"]
    if (type(value["epoch"]) is not int or value["epoch"] < 0 or type(value["paused"]) is not bool or
            type(value["acknowledged"]) is not bool or type(b) is not dict or
            set(b) != {"running", "ambiguous", "dispatching"} or
            any(type(n) is not int or n < 0 for n in b.values()) or
            not (value["configRevision"] is None or isinstance(value["configRevision"], str) and REVISION_RE.fullmatch(value["configRevision"])) or
            not (value["reason"] is None or isinstance(value["reason"], str) and len(value["reason"]) <= 80)):
        return None
    return {**value, "blockers": dict(b)}


def _daemon(value: Any) -> dict[str, Any] | None:
    keys = {"available", "instanceId", "loadedRevision", "heartbeatAt", "observedEpoch", "alive"}
    if type(value) is not dict or set(value) != keys or type(value["available"]) is not bool or type(value["alive"]) is not bool:
        return None
    ident, loaded, beat, epoch = (value[k] for k in ("instanceId", "loadedRevision", "heartbeatAt", "observedEpoch"))
    if (not (ident is None or isinstance(ident, str) and INSTANCE_RE.fullmatch(ident)) or
            not (loaded is None or isinstance(loaded, str) and REVISION_RE.fullmatch(loaded)) or
            not (beat is None or type(beat) in (int, float) and math.isfinite(beat) and beat >= 0) or
            not (epoch is None or type(epoch) is int and epoch >= 0)):
        return None
    return dict(value)


def _operation(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    keys = {"applyId", "epoch", "targetRevision", "previousInstance", "status", "error"}
    if type(value) is not dict or set(value) != keys:
        return None
    if (not isinstance(value["applyId"], str) or not APPLY_ID_RE.fullmatch(value["applyId"]) or
            type(value["epoch"]) is not int or value["epoch"] < 0 or
            not isinstance(value["targetRevision"], str) or not REVISION_RE.fullmatch(value["targetRevision"]) or
            not (value["previousInstance"] is None or isinstance(value["previousInstance"], str) and INSTANCE_RE.fullmatch(value["previousInstance"])) or
            not isinstance(value["status"], str) or value["status"] not in {"prepared", "complete", "failed"} or
            not (value["error"] is None or isinstance(value["error"], str) and re.fullmatch(r"[a-z0-9_]{1,80}", value["error"]))):
        return None
    return {**value, "error": value["error"] if value["error"] in SAFE_OPERATION_ERRORS else "unknown"}


def _heartbeat_fresh(daemon: dict[str, Any], now: float | None = None) -> bool:
    beat = daemon["heartbeatAt"]
    age = (time.time() if now is None else now) - beat if beat is not None else float("inf")
    return -HEARTBEAT_FUTURE_SKEW <= age <= HEARTBEAT_MAX_AGE


def _healthy_new_daemon(daemon: dict[str, Any] | None, operation: dict[str, Any]) -> bool:
    return bool(daemon and daemon["available"] and daemon["alive"] and daemon["instanceId"] and
                operation["previousInstance"] and daemon["instanceId"] != operation["previousInstance"] and
                daemon["loadedRevision"] == operation["targetRevision"] and
                daemon["observedEpoch"] == operation["epoch"] and _heartbeat_fresh(daemon))


def _service_restart() -> None:
    env = {key: value for key in ("HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")
           if (value := os.environ.get(key)) and "\x00" not in value and len(value) <= 4096}
    subprocess.run(["/usr/bin/systemctl", "--user", "restart", "rotoxy-oracle-pool.service"],
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   shell=False, check=True, timeout=10, close_fds=True, env=env)


@contextmanager
def _apply_lock(config_path: Path):
    parent = config_path.parent
    info = parent.lstat()
    if (not parent.is_dir() or parent.is_symlink() or info.st_mode & 0o077 or
            hasattr(os, "getuid") and info.st_uid != os.getuid()):
        raise ValueError("config_directory_permissions_invalid")
    path = config_path.with_name(config_path.name + ".apply.lock")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except FileExistsError as exc:
        raise ValueError("apply_locked") from exc
    try:
        st = os.fstat(fd)
        if (not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_mode & 0o077 or
                hasattr(os, "getuid") and st.st_uid != os.getuid()):
            raise ValueError("apply_locked")
        os.write(fd, f"{os.getpid()}\n".encode("ascii")); os.fsync(fd)
        yield
    finally:
        os.close(fd)
        try:
            path.unlink()
        except FileNotFoundError:
            pass


class OracleApplyController:
    def __init__(self, config_path: str | Path, db_path: str | Path,
                 service_runner: Callable[[], None] | None = None, wait_seconds: float = MAX_WAIT_SECONDS):
        self.config_path, self.db_path = Path(config_path), Path(db_path)
        if (not self.config_path.is_absolute() or not self.db_path.is_absolute() or
                "\x00" in str(self.config_path) or "\x00" in str(self.db_path) or
                type(wait_seconds) not in (int, float) or not 0 <= wait_seconds <= MAX_WAIT_SECONDS):
            raise ValueError("invalid_apply_options")
        self.service_runner = _service_restart if service_runner is None else service_runner
        self.wait_seconds = float(wait_seconds)

    def _config_revision(self) -> str:
        raw, _config, _hosts = _read_fleet(self.config_path)
        return _revision(raw)

    def _snapshot(self, reason_override: str | None = None) -> dict[str, Any]:
        daemon = operation = maintenance = None
        reason = reason_override
        try:
            revision = self._config_revision()
        except (OSError, ValueError):
            revision = None
            reason = reason or "config_unavailable"
        try:
            core = _load_core()
            maintenance = _maintenance(core["read_maintenance_status"](self.db_path))
            daemon = _daemon(core["read_daemon_status"](self.db_path))
            raw_operation = core["read_config_apply_status"](self.db_path)
            operation = _operation(raw_operation)
            if maintenance is None or daemon is None or (raw_operation is not None and operation is None):
                raise ValueError("core_status_invalid")
        except Exception as exc:
            code = str(exc)
            reason = reason or (code if code in SAFE_ERRORS else "core_api_unavailable")
            daemon = daemon or {"available": False, "instanceId": None, "loadedRevision": None, "heartbeatAt": None, "observedEpoch": None, "alive": False}
            maintenance = None
            operation = None
        ready = False
        if reason is None:
            if operation is not None:
                reason = "apply_complete" if operation["status"] == "complete" else "recovery_required"
            elif revision is None or maintenance is None:
                reason = "maintenance_unavailable"
            elif not maintenance["paused"]:
                reason = "maintenance_not_paused"
            elif maintenance["epoch"] < 0 or not maintenance["acknowledged"] or any(maintenance["blockers"].values()):
                reason = "maintenance_not_drained"
            elif maintenance["configRevision"] != revision:
                reason = "maintenance_revision_conflict"
            elif daemon is None or not daemon["available"] or not daemon["instanceId"]:
                reason = "daemon_unavailable"
            elif not daemon["alive"]:
                reason = "daemon_not_alive"
            elif not _heartbeat_fresh(daemon):
                reason = "daemon_heartbeat_stale"
            elif daemon["loadedRevision"] != revision:
                reason = "daemon_revision_conflict"
            elif daemon["observedEpoch"] != maintenance["epoch"]:
                reason = "daemon_epoch_conflict"
            else:
                ready = True
        return {"daemon": daemon, "operation": operation, "maintenance": maintenance, "ready": ready, "reason": reason}

    def status(self) -> dict[str, Any]:
        """Read current config, daemon, operation and fence state without changing it."""
        return self._snapshot()

    def _fail(self, core: dict[str, Any], operation: dict[str, Any], error: str) -> None:
        try:
            pool = core["OraclePool"].open_maintenance(self.db_path)
            pool.fail_config_apply(apply_id=operation["applyId"], expected_epoch=operation["epoch"], error=error)
        except Exception:
            # Keep the reservation and pause intact; never attempt another restart.
            pass

    def _reconcile_existing(self, core: dict[str, Any], operation: dict[str, Any]) -> dict[str, Any]:
        if operation["status"] == "prepared":
            try:
                daemon = _daemon(core["read_daemon_status"](self.db_path))
                if _healthy_new_daemon(daemon, operation):
                    pool = core["OraclePool"].open_maintenance(self.db_path)
                    completed = _operation(pool.complete_config_apply(apply_id=operation["applyId"], expected_epoch=operation["epoch"], target_revision=operation["targetRevision"]))
                    if completed is None or completed["status"] != "complete":
                        return self._snapshot("recovery_required")
                    return self._snapshot("apply_complete")
            except Exception:
                pass
        if operation["status"] == "complete":
            return self._snapshot("apply_complete")
        return self._snapshot("recovery_required")

    def apply(self, expected_config_revision: str, expected_epoch: int) -> dict[str, Any]:
        if not isinstance(expected_config_revision, str) or not REVISION_RE.fullmatch(expected_config_revision):
            return self._snapshot("config_revision_conflict")
        if type(expected_epoch) is not int or expected_epoch < 0:
            return self._snapshot("maintenance_epoch_conflict")
        try:
            with _fleet_lock(self.config_path), _apply_lock(self.config_path):
                current_revision = self._config_revision()
                if current_revision != expected_config_revision:
                    return self._snapshot("config_revision_conflict")
                core = _load_core()
                maintenance = _maintenance(core["read_maintenance_status"](self.db_path))
                daemon = _daemon(core["read_daemon_status"](self.db_path))
                existing = _operation(core["read_config_apply_status"](self.db_path))
                if maintenance is None:
                    return self._snapshot("maintenance_unavailable")
                if existing is not None:
                    if existing["epoch"] != expected_epoch or existing["targetRevision"] != current_revision:
                        return self._snapshot("recovery_required")
                    if existing["status"] == "complete":
                        return self._snapshot("apply_complete")
                    if (existing["status"] != "prepared" or not maintenance["paused"] or
                            maintenance["epoch"] != expected_epoch or not maintenance["acknowledged"] or
                            any(maintenance["blockers"].values()) or maintenance["configRevision"] != current_revision):
                        return self._snapshot("recovery_required")
                    return self._reconcile_existing(core, existing)
                before = self._snapshot()
                if not before["ready"] or before["maintenance"]["epoch"] != expected_epoch:
                    return before if before["reason"] else self._snapshot("maintenance_epoch_conflict")
                pool = core["OraclePool"].open_maintenance(self.db_path)
                operation = _operation(pool.begin_config_apply(expected_epoch=expected_epoch, target_revision=current_revision))
                if operation is None:
                    return self._snapshot("config_apply_unavailable")
                if operation["status"] != "prepared" or operation["epoch"] != expected_epoch or operation["targetRevision"] != current_revision:
                    return self._snapshot("recovery_required")
                # Core stores the old identity at begin; if absent, new-instance proof is impossible.
                if not operation["previousInstance"]:
                    return self._snapshot("recovery_required")
                after_begin_daemon = _daemon(core["read_daemon_status"](self.db_path))
                if (not daemon or operation["previousInstance"] != daemon["instanceId"] or
                        after_begin_daemon is None or after_begin_daemon["instanceId"] != daemon["instanceId"]):
                    return self._reconcile_existing(core, operation)
                try:
                    if self.service_runner() is not None:
                        raise RuntimeError("service_runner_contract_invalid")
                except Exception:
                    self._fail(core, operation, "restart_ambiguous")
                    return self._snapshot("recovery_required")
                deadline = time.monotonic() + self.wait_seconds
                observed = None
                while True:
                    try:
                        observed = _daemon(core["read_daemon_status"](self.db_path))
                    except Exception:
                        observed = None
                    if _healthy_new_daemon(observed, operation):
                        break
                    if time.monotonic() >= deadline:
                        self._fail(core, operation, "daemon_not_observed")
                        return self._snapshot("recovery_required")
                    time.sleep(min(POLL_SECONDS, max(0.0, deadline - time.monotonic())))
                if self._config_revision() != current_revision:
                    self._fail(core, operation, "config_revision_changed")
                    return self._snapshot("config_revision_conflict")
                try:
                    result = _operation(pool.complete_config_apply(apply_id=operation["applyId"], expected_epoch=expected_epoch, target_revision=current_revision))
                except Exception:
                    return self._snapshot("recovery_required")
                if result is None or result["status"] != "complete":
                    return self._snapshot("recovery_required")
                return self._snapshot("apply_complete")
        except Exception as exc:
            code = str(exc)
            return self._snapshot(code if code in SAFE_ERRORS else "apply_failed")
