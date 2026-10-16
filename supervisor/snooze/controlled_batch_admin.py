"""Private, local-only administrator bridge for exact controlled-batch grants."""
from __future__ import annotations
import json
import os
from pathlib import Path
import stat
import sys

MAX_INPUT = 16 * 1024
MAX_ROWS = 25
MAX_GRANTS = 16


def _safe_db(path: Path):
    if not path.is_absolute() or path.is_symlink() or not path.exists() or not path.is_file():
        raise ValueError("jobs_database_unavailable")
    info = path.stat()
    parent = path.parent.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077 or parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) & 0o077:
        raise ValueError("jobs_database_permissions_invalid")
    return path


def snapshot(registry, now=None):
    """Return metadata-only candidates and active/expired grants; never expose operation input."""
    from .controlled_batches import ensure_schema
    import time
    when = time.time() if now is None else now
    with registry.connection(write=True) as db:
        ensure_schema(db)
        assignments = db.execute("SELECT id,state,approved FROM assignments WHERE approved=1 AND state IN ('queued','held') ORDER BY created_at DESC LIMIT ?", (MAX_ROWS,)).fetchall()
        operations = []
        for assignment in assignments:
            rows = db.execute("SELECT id,assignment,task_id,attempt_id,generation,account,kind,input,state,error_class,created_at,worker,lease_until FROM operations WHERE assignment=? AND kind='chat_session' AND (state='queued' OR (state='rejected' AND error_class='CreditAdmissionDenied')) ORDER BY created_at LIMIT 20", (assignment['id'],)).fetchall()
            for op in rows:
                if len(operations) >= MAX_ROWS: break
                task = db.execute("SELECT body,state FROM job_tasks WHERE assignment=? AND task_id=?", (op['assignment'], op['task_id'])).fetchone()
                try:
                    task_body = json.loads(task['body']) if task else {}
                    operation_input = json.loads(op['input'])
                except (TypeError, json.JSONDecodeError):
                    continue
                model = task_body.get('model') if isinstance(task_body, dict) else None
                if not isinstance(model, str): model = operation_input.get('model') if isinstance(operation_input, dict) else None
                if not isinstance(model, str) or len(model) > 160: model = "Unknown"
                from .controlled_batches import _canonical_binding
                binding_hash, _ = _canonical_binding(db, op['assignment'], [op['id']])
                operations.append({"bindingHash": binding_hash, "assignmentId": op['assignment'], "operationId": op['id'], "taskId": op['task_id'],
                    "attemptId": op['attempt_id'], "generation": op['generation'], "accountId": op['account'],
                    "kind": op['kind'], "state": op['state'], "reason": "credit_denied" if op['error_class'] == "CreditAdmissionDenied" else "queued",
                    "model": model, "createdAt": op['created_at'], "taskState": task['state'] if task else "unknown"})
        grants = db.execute("SELECT id,assignment,operation_ids,account_ids,max_launches,expires_at,acknowledged_unknown_cost,created_at FROM controlled_batch_approvals ORDER BY created_at DESC LIMIT ?", (MAX_GRANTS,)).fetchall()
        grant_views = []
        for grant in grants:
            ids = json.loads(grant['operation_ids']); accounts = json.loads(grant['account_ids'])
            consumed = db.execute("SELECT COUNT(*) FROM controlled_batch_consumptions WHERE approval_id=?", (grant['id'],)).fetchone()[0]
            grant_views.append({"approvalId": grant['id'], "assignmentId": grant['assignment'], "operationIds": ids[:3],
                "accountIds": accounts[:3], "maxLaunches": grant['max_launches'], "consumed": consumed,
                "expiresAt": grant['expires_at'], "expired": when >= grant['expires_at'],
                "acknowledgedUnknownCost": bool(grant['acknowledged_unknown_cost'])})
    return {"operations": operations[:MAX_ROWS], "grants": grant_views}


def approve_request(registry, value, now=None):
    from .controlled_batches import approve
    if type(value) is not dict or set(value) != {"assignmentId", "operationIds", "accountIds", "maxLaunches", "ttlSeconds", "ackUnknownCreditCost", "expectedBindings"}:
        raise ValueError("invalid_request")
    if not isinstance(value['operationIds'], list) or not isinstance(value['accountIds'], list) or any(not isinstance(x, str) for x in value['operationIds'] + value['accountIds']):
        raise ValueError("invalid_request")
    expected = value["expectedBindings"]
    if type(expected) is not dict or set(expected) != set(value["operationIds"]) or any(not isinstance(v, str) or len(v) != 64 for v in expected.values()):
        raise ValueError("invalid_request")
    if type(value['maxLaunches']) is not int or type(value['ttlSeconds']) is not int or value['ackUnknownCreditCost'] is not True:
        raise ValueError("invalid_request")
    return approve(registry, value['assignmentId'], value['operationIds'], value['accountIds'], value['maxLaunches'], value['ttlSeconds'], True, now=now, expected_bindings=expected)


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--state-dir', required=True)
    args = parser.parse_args(argv)
    try:
        state_dir = Path(args.state_dir)
        if not state_dir.is_absolute() or state_dir.is_symlink(): raise ValueError("invalid_state_directory")
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT: raise ValueError("input_too_large")
        payload = json.loads(raw)
        if type(payload) is not dict or set(payload) - {"action", "approval"}: raise ValueError("invalid_request")
        from .bridge import create_job_registry
        _safe_db(state_dir / "snooze.sqlite3")
        registry = create_job_registry(state_dir)
        if payload.get('action') == 'read' and set(payload) == {"action"}: result = snapshot(registry)
        elif payload.get('action') == 'approve' and set(payload) == {"action", "approval"}:
            _safe_db(state_dir / "snooze.sqlite3")
            result = approve_request(registry, payload['approval'])
        else: raise ValueError("invalid_request")
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as exc:
        allowed = {"invalid_request", "input_too_large", "invalid_state_directory", "jobs_database_unavailable", "jobs_database_permissions_invalid",
            "max launches must be 1..3 and no greater than operation count", "approval requires 30..600 seconds and unknown-cost acknowledgement",
            "operation is not an exact chat_session in this assignment", "operation binding changed", "account IDs must exactly match the selected accounts of these operations",
            "operation state is not safely grantable", "pause the project before requeuing a known credit-denied operation", "assignment must be already approved and queued or held"}
        message = str(exc)
        print(json.dumps({"error": message if message in allowed else "controlled_batch_operation_failed"}, separators=(",", ":")))
        return 2

if __name__ == '__main__':
    raise SystemExit(main())
