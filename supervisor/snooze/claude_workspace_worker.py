#!/usr/bin/env python3
import argparse
import hashlib
import math
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

from .agent_workspace import AgentWorkspace, WorkspaceError, _clean_text

ACTOR = "client:claude-worker-local"
MAX_STDOUT = 256 * 1024
ATTEMPT_DB_SCHEMA = """
CREATE TABLE IF NOT EXISTS claude_workspace_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'intent',
    model_requested TEXT,
    model_reported TEXT,
    prompt_digest TEXT,
    created INTEGER NOT NULL,
    total_cost_usd REAL,
    result TEXT,
    UNIQUE(project_id, task_id)
)
"""

_SAFE_ID = re.compile(r'^[A-Za-z0-9_\-\.]{1,128}$')
_SAFE_MODEL = "claude-sonnet-4-6"
_ALLOWED_MODELS = {_SAFE_MODEL, "global.anthropic.claude-sonnet-4-6"}


def safe_id(v):
    return bool(_SAFE_ID.match(v)) if v else False


def open_attempt_db(db_path):
    conn = sqlite3.connect(db_path, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(ATTEMPT_DB_SCHEMA)
    conn.commit()
    return conn


def insert_intent(db_path, project_id, task_id, model_requested, prompt_digest):
    conn = open_attempt_db(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "INSERT INTO claude_workspace_attempts "
            "(project_id, task_id, status, model_requested, prompt_digest, created) "
            "VALUES (?, ?, 'intent', ?, ?, ?)",
            (project_id, task_id, model_requested, prompt_digest, int(time.time()))
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback()
        conn.close()
        return False
    conn.close()
    return True


def attempt_status(db_path, project_id, task_id):
    conn = open_attempt_db(db_path)
    try:
        row = conn.execute(
            "SELECT status FROM claude_workspace_attempts WHERE project_id=? AND task_id=?",
            (project_id, task_id),
        ).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def update_attempt(db_path, project_id, task_id, status, model_reported=None,
                   total_cost_usd=None, result=None):
    conn = open_attempt_db(db_path)
    conn.execute(
        "UPDATE claude_workspace_attempts SET status=?, model_reported=?, "
        "total_cost_usd=?, result=? WHERE project_id=? AND task_id=?",
        (status, model_reported, total_cost_usd, result, project_id, task_id)
    )
    conn.commit()
    conn.close()


def default_runner(argv, stdin_text, timeout_seconds):
    env = {name: os.environ[name] for name in (
        "HOME", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "USER", "LOGNAME", "SystemRoot",
        "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE"
    ) if name in os.environ}
    env.update({
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING": "1",
        "MAX_THINKING_TOKENS": "1024",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "2048",
        "CLAUDE_CODE_EFFORT_LEVEL": "low",
    })
    proc = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        shell=False,
        env=env
    )
    stdout_chunks = []
    overflow = threading.Event()
    done = threading.Event()

    def reader():
        total = 0
        while True:
            chunk = proc.stdout.read(4096)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_STDOUT:
                overflow.set()
                proc.kill()
                break
            stdout_chunks.append(chunk)
        done.set()

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    def writer():
        try:
            proc.stdin.write(stdin_text.encode()); proc.stdin.close()
        except (BrokenPipeError, OSError): pass
    threading.Thread(target=writer, daemon=True).start()
    try:
        proc.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        done.wait(timeout=5)
        proc.stdout.close()
        return None, "timeout"
    done.wait(timeout=10)
    proc.stdout.close()
    if overflow.is_set():
        return None, "overflow"
    if proc.returncode != 0:
        return None, "cli_exit_error"
    stdout = b"".join(stdout_chunks).decode(errors="replace")
    return stdout, None


def parse_cli_result(raw):
    try:
        data = json.loads(raw)
    except Exception:
        return None, "json_parse_error"
    if not isinstance(data, dict):
        return None, "not_dict"
    if data.get("is_error") is True:
        return None, "cli_error"
    result = data.get("result")
    if not isinstance(result, str) or not result:
        return None, "empty_result"
    result_text = result[:900]
    model_reported = None
    usage = data.get("modelUsage")
    if isinstance(usage, dict):
        model_reported = next((key for key in usage if key in _ALLOWED_MODELS), None)
    cost = data.get("total_cost_usd") if "total_cost_usd" in data else data.get("cost_usd")
    total_cost = None
    if type(cost) in (int, float) and cost >= 0:
        try:
            value = float(cost)
            if math.isfinite(value): total_cost = value
        except (OverflowError, ValueError):
            pass
    return {"result_text": result_text, "model_reported": model_reported,
            "total_cost": total_cost}, None


def build_prompt(task):
    parts = []
    parts.append(f"Task: {task.get('title', '')}")
    desc = task.get("description", "")
    if desc:
        parts.append(f"Description: {desc}")
    return "\n\n".join(parts)


def run_task(args, runner=None):
    if runner is None:
        runner = default_runner

    db_path = args.db
    project = args.project
    task_id = args.task
    claude_bin = args.claude_binary
    model = args.model
    budget = args.max_budget_usd
    timeout = args.timeout_seconds

    if attempt_status(db_path, project, task_id) is not None:
        return {"status": "skipped", "message": "attempt already recorded; idempotent no-op"}

    ws = AgentWorkspace(db_path)

    snap = ws.snapshot(project, ACTOR)
    revision = snap["revision"]
    tasks_by_id = {t["id"]: t for t in snap.get("tasks", [])}

    if task_id not in tasks_by_id:
        return {"status": "error", "message": "task not found in snapshot"}

    task = tasks_by_id[task_id]
    state = task.get("state")
    assignee = task.get("assignee")

    already_claimed = (state == "running" and assignee == ACTOR)
    if state != "queued" and not already_claimed:
        return {"status": "error", "message": f"task not claimable: state={state} assignee={assignee}"}

    prompt_text = build_prompt(task)
    prompt_digest = hashlib.sha256(prompt_text.encode()).hexdigest()

    inserted = insert_intent(db_path, project, task_id, model, prompt_digest)
    if not inserted:
        return {"status": "skipped", "message": "attempt already recorded; idempotent no-op"}

    try:
        snap2 = ws.snapshot(project, ACTOR)
        revision = snap2["revision"]

        ws.update(project, ACTOR, {
            "action": "participant_upsert",
            "idempotencyKey": f"pu-{task_id}",
            "expectedRevision": revision,
            "label": "Claude Code worker",
            "provider": "claude-code",
            "model": model
        })
        snap3 = ws.snapshot(project, ACTOR)
        revision = snap3["revision"]

        if not already_claimed:
            ws.update(project, ACTOR, {
                "action": "task_claim",
                "idempotencyKey": f"claim-{task_id}",
                "expectedRevision": revision,
                "taskId": task_id
            })
            snap4 = ws.snapshot(project, ACTOR)
            revision = snap4["revision"]
    except WorkspaceError as e:
        update_attempt(db_path, project, task_id, "error", result=str(e.code))
        return {"status": "error", "message": f"workspace error: {e.code}"}

    argv = [
        claude_bin, "--bare", "-p",
        "--model", model,
        "--effort", "low",
        "--tools", "",
        "--strict-mcp-config",
        "--mcp-config", json.dumps({"mcpServers": {}}),
        "--no-session-persistence",
        "--max-budget-usd", str(budget),
        "--output-format", "json"
    ]

    raw, transport_err = runner(argv, prompt_text, timeout)

    if transport_err is not None:
        update_attempt(db_path, project, task_id, "ambiguous", result=transport_err)
        try:
            snap5 = ws.snapshot(project, ACTOR)
            revision = snap5["revision"]
            ws.update(project, ACTOR, {
                "action": "task_update",
                "idempotencyKey": f"block-{task_id}-ambiguous",
                "expectedRevision": revision,
                "taskId": task_id,
                "state": "blocked",
                "note": f"worker transport error: {transport_err}"
            })
        except WorkspaceError:
            pass
        return {"status": "ambiguous", "message": transport_err}

    parsed, parse_err = parse_cli_result(raw)
    if parse_err is not None:
        update_attempt(db_path, project, task_id, "ambiguous", result=parse_err)
        try:
            snap5 = ws.snapshot(project, ACTOR)
            revision = snap5["revision"]
            ws.update(project, ACTOR, {
                "action": "task_update",
                "idempotencyKey": f"block-{task_id}-parse",
                "expectedRevision": revision,
                "taskId": task_id,
                "state": "blocked",
                "note": f"worker parse error: {parse_err}"
            })
        except WorkspaceError:
            pass
        return {"status": "ambiguous", "message": parse_err}

    result_text = parsed["result_text"]
    model_reported = parsed.get("model_reported")
    total_cost = parsed.get("total_cost")
    result_text = _clean_text(parsed["result_text"], 900)

    artifact_id = f"artifact-{task_id}-result"
    title = f"Result [reported {model_reported[:64]}]" if model_reported else "Result [actual model unreported]"

    try:
        snap6 = ws.snapshot(project, ACTOR)
        revision = snap6["revision"]
        ws.update(project, ACTOR, {
            "action": "artifact_submit",
            "idempotencyKey": f"artifact-{task_id}",
            "expectedRevision": revision,
            "artifactId": artifact_id,
            "taskId": task_id,
            "kind": "text",
            "reference": result_text[:1000],
            "title": title
        })
    except WorkspaceError as e:
        update_attempt(db_path, project, task_id, "artifact_failed",
                       model_reported=model_reported, total_cost_usd=total_cost,
                       result=result_text)
        try:
            snap8 = ws.snapshot(project, ACTOR)
            revision = snap8["revision"]
            ws.update(project, ACTOR, {
                "action": "task_update",
                "idempotencyKey": f"block-{task_id}-artifact",
                "expectedRevision": revision,
                "taskId": task_id,
                "state": "blocked",
                "note": f"artifact write failed: {e.code}"
            })
        except WorkspaceError:
            pass
        return {"status": "artifact_failed", "message": f"artifact error: {e.code}",
                "result_stored": True}

    update_attempt(db_path, project, task_id, "success",
                   model_reported=model_reported, total_cost_usd=total_cost,
                   result=result_text)

    return {
        "status": "success",
        "task_id": task_id,
        "artifact_id": artifact_id,
        "model_requested": model,
        "model_reported": model_reported,
        "total_cost_usd": total_cost,
        "result_length": len(result_text)
    }


def parse_args(argv=None):
    p = argparse.ArgumentParser(prog="snooze.claude_workspace_worker")
    p.add_argument("--db", required=True)
    p.add_argument("--project", required=True)
    p.add_argument("--task", required=True)
    p.add_argument("--claude-binary", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--max-budget-usd", type=float, required=True)
    p.add_argument("--timeout-seconds", type=int, required=True)
    p.add_argument("--execute", action="store_true", default=False)
    return p.parse_args(argv)


def validate_args(args):
    errors = []
    db = Path(args.db)
    if not db.is_absolute():
        errors.append("--db must be absolute path")

    if not safe_id(args.project):
        errors.append("--project must be safe identifier")

    if not safe_id(args.task):
        errors.append("--task must be safe identifier")

    cb = Path(args.claude_binary)
    if not cb.is_absolute():
        errors.append("--claude-binary must be absolute path")
    elif not cb.is_file():
        errors.append("--claude-binary must be a real file")
    elif not os.access(str(cb), os.X_OK):
        errors.append("--claude-binary must be executable")
    elif cb.name != "claude":
        errors.append("--claude-binary basename must be 'claude'")

    if args.model not in _ALLOWED_MODELS:
        errors.append("--model must be claude-sonnet-4-6 for the bounded worker policy")

    if not (0.01 <= args.max_budget_usd <= 1.0):
        errors.append("--max-budget-usd must be between 0.01 and 1.0")

    if not (10 <= args.timeout_seconds <= 300):
        errors.append("--timeout-seconds must be between 10 and 300")

    return errors


def main():
    args = parse_args()
    errors = validate_args(args)
    if errors:
        for e in errors:
            print(f"validation error: {e}", file=sys.stderr)
        sys.exit(1)

    if not args.execute:
        print("DRY RUN - no mutation or inference will occur")
        print(json.dumps({
            "plan": {
                "db": args.db,
                "project": args.project,
                "task": args.task,
                "model": args.model,
                "max_budget_usd": args.max_budget_usd,
                "timeout_seconds": args.timeout_seconds,
                "actor": ACTOR
            }
        }, indent=2))
        sys.exit(0)

    result = run_task(args)
    safe_result = {k: v for k, v in result.items()
                   if k in ("status", "task_id", "artifact_id", "model_requested",
                            "model_reported", "total_cost_usd", "result_length",
                            "message", "result_stored")}
    print(json.dumps(safe_result, indent=2))
    if result.get("status") == "success":
        sys.exit(0)
    else:
        sys.exit(2)


if __name__ == "__main__":
    main()
