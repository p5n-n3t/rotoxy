# Recovery engine — T2O-W2-SUPERVISION-RECOVERY-20261012

**Branch:** `codex/t2o-w2-supervision-recovery-20261012`. **Base:** `origin/main` at `00e6e8f91564b7e4706b8dab3b36221c8bdfb4a2`. **Implementation:** `supervisor/snooze/recovery.py`; focused tests are in `supervisor/tests/test_recovery.py`.

## Behavior and safety

`RecoveryEngine` persists scoped policies, trusted session bindings, deduplicated incident IDs, decisions, action claims/receipts, budget reservations, and Oracle advice handoffs in a private SQLite database. Call `configure`, `register_session`, `ingest`, then `run`; `get` returns the durable receipt and `pending_handoffs` lists operator work. Events retain only bounded classification and stable project/job/account/session IDs; raw prompts, provider payloads, and untrusted event narratives are not stored or sent to Oracle.

Policies explicitly choose `observe`, `notify`, `rules`, `cloud-supervisor`, `headless`, or `human`, with action permissions, maximum attempts/runtime, budget ceiling, and optional Oracle rate limit. Hard store caps are 1,000 scopes, 10,000 session bindings, and 100,000 incidents; the engine rejects new data at capacity and has no automatic purge. Action names resolve only through adapters registered by trusted setup code. Each action is claimed in SQLite before crossing its adapter boundary. Only a proven `rejected`/`definitely_not_started` receipt can be invoked again by an explicit later `run`, up to the configured attempt cap. Crashed/expired claims and unproven rejections become `ambiguous`; they are never replayed. Ambiguous paid actions retain their full budget reservation.

Cloud-supervisor and headless actions require a trusted resource-verifier callback reporting the exact bound project/job/account/session, available quota, verified budget, sufficient available amount, and observation time no more than 30 seconds old (5 seconds of clock skew allowed). A missing verifier or unknown/depleted quota fails to human handoff. Oracle advice is queued only for significant incidents (failed, stalled, ambiguous, needs-instructions, ownership-unknown, quota-blocked), with a per-scope hourly cap and stable OraclePool job ID. Oracle output is advisory; it is never parsed into or sent to an action adapter. The ChatGPT Web/Desktop target has no headless adapter and always requires human handoff.

Headless is disabled by default (`headless_adapter_verified: false`). The only intended integration is a trusted fixed adapter over `ResumptionBroker`, which binds a registered CLI executable/session and invokes a fixed argv with `shell=False`; event data cannot choose executable, argv, model, or session. The repository research note cites documented Claude/Codex resume forms, but this assignment did not verify the actual installed CLI version. Keep the flag false until the operator verifies the installed CLI's official docs/version, fixed argv, and policy. Codex's CLI budget is not a hard spend cap; a runtime acknowledgment is not proof of a provider ceiling.

## Integration patch required

This module is intentionally not wired to the service in this assignment. The owning integration change should:

1. In trusted runtime setup (`supervisor/snooze/engine_setup.py`), create the recovery DB under the existing private state root, register only the sessions already approved for the same project/job/account, configure the minimum permitted level, and inject named allowlisted adapters. Do not expose event-controlled adapter configuration.
2. In the monitor/check cycle (`supervisor/snooze/monitor.py` or the runtime owner), normalize `GuidanceInbox` significant events and owner-scoped `JobInbox.read` events to the strict `ingest` shape; call `run(event_id)` once and persist/show the returned receipt. Do not turn idle into completion or retry `ambiguous`.
3. Implement only preapproved deterministic rule adapters. For paid cloud/headless adapters, inject a resource verifier that rereads current account/session quota and numeric budget evidence immediately before dispatch; leave unavailable/unverified inputs unavailable. Use the existing `ResumptionBroker` as the headless boundary and compare its registered session/account to the engine binding.
4. Surface `pending_handoffs()` through the existing operator inbox. Keep Oracle results in their advice surface and require separate authorization for any consequential follow-up.

No runtime/HTTP route, monitor wiring, provider adapter, CLI invocation, provider call, or deployment was changed or performed here. Rule/notify/headless/cloud adapters are contract-injected and require integration tests before enabling them. The module's adapter timeout is cooperative: each adapter must enforce the supplied timeout; overrun is recorded ambiguous and is never replayed.

## Verification checkpoint

Focused tests cover event conflicts/dedupe, session affinity, permission/rule gating, safe explicit retry, crash/timeout ambiguity, unverified quota/budget, held ambiguous budget, and significant-only Oracle submission. No live Oracle inference or headless process is executed by these tests.
