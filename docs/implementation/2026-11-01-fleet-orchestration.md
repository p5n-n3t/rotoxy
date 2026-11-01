# Fleet orchestration execution boundary

## What is implemented

`supervisor/snooze/fleet_orchestration.py` plans a bounded, topologically sorted DAG against an explicit resource snapshot. A resource is eligible only when its executor is registered, its requested capability/model/mode match, it is enabled and authorized, its health snapshot is fresh and healthy, capacity remains, and quota is explicitly available. A task-level `resourceId` or provider list is a hard pin/filter. Planning makes no provider calls and labels output `not_dispatched`.

`supervisor/snooze/jobs.py` now accepts an explicit `execution.mode: "inference"` binding for `oracle` and `cloudflare`, subject to account registration metadata. It queues a `run_inference` operation in the existing transactional outbox, uses the same worker lease, generation fence, account/project/global capacity, cancellation fence, and durable result table as the existing agent-session jobs. It does not fabricate a session ID. A result is complete only with a bounded assistant text, exact requested model attribution, a complete finish reason (`stop` or `end_turn`), a fresh timestamp, and the task output marker. Truncation/marker failure blocks the task. An expired or ambiguous mutation is retained for reconciliation and cannot be redispatched.

Provider account registrations can optionally include metadata shaped like:

```json
{
  "provider": "oracle",
  "models": ["oracle/qwen3.5:2b"],
  "maxOutputTokens": 128
}
```

This metadata is an allowlist and capacity declaration, not evidence of provider health, spend balance, or a running executor. Existing credentials stay in their current stores.

## Worker operation contract

The durable operation is returned by `JobRegistry.claim_operation()` with `kind: "run_inference"`, the committed `operationId`, pinned `selectedAccountId`, and bounded input fields `provider`, `model`, `prompt`, `maxOutputTokens`, `expectedMarker`, and `dispatchAt`. The executor must use the operation ID as its idempotency/correlation key when supported. It returns through `record_result()` with one of `accepted`, `rejected`, or `ambiguous` and the exact `reportedModel`, `assistantText`, `finishReason`, and `assistantAt` fields for an accepted response. Transport timeouts after request dispatch are ambiguous; workers must not retry them. No new DB or credential store was introduced.

## Integration still required

The current TypeScript `job-submit` validator and `job-worker.ts` still expose session/fresh-task operations only. They must be extended before MCP callers can submit `inference` tasks or a worker can execute `run_inference`. That worker should route Oracle through the existing fixed-origin, scoped-token `createOracleModelApi` adapter and Cloudflare through `CloudflareAIAdapter`, using the live credential/model allowlists and per-account limits. Do not route inference through a synthetic session or use the Oracle upstream service token directly. Until that TypeScript worker is wired, the Python operation is persisted and testable but is not a live provider execution path.

## Verification

Focused tests:

```sh
PYTHONPATH=supervisor python3 -m unittest supervisor.tests.test_fleet_orchestration supervisor.tests.test_jobs -q
```

The checked run passed 85 tests. No provider calls, service restarts, credential reads, or deployments were part of that verification.
