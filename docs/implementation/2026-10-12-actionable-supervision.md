# ROTOXY actionable supervision checkpoint — 2026-10-12

This release extends the unified ROTOXY gateway with durable worker questions, manual idle-worker guidance and a guarded headless recovery adapter. It does not complete the entire platform roadmap. The canonical repository remains `p5n-n3t/token2oauth`; existing configuration and MCP URLs remain compatible.

## Delivered behavior

- The read-only monitor retains bounded, redacted provider question context and prompt counts. New durable events capture the registered account/session binding; old events without it remain unknown. SQLite migration is additive and serialized.
- The worker console shows the account, session, task correlation, requested model and observed model together. Questions and native approval/review requests become provider handoffs. The schema of a live parked question remains unverified.
- An administrator can send one follow-up to an owned idle worker through a CSRF-protected route. Current session identity, prompt count, account eligibility and tool policy are checked immediately before admission. A private, fsynced action ledger reserves before mutation and returns durable receipts. Changing request IDs cannot bypass unresolved actions. Ambiguous delivery is never silently replayed.
- Workers, Inbox, Recovery and Handoffs use full-width keyboard-operable tabs. Mobile rows become cards, with full-width forms and ROTOXY branding. A breadcrumb returns to administration.
- Under load, the embedded Python supervisor could exceed the old five-second startup allowance. Startup now has a bounded 30-second allowance; a delayed real-child test checks readiness and cleanup. IPC fixtures close child processes before removing state.
- The optional Codex adapter invokes the installed official CLI resume interface with a fixed read-only sandbox, explicit session mapping, bounded runtime/output, minimal environment and process-group cleanup. It remains disabled in production because the standalone supervisor has no authoritative resource verifier. Tests and argument-parser validation are not an authenticated resumption test.

## Execution evidence

The integration root sent one real `gpt-6-luna` instruction through an isolated HTTP admin server using the actual LightSprint adapter. Missing CSRF was denied, strict policy sent nothing, a one-shot test permit admitted the message, a duplicate returned its receipt, and the final assistant marker was retrieved. The provider send count was one; the observed prompt count increased by one. The reported USD increase was approximately $0.000794. This is not a native credit measurement, public dashboard login test or approval workflow.

Five workers had overlapping observed running states across four LightSprint accounts in this wave. Routine implementation used `gpt-6-luna`; the requested frontier architecture run used the verified `claude-opus-5-5` selector. Its delayed observed-cost guard stopped it before a new architecture artifact was delivered, so that review is not counted as complete. Four implementation strands and their follow-up fixes were recovered from isolated worker branches and integrated. Oversized transcript responses were rejected by the bounded adapter; git artifacts supplied the reviewable deliverables instead. No purchase or top-up occurred, and the strict read-only tool policy was restored.

Three bounded Oracle advisory tasks completed on ora1, ora3 and ora5 using `qwen3.5:9b`. Their recommendations remained advisory and were checked before integration.

The process-level continuity test uses synthetic incidents and temporary state, with zero provider calls. Its initiating registration process exits; a separate supervisor records failure/question incidents, stops, and restarts after more events arrive. Four events and three action/notification receipts persist, replay processes zero events, and no duplicate action occurs. The dormant web case becomes a human handoff. This establishes local durable recovery, not recovery during host power loss or an actual cloud worker failure.

## Verification

Final counts, runtime checks and sanitized evidence are recorded in `evidence/2026-10-12-actionable-supervision.json`. The automated checks include 338 passing Node regression tests, 317 passing Python tests, 15 focused startup/shutdown checks, actual desktop/mobile headless rendering, isolated guidance delivery, process continuity and an offline package extraction/import audit. Browser fixtures prove layout and API handling separately from provider delivery. Codex 0.162.1 accepted the fixed resume argument layout under `--help`; no authenticated model turn was launched.

## Runtime and rollback

The installed runtime is `~/.local/share/token2oauth`. One foreground Tailscale Funnel maps HTTPS root to port 2030. OAuth and MCP routes use the secured unified application, and predecessor services remain masked. Boot startup remains off; use `rotoxy up`, `rotoxy down` and `rotoxy status`.

Before this update the configured services were stopped briefly for a consistent private configuration/database archive. The pre-update runtime and archive are retained under unique `pre-recovery` paths recorded in the private recovery-wave checkpoint. A code rollback stops the services with `rotoxy down`, restores that runtime, then calls `rotoxy up`. The schema changes are additive. Do not overwrite newer databases with an old archive without separately reviewing the data loss; no global Tailscale reset is needed.

## Remaining acceptance gaps

Production strict policy may reject manual paid guidance; this release does not silently broaden it. Native question/approval APIs, automatic cloud supervision, authenticated headless resumption, authoritative live quota acquisition, actual signed-in subscription-pool dispatch, external supervisor failover, broad analytics and clean-machine installation remain unfinished. The current registry has twelve accounts, eleven enabled; both new accounts remain enabled and the depleted account remains disabled. These are configuration observations, not a fresh twelve-account authentication test. Per-account provider concurrency limits and 24/35-worker execution remain unverified. Historical credit readings are labeled snapshots and are never converted from USD or automatically refreshed by calendar arithmetic.

The next integration step is a trusted resource-evidence adapter and explicit bounded recovery policy, followed by an authenticated isolated resume test and an observed cloud-failure recovery test. Native approvals require documented provider semantics before controls can be enabled.
