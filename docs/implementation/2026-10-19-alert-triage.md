# Worker alert triage and agent instructions

The desktop monitor was inspected on 2026-10-19. Its durable worker table contained 85 registrations: 76 idle and 9 failed with ACP_RELAY_DIED. Registrations are not distinct sessions. The latest 100 guidance events contained 54 idle-needs-review and 46 running transitions. The recent idle events followed running observations; no completion was inferred and no incident was acknowledged or erased.

The monitor runs every 300 seconds. Automatic guidance is disabled. Desktop receipts prove notification requests were accepted, not that a chat resumed. Recovery-event `completed` means processing of the event completed; it does not certify the worker's assignment completed.

Desktop notifications now state event counts by kind and point to Supervisor. Idle/completion/artifact-only batches use normal urgency. Failures, blocked work and approvals retain critical urgency. Existing per-event durable receipts and ambiguous-delivery protections remain in place. Ten desktop alarm tests passed, including mixed batches and restart deduplication.

`skills/rotoxy-orchestrate/SKILL.md` is included in the package for clients supporting local skills. It describes current discovered tool contracts and explicit capability boundaries. Installing an MCP connection does not automatically install a skill into every client. Instructions do not replace backend permissions, budgets or capacity enforcement.

Remaining acceptance: recover and validate outstanding worker artifacts; reconcile duplicated owner/session registrations; demonstrate bounded automatic recovery and complete multi-provider scheduling. This patch does not establish those claims.
