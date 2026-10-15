# ROTOXY delegation reliability — 2026-10-15

## Baseline and branch

Repository: p5n-n3t/token2oauth (distinct from the older rotoxy repository).
Branch: `codex/delegation-reliability-20261015`.
Worktree: `/home/jq/Desktop/Token2OAuth/.worktrees/delegation-reliability-20261015`.
**Exact base commit:** `1d14fd7f10208b776e22d1574ff9a95cf569372e`.
**Final revision:** the pushed branch HEAD, reported as an exact SHA in the final delivery (a commit cannot embed its own SHA in a tracked file).
Integration worktree had unrelated Cloudflare/server changes; none were copied or modified.

## Root causes and real evidence

- Live account-pinned **read-only** LightSprint status for `CT61p6DgYQFuUmXox7xjl`: accepted status read, sessionStatus `idle`, errorCode `ACP_RELAY_DIED`, reported model `claude-opus-5-5`, owner verified. **Execution failed; no validated architecture artifact.** No relaunch was attempted.
- Live official MCP `tools/list` described one `lightsprint_api` tool with arguments `method,path,body?`. Token transcripts have `{items,nextCursor,prevCursor,hasMore}` and each item has `seq,turnId,type,time,payload`. Actual read-only metadata included `user_message`, `assistant_snapshot`, `tool_call`, and `turn_truncated`, explaining why the old `messages`-only projection returned unknown.
- Documented pagination: `limit=1..100`, `include=text,tools,tool_io`, `maxBytes=1024..4194304`, `before=prevCursor` (older) and `after=nextCursor` (forward). **The shared tool policy rejected the bounded query-path GET** while permitting a base transcript GET. Do not bypass policy; integration must authorize narrowly bounded read-only pagination.
- The provider description documented ordinary task launches, status/transcript/chat/cancel/stop and skill/config resync, but **no general failed-session relaunch, identity-preserving replacement or exact model selector**. Do not interpret skill/config resync as a supported relay recovery operation.
- Read-only Oracle SQLite: `app15-routing-review` is still `ambiguous` on `ora3`, `qwen3.5:9b`, one attempt, `transport_exit`, no actual model or result. Events: queued → running → ambiguous. A later SSH connectivity probe cannot prove execution. No duplicate inference was launched.

## Changes

- `src/worker-observation.ts`: normalize reported error codes without copying free-form messages, prioritize provider failure over idle, preserve bounded native-approval questions.
- `scripts/monitor-workforce.mjs`: apply the same normalization before durable observations. Existing deterministic long-running polling and bounded parallelism remain.
- `src/job-worker.ts`: failed, cancelled or timed-out sessions cannot complete from an old transcript; native approvals become `needs_approval`; completion from typed items requires a fresh answer and a SHA-256 match to original dispatched instructions. Accepted sends remain `submitted`; cancelled readback checks `sessionStatus`.
- `src/providers/lightsprint-jobs.ts`: bounded projection of documented typed items; never include user prompts or tool payloads. Only last assistant snapshot associated with the newest user turn is a candidate. Newer user messages, truncated turns, missing association or oversized content remain incomplete. Keep cursor/truncation metadata; unknown shape previews withhold source text.
- `supervisor/snooze/jobs.py`: propagate the dispatched instruction digest to observation operations, never duplicate the instructions in observation records. Terminal errors or approval handoffs do not repeatedly poll into false completion.
- `supervisor/snooze/guidance.py`: safely migrate SQLite error code columns; de-duplicate stable incidents through restart; distinguish native approval from ordinary guidance; preserve account/session/model and event acknowledgement. New private `compact-summary` CLI returns bounded, owner-scoped worker states, last transitions, errors, action ownership, acknowledgement cursor and explicit unknown usage/capacity, never prompt bodies or secrets.
- Focused Node/Python tests cover source attribution, failure, dedup, restart, approval and ambiguity.

## Verification and boundaries

- `npm run build`: passed.
- 43 focused Node tests passed. Cases include idle plus provider error, accepted dispatch not equal to completion, old/incomplete token transcript, typed turn association, exact dispatch digest, parked native approval, ambiguous send never replayed, account/model attribution, bounded projections and omission of secrets.
- 76 focused Python tests passed. Includes supervisor job and Oracle ambiguity classification, recovery service, durable observation/restart and event dedup. A test ran **separate Python CLI processes** against one isolated private SQLite database to prove that a failed observation remained visible after process exit and did not create duplicate incidents.
- `git diff --check`: passed. Isolated `HOME` / `TOKEN2OAUTH_CONFIG_DIR` and temporary databases used for stateful tests. Existing SQLite ResourceWarnings from Python Oracle pool tests are nonfatal.
- **Read-only provider observation is not end-to-end execution proof.** No paid inference, agent launch, provider repair, billing, release or deployment happened.
- Observed `snooze.service` active with `Restart=on-failure`; one `monitor-workforce.mjs` process existed. Neither production service nor monitor was restarted. Production restart/disconnect resilience is **not** asserted from the synthetic process test.

## Safe frontier recovery and required integration seams

1. Keep automatic paid recovery off. First read back the exact frontier task and existing `lightsprint-agents` sessions under its pinned account; preserve the current failed session and reconcile task identity. Before any billable new launch, request coordination with the integrating agent, exact supported operation/model, timeout and observed-cost guard. The documented schema exposes no general relaunch or exact model change. Never retry a non-idempotent POST after an ambiguous receipt.
2. Integrator: approve and test **only** bounded read-only `transcript?limit=...&include=text&maxBytes=...&before=...` paths through existing tool policy, not a generic query passthrough. Bound page count and bytes. Until then, incomplete newer-turn association remains a handoff, not a success.
3. Integrator: expose the private `python3 -m snooze.guidance --db <private-db> compact-summary --project <project>` command through existing authenticated, owner-authorized supervisor API. Send authorized owner IDs on stdin as JSON. Do not expose this raw CLI or alter forbidden `src/server.ts` / UI files in this branch. The compact projection is worker/session scoped; actual assignment and artifact references must be supplied by the authorized assignment registry. Missing refs, capacity and usage remain unknown.
4. Oracle: preserve original `app15-routing-review` ambiguity, and check independent logs or durable results only when they can be linked to the **same original operation**. Without proof, operator decision is required. A later successful SSH check is not an inference receipt.
5. Production monitor continuity requires a coordinated, non-destructive process/restart test; this branch only proves the durable data side via a separate-process fixture. Native approvals are inbox-only; no invented provider approval API. No service lifecycle, production policy or network routing changes.

## Live operations / running state

Only read-only LightSprint status, tool schema and transcript metadata; one policy-denied bounded-query GET; Oracle SQLite inspection; read-only service/monitor checks. No credentials, cookies, prompts, raw transcripts, Oracle generation or paid launches were exported. Existing live Snooze and monitor processes were left intact. No production deployment or merge.
