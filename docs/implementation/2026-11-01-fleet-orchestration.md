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

## TypeScript integration

Source commit `58dc48e` adds the TypeScript inference submission, worker and
runtime wiring. Oracle uses the fixed private API with an owner-private service
credential and a trusted restriction-only host list; Cloudflare uses an exact
credential pin in its existing adapter. No caller can supply upstream credentials
or host lists. This is source implementation until a release/canary proves it.
Codex and Claude durable execution adapters remain separate unfinished work.

Cloudflare does not always report a model ID or finish reason. Its receipt
therefore distinguishes `modelEvidence: pinned_endpoint` and
`terminationEvidence: expected_marker`, with no invented reported model.
The declared completion marker must be the final nonempty line. An explicit
truncated/error finish signal takes precedence. Oracle requires its reported
model and finish reason. Neither marker validation nor a successful HTTP call
alone proves semantic artifact quality.

`7bc043f` fixes optional in-memory-store compatibility and inference worker
concurrency. `1c2c7e9` shares account-slot counters between same-process HTTP
and job adapters; this does not provide cross-process leases.

## Verification

Focused tests:

```sh
PYTHONPATH=supervisor python3 -m unittest supervisor.tests.test_fleet_orchestration supervisor.tests.test_jobs -q
```

The checked run passed 85 tests. No provider calls, service restarts, credential reads, or deployments were part of that verification.
