# Worker alert triage and agent instructions

The desktop monitor was inspected on 2026-10-19. Its durable worker table contained 85 registrations: 76 idle and 9 failed with ACP_RELAY_DIED. Registrations are not distinct sessions. The latest 100 guidance events contained 54 idle-needs-review and 46 running transitions. The recent idle events followed running observations; no completion was inferred and no incident was acknowledged or erased.

The monitor runs every 300 seconds. Automatic guidance is disabled. Desktop receipts prove notification requests were accepted, not that a chat resumed. Recovery-event `completed` means processing of the event completed; it does not certify the worker's assignment completed.

Desktop notifications now state event counts by kind and point to Supervisor. Idle/completion/artifact-only batches use normal urgency. Failures, blocked work and approvals retain critical urgency. Existing per-event durable receipts and ambiguous-delivery protections remain in place. Ten desktop alarm tests passed, including mixed batches and restart deduplication.

`skills/rotoxy-orchestrate/SKILL.md` is included in the package for clients supporting local skills. It describes current discovered tool contracts and explicit capability boundaries. Installing an MCP connection does not automatically install a skill into every client. Instructions do not replace backend permissions, budgets or capacity enforcement.

Remaining acceptance: recover and validate outstanding worker artifacts; reconcile duplicated owner/session registrations; demonstrate bounded automatic recovery and complete multi-provider scheduling. This patch does not establish those claims.

## Follow-up recovery and attribution

All four saved 2026-10-18 review sessions passed owner-bound status and transcript reads on 2026-10-19. Each was idle without a reported execution error. None of the newest user-instruction hashes matched its saved assignment, and no current reply contained that assignment's completion marker. These transcripts were preserved privately and were not credited as completed assignment output. No paid worker was relaunched.

The current monitor registry contains 63 owner bindings for seven distinct account/session pairs. Older watched-worker rows are historical observations, not the current roster. Owner bindings are deliberately retained separately for access isolation. The compact summary now returns scoped registration, distinct-session and distinct-account counts; event entries include captured account, session and reported model. Recovery decision entries also retain account/session attribution.

Joining the current registry to its watched-worker observations shows all seven distinct current sessions idle. The nine failed watched-worker rows are historical and are not current roster entries. This is a status observation, not completion verification.

The two persisted Oracle advice references were reconciled read-only against the queue: both tasks are complete and report qwen3.5:9b. The recovery projection already resolves queue status rather than relying on its original queued-intent row; advice does not authorize corrective actions.

The MCP initialize response now includes concise orchestration instructions using the standard optional `instructions` field in the [2025-06-18 lifecycle specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle). This is client guidance and does not grant tool/project access or guarantee every client follows it.

Verification: TypeScript build; five Node submission/collaboration checks; 16 guidance, 12 recovery-service and 11 recovery-engine Python checks passed. Live status/transcript reads and Oracle queue reconciliation were read-only. No paid dispatch, automatic session resumption or new recovery authority was enabled.
