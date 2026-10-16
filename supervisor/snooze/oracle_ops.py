"""Read-only, bounded operator snapshot for the fixed Oracle text pool."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import math
import os
import re
import sqlite3
import stat
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .oracle_pool import HOSTS, HOST_ID_RE, MODEL_NAME_RE, PoolError, validate_config


HOST_IDS = tuple(host["id"] for host in HOSTS)
STATUSES = ("queued", "running", "complete", "failed", "ambiguous", "cancelled")
SAFE_ERRORS = {
    "queue_full", "retention_full_run_cleanup", "worker_disappeared", "timeout", "transport_exit",
    "invalid_response", "response_too_large", "ssh_unavailable", "invalid_catalog", "catalog_error",
    "generation_failed", "unsupported_config", "config_unavailable", "config_permissions_not_private",
    "task_inference_not_cancellable", "worker_error", "remote_http_400", "remote_http_401",
    "remote_http_403", "remote_http_404", "remote_http_429", "remote_http_500", "remote_http_502",
    "remote_http_503", "remote_http_504",
}
MAX_PAGE_SIZE = 50
MAX_PAGE_OFFSET = 10_000
MAX_EVENT_CURSOR = 2**63 - 1
TASK_COLUMNS = "status,model,assigned_host,created,updated,attempts,error_code,actual_model,prompt_tokens,eval_tokens,remote_seconds,elapsed_seconds"


def _integer(value: Any, name: str, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"invalid_{name}")
    return value


def _number(value: Any) -> int | float | None:
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        return None
    return value


def _safe_error(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return value if value in SAFE_ERRORS else None


def _private_file(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode) and (info.st_mode & 0o077) == 0


def _empty_snapshot(limit: int, offset: int, after_event: int) -> dict[str, Any]:
    return {
        "available": False,
        "availabilityReason": "pool_state_unavailable",
        "hosts": [{"host": host_id, "models": [], "lastCatalogCheck": None,
                   "catalogCheckState": "unknown", "assignedTasks": 0,
                   "completedTasks": 0, "runningTasks": 0} for host_id in HOST_IDS],
        "summary": {"totalTasks": None, "taskCounts": None, "completedLastHour": None,
                    "throughputWindowSeconds": 3600,
                    "promptTokens": {"total": None, "observations": 0},
                    "evalTokens": {"total": None, "observations": 0},
                    "assignmentDenominator": None,
                    "assignmentDistribution": [{"host": host_id, "count": None, "share": None} for host_id in HOST_IDS]},
        "tasks": {"items": [], "limit": limit, "offset": offset, "total": None, "hasMore": False, "nextOffset": None},
        "events": {"items": [], "limit": limit, "after": after_event, "nextCursor": after_event, "hasMore": False},
        "advisoryModel": {"model": "tev1:0.8b", "availability": "unknown"},
    }


def _readonly_connection(path: Path) -> sqlite3.Connection:
    uri = "file:" + quote(str(path), safe="/") + "?mode=ro"
    db = sqlite3.connect(uri, uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    return db


@contextmanager
def _readonly_db(path: Path):
    db = _readonly_connection(path)
    try:
        yield db
    finally:
        db.close()


def load_snapshot(config_path: str | Path, db_path: str | Path, *, limit: int = 20,
                  offset: int = 0, after_event: int = 0, now: float | None = None) -> dict[str, Any]:
    """Read safe aggregates and pages from explicit trusted private pool paths.

    This function never creates state, refreshes catalogs, probes SSH, or runs inference.
    """
    limit = _integer(limit, "limit", 1, MAX_PAGE_SIZE)
    offset = _integer(offset, "offset", 0, MAX_PAGE_OFFSET)
    after_event = _integer(after_event, "event_cursor", 0, MAX_EVENT_CURSOR)
    config, database = Path(config_path), Path(db_path)
    if not config.is_absolute() or not database.is_absolute():
        raise ValueError("private_pool_paths_required")
    if not _private_file(config) or not _private_file(database):
        return _empty_snapshot(limit, offset, after_event)
    now = float(now if now is not None else __import__("time").time())
    try:
        _, configured_hosts = validate_config(json.loads(config.read_text(encoding="utf-8")))
        configured = {host["id"]: host for host in configured_hosts}
        with _readonly_db(database) as db:
            db.execute("BEGIN")
            host_rows = {row["id"]: row for row in db.execute(
                "SELECT id,models,updated,error_code FROM pool_hosts")
                if isinstance(row["id"], str) and HOST_ID_RE.fullmatch(row["id"])}
            history_ids = set(host_rows)
            for row in db.execute("SELECT DISTINCT assigned_host FROM pool_tasks WHERE assigned_host IS NOT NULL"):
                if isinstance(row[0], str) and HOST_ID_RE.fullmatch(row[0]):
                    history_ids.add(row[0])
            for row in db.execute("SELECT data FROM pool_events"):
                try:
                    event_data = json.loads(row[0])
                except (TypeError, json.JSONDecodeError):
                    continue
                event_host = event_data.get("host") if isinstance(event_data, dict) else None
                if isinstance(event_host, str) and HOST_ID_RE.fullmatch(event_host):
                    history_ids.add(event_host)
            host_ids = tuple([host["id"] for host in configured_hosts] +
                             sorted(history_ids - set(configured)))
            hosts = []
            assignment_counts = {host_id: 0 for host_id in host_ids}
            completed_by_host = {host_id: 0 for host_id in host_ids}
            running_by_host = {host_id: 0 for host_id in host_ids}
            for host_id in host_ids:
                row = host_rows.get(host_id)
                host_config = configured.get(host_id)
                models: list[str] = []
                catalog_error = None
                if row:
                    try:
                        decoded = json.loads(row["models"])
                        if isinstance(decoded, list):
                            allowed = set(host_config["allowedModels"]) if host_config else None
                            models = list(dict.fromkeys(model for model in decoded
                                                        if isinstance(model, str) and MODEL_NAME_RE.fullmatch(model)
                                                        and (allowed is None or model in allowed)))
                        else:
                            catalog_error = "catalog_data_invalid"
                    except (TypeError, json.JSONDecodeError):
                        catalog_error = "catalog_data_invalid"
                    if row["error_code"] is not None:
                        catalog_error = catalog_error or _safe_error(row["error_code"]) or "catalog_error"
                updated = _number(row["updated"]) if row else None
                check_state = "check_failed" if catalog_error else "checked" if updated is not None else "never_checked"
                hosts.append({"host": host_id, "models": models, "enabled": host_config["enabled"] if host_config else False,
                              "configured": host_config is not None, "lastCatalogCheck": updated,
                              "catalogCheckState": check_state, **({"catalogError": catalog_error} if catalog_error else {}),
                              "assignedTasks": 0, "completedTasks": 0, "runningTasks": 0})
            status_counts = {name: 0 for name in (*STATUSES, "unknown")}
            for row in db.execute("SELECT status,COUNT(*) AS n FROM pool_tasks GROUP BY status"):
                status = row["status"] if row["status"] in STATUSES else "unknown"
                status_counts[status] += row["n"]
            total_tasks = db.execute("SELECT COUNT(*) FROM pool_tasks").fetchone()[0]
            for row in db.execute("SELECT assigned_host,status,COUNT(*) AS n FROM pool_tasks WHERE assigned_host IS NOT NULL GROUP BY assigned_host,status"):
                host_id = row["assigned_host"]
                if host_id in assignment_counts:
                    assignment_counts[host_id] += row["n"]
                    if row["status"] == "complete":
                        completed_by_host[host_id] += row["n"]
                    if row["status"] == "running":
                        running_by_host[host_id] += row["n"]
            for host in hosts:
                host_id = host["host"]
                host["assignedTasks"] = assignment_counts[host_id]
                host["completedTasks"] = completed_by_host[host_id]
                host["runningTasks"] = running_by_host[host_id]
            denominator = sum(assignment_counts.values())
            distribution = [{"host": host_id, "count": assignment_counts[host_id],
                             "share": assignment_counts[host_id] / denominator if denominator else None}
                            for host_id in host_ids]
            token_values = {}
            for field, result_name in (("prompt_tokens", "promptTokens"), ("eval_tokens", "evalTokens")):
                row = db.execute(f"SELECT COUNT({field}),SUM({field}) FROM pool_tasks WHERE {field} IS NOT NULL AND {field}>=0").fetchone()
                observations = row[0]
                token_values[result_name] = {"total": int(row[1]) if observations else None, "observations": observations}
            completed_last_hour = db.execute(
                "SELECT COUNT(*) FROM pool_tasks WHERE status='complete' AND updated>=? AND updated<=?", (now - 3600, now)).fetchone()[0]
            task_rows = db.execute(
                f"SELECT {TASK_COLUMNS} FROM pool_tasks ORDER BY updated DESC,created DESC LIMIT ? OFFSET ?", (limit + 1, offset)).fetchall()
            task_has_more = len(task_rows) > limit
            task_rows = task_rows[:limit]
            tasks = []
            for row in task_rows:
                status = row["status"] if row["status"] in STATUSES else "unknown"
                model = row["model"] if isinstance(row["model"], str) and MODEL_NAME_RE.fullmatch(row["model"]) else None
                assigned = row["assigned_host"] if isinstance(row["assigned_host"], str) and HOST_ID_RE.fullmatch(row["assigned_host"]) else None
                actual_model = row["actual_model"] if isinstance(row["actual_model"], str) and MODEL_NAME_RE.fullmatch(row["actual_model"]) else None
                attempts = row["attempts"] if type(row["attempts"]) is int and row["attempts"] >= 0 else None
                tokens = {field: row[field] if type(row[field]) is int and row[field] >= 0 else None
                          for field in ("prompt_tokens", "eval_tokens")}
                tasks.append({"status": status, "model": model, "assignedHost": assigned,
                              "createdAt": _number(row["created"]), "updatedAt": _number(row["updated"]),
                              "attempts": attempts, "actualModel": actual_model,
                              "promptTokens": tokens["prompt_tokens"], "evalTokens": tokens["eval_tokens"],
                              "remoteSeconds": _number(row["remote_seconds"]), "elapsedSeconds": _number(row["elapsed_seconds"]),
                              "errorCode": _safe_error(row["error_code"])})
            event_rows = db.execute(
                "SELECT id,kind,at,data FROM pool_events WHERE id>? ORDER BY id LIMIT ?", (after_event, limit + 1)).fetchall()
            event_has_more = len(event_rows) > limit
            event_rows = event_rows[:limit]
            events = []
            for row in event_rows:
                try:
                    data = json.loads(row["data"])
                except (TypeError, json.JSONDecodeError):
                    data = {}
                if not isinstance(data, dict):
                    data = {}
                host = data.get("host") if isinstance(data.get("host"), str) and HOST_ID_RE.fullmatch(data["host"]) else None
                model = data.get("model") if isinstance(data.get("model"), str) and MODEL_NAME_RE.fullmatch(data["model"]) else None
                actual = data.get("actual_model") if isinstance(data.get("actual_model"), str) and MODEL_NAME_RE.fullmatch(data["actual_model"]) else None
                events.append({"eventId": row["id"], "kind": row["kind"] if row["kind"] in STATUSES else "event",
                               "at": _number(row["at"]), "status": data.get("status") if data.get("status") in STATUSES else None,
                               "host": host, "model": model, "actualModel": actual,
                               "errorCode": _safe_error(data.get("error_code"))})
            available_models = {model for host in hosts if host["configured"] and host["enabled"]
                                for model in host["models"]}
            return {
                "available": True,
                "hosts": hosts,
                "summary": {"totalTasks": total_tasks, "taskCounts": status_counts,
                            "completedLastHour": completed_last_hour, "throughputWindowSeconds": 3600,
                            **token_values, "assignmentDenominator": denominator,
                            "assignmentDistribution": distribution},
                "tasks": {"items": tasks, "limit": limit, "offset": offset, "total": total_tasks,
                          "hasMore": task_has_more, "nextOffset": offset + limit if task_has_more else None},
                "events": {"items": events, "limit": limit,
                           "after": after_event, "nextCursor": event_rows[-1]["id"] if event_rows else after_event,
                           "hasMore": event_has_more},
                "advisoryModel": {"model": "tev1:0.8b", "availability": "available" if "tev1:0.8b" in available_models else "unknown"},
            }
    except (OSError, sqlite3.Error, KeyError, TypeError, PoolError, json.JSONDecodeError):
        return _empty_snapshot(limit, offset, after_event)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only Oracle operations snapshot")
    parser.add_argument("--config", required=True, help="trusted private Oracle config path")
    parser.add_argument("--db", required=True, help="trusted private Oracle database path")
    subparsers = parser.add_subparsers(dest="command", required=True)
    snapshot = subparsers.add_parser("snapshot")
    snapshot.add_argument("--limit", type=int, default=20)
    snapshot.add_argument("--offset", type=int, default=0)
    snapshot.add_argument("--after-event", type=int, default=0)
    args = parser.parse_args(argv)
    try:
        if args.command != "snapshot":
            raise ValueError("unsupported_command")
        result = load_snapshot(args.config, args.db, limit=args.limit, offset=args.offset,
                               after_event=args.after_event)
        print(json.dumps(result, separators=(",", ":"), allow_nan=False))
        return 0
    except ValueError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
