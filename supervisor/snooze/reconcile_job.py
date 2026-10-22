"""Operator CLI for explicit task reconciliation.

Accepts an ambiguous or blocked task in a local snooze state directory and
queues exactly one fresh observe_session using the original dispatch context.
Prints assignment and task IDs plus state only -- no instructions, prompts,
provider credentials, or network calls are made.

Usage (local operator recovery; back up and verify the target database first):

    python -m snooze.reconcile_job
        --state-dir /path/to/state
        --assignment-id ASSIGNMENT_ID
        --task-id TASK_ID
        --expected-revision N

Exit codes:
  0  reconciliation queued successfully
  1  rejected (stale revision, wrong state, duplicate, etc.)
  2  usage / argument error
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path


def _build_parser():
    p = argparse.ArgumentParser(
        prog="python -m snooze.reconcile_job",
        description=(
            "Queue one explicit observe_session for an ambiguous/blocked task. "
            "Local operator recovery only -- no network, credentials, or cloud calls."
        ),
    )
    p.add_argument(
        "--state-dir",
        required=True,
        metavar="PATH",
        help="Directory that contains the existing snooze.sqlite3 state file",
    )
    p.add_argument(
        "--assignment-id",
        required=True,
        metavar="ID",
        help="Assignment ID to reconcile",
    )
    p.add_argument(
        "--task-id",
        required=True,
        metavar="ID",
        help="Task ID within the assignment",
    )
    p.add_argument(
        "--expected-revision",
        required=True,
        type=int,
        metavar="N",
        help="Current assignment revision (for optimistic concurrency check)",
    )
    return p


def main(argv=None):
    parser = _build_parser()
    args = parser.parse_args(argv)

    state_path = Path(args.state_dir) / "snooze.sqlite3"
    if not state_path.is_file():
        print("error: existing snooze.sqlite3 state database not found", file=sys.stderr)
        return 1

    try:
        with sqlite3.connect(state_path.resolve().as_uri() + "?mode=ro", uri=True) as db:
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"assignments", "job_tasks", "operations"} <= names:
                raise ValueError("incompatible state")
    except (sqlite3.Error, ValueError):
        print("error: state database is unavailable or incompatible", file=sys.stderr)
        return 1

    from .jobs import JobRegistry

    try:
        registry = JobRegistry(state_path)
    except Exception as exc:
        print(f"error: could not open state directory: {exc}", file=sys.stderr)
        return 1

    try:
        result = registry.reconcile_task(
            args.assignment_id,
            args.task_id,
            args.expected_revision,
        )
    except KeyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    output = {
        "assignmentId": result["assignmentId"],
        "taskId": result["taskId"],
        "taskState": result["state"],
        "assignmentState": result["assignmentState"],
        "revision": result["revision"],
        "generation": result["generation"],
        "attempt": result["attempt"],
        "sessionId": result["sessionId"],
    }
    print(json.dumps(output, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
