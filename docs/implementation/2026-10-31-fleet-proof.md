# ROTOXY fleet execution proof — 2026-10-31

## Outcome

**Corrected request accepted, but fresh task verification blocked before provider launch.** The first request combined `scheduling.profile: "economy"` with `scheduling.maxConcurrency: 1`; local production validation confirms `maxConcurrency` is only valid with the `custom` profile. That request returned `invalid_input` and reconciliation found no execution. After a corrected payload was locally validated and the parent authorized one corrected submission, the gateway accepted the one-task job. Fresh LightSprint task creation and instruction patching succeeded, but the verification readback was rejected because code compared the human-facing task `ref` before its canonical internal `id`. A later read-only GET with the worker's exact account/workspace binding confirmed that canonical `id` matched the requested provider task ID and the instruction description matched byte-for-byte. No `launch_task` or `chat_session` operation was queued, so no provider inference task started. No task result or provider-reported model was produced.

## Scope and guardrails

- Authorized project: `token2oauth` (`ROTOXY Fleet`).
- One eligible account selected: `maryjoebake` (`KEnC9JfryDUd`). No other account was submitted.
- Requested execution: one fresh `claude` task, economy profile, concurrency 1, 600-second observation deadline, maximum output 4096 bytes.
- Task: concise three-case checklist covering manual pause, stale renewal, and ambiguous dispatch; no browsing, repository access, or tools requested.
- Excluded accounts `p0y50n`, `itscommmena`, `niandran`, `ngilfordz`, and `jqleq` were not selected. No quota configuration was changed and no purchase/top-up was made.

## Live observations

`job_workers` reported `maryjoebake` enabled, dispatch-bound, healthy, and `fresh_ready`, with a fresh `claude` workspace/stack binding. Its quota was `unknown`; the registered session model was `gpt-6.1-sol`, which is configuration metadata and not a provider result. `workspace_snapshot` additionally described its execution availability as “Legacy credit policy needs confirmation; live session readiness not checked.” These observations do not confirm an available paid quota or a successful provider launch.

The bounded inbox read returned older events for unrelated executions; no evidence from those events is used as proof for this attempt.

## Attempt and reconciliation

- Stable job ID: `rotoxy-renewal-review-20261031`
- Stable idempotency key: `rotoxy-renewal-review-20261031-submit-v1`
- Initial `workspace_dispatch` call: returned `invalid_input` without structured field-level detail. The captured payload included `scheduling: { profile: "economy", maxConcurrency: 1 }`.
- Production-equivalent local validation reproduced the rejection: `maxConcurrency is only valid for the custom profile`. Removing `maxConcurrency` from this one-task economy request made `validateJobSubmission` accept the payload. This was an input construction mistake, not evidence of a supervisor admission defect.
- Before the corrected submission, `job_status` for that ID returned `supervisor operation failed`, and `workspace_sync` returned `execution_not_found`. This supported that the malformed request had not created a durable execution.
- One corrected `workspace_dispatch` call, using the same intended job ID and idempotency key and `scheduling: { profile: "economy" }`, returned `accepted: true`, `replayed: false`, `state: "accepted"`.
- `job_status` and `job_results` then returned `supervisor operation failed`. `workspace_sync` successfully reconciled the durable execution as `held`; its task was `blocked` with sanitized error `provider_operation_unavailable`, and results were empty.
- Read-only SQLite inspection of the local supervisor DB showed the exact phase sequence: `create_task accepted`, `patch_task accepted`, then `verify_task_packet rejected` with `error_class: instruction_roundtrip_unverified`. It contains no `launch_task` or `chat_session` operation. The task's canonical internal ID was `1h_R5m6trdfmqOaW1tOu-`; the provider GET returned `id` equal to that value and human `ref` `MARYSW-2`. The expected and returned descriptions were each 364 bytes with SHA-256 `5429a3b5e72af79544bb9d483dd770ac1d39dcd901d4500f60eccf5fe4c07968`.
- A read-only `job_status` call using the private remote ID returned `held`, `blocked`, `errorClass: instruction_roundtrip_unverified`, `redispatchAllowed: false`, and `nextAction: inspect_original_execution`. Calling raw `job_status` with the workspace-visible job ID returns a generic error because `workspace_dispatch` hashes that ID; workspace-created jobs should be observed with `workspace_sync`.
- No further dispatch, replay, pause/resume, or reconciliation action was issued. No provider-reported model/account or terminal output is available.

## Smallest actionable gap

The request must omit `maxConcurrency` when using the `economy` profile (or use `custom` when an explicit concurrency value is intended). The live MCP schema did not communicate that profile-dependent restriction, while the production validator enforces it. Fresh-task verification now compares the canonical ID first, still requires an exact description match, and carries the durable expected instructions into the stateless launch adapter for another exact GET before a launch. The sync projection preserves the safe `instruction_roundtrip_unverified` reason. The accepted held job is explicitly non-redispatchable; it was not resumed or retried. Current quota remains `unknown`, and the workspace snapshot still says legacy credit admission needs confirmation.

## Evidence boundary

This proves the configured account was discoverable and advertised as fresh-ready, the malformed request was refused by validation, and the corrected single-job dispatch was accepted into durable supervision. It also isolates and fixes the local false-negative task identity check. It does **not** prove provider start, successful admission, task completion, actual provider model, slot capacity, or readiness across other accounts/projects.

## Node 22 background reconciliation test follow-up

CI on Node 22 exposed a lost-observer race in `test/agent-workspace-execution.test.mjs`, not a reconciler runtime failure. `buildApp` starts an automatic 30-second reconciler; the test had installed its completion observer only after awaiting `workspace_dispatch`. If the automatic reconciler settled the new binding during that gap, the test then started a second reconciler and waited for a completion event that could no longer recur. The test now installs the observer before dispatch, retains the 200 ms reconciler as a bounded fallback, and restores the observer even if dispatch fails. No timeout was raised, no runtime scheduling behavior was changed, and the focused integration test passed on Node v22.22.1 (`31.6s`, one test, zero failures) using the existing `dist` build.
