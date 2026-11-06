# Codex subscription worker: DAG integration seam

**Status as of 2026-11-06:** the seams below have a local implementation and synthetic integration proof. Live subscription execution and deployment verification are pending. The November4 mixed-provider proof covers Claude, Oracle and Cloudflare.

## Baseline audit from 2026-11-04

- `src/codex-profiles.ts`: `CodexProfiles.startExecution()` returns a cancellable handle. Its `executeTurn()` refreshes a profile, verifies exact model/reasoning support and an allowlisted canonical working directory, starts or resumes a thread, and starts a turn. `bindThread()` / `profileForThread()` persist and enforce thread-to-profile ownership. `CodexExecutionHandle.pendingRequests` collects App Server approval requests but never answers them. `close()` closes local App Server transports.
- `src/codex-pool-policy.ts`: `CodexPoolPolicyStore.eligibleCandidates()` fails closed for unresolved origins and excludes protected profiles, but no DAG dispatch currently calls it. Its active counts must come from the durable scheduler.
- `src/origin-protection.ts`: `OriginProtectionStore.evaluateSubscriptionDispatch()` checks trusted actor/session bindings, verified provider account subjects and protected profiles. This is the required source of origin decisions; request fields are not trusted evidence.
- `src/claude-dag-jobs.ts`: existing `AgentJobExecutor` pattern for a stable DAG operation mapped to an owner-bound workspace task.
- `src/job-worker.ts` and `src/supervisor-runtime.ts`: `run_agent` executor seam, resources, eligibility checks, `setAgentExecutor()`, and durable assignment cancellation. `src/server.ts` currently wires `ClaudeDagJobs` only.
- `supervisor/snooze/jobs.py` at the audit baseline accepted only `provider='claude-code'`; accepted result checks are Claude-specific. `src/provider-paths.ts` reports Codex provider dispatch unavailable.

## Implemented integration boundary (see November6 verification report)

Add a Codex `AgentJobExecutor` adapter backed only by `CodexProfiles`, `AgentWorkspaceService`, the existing main scheduler, `CodexPoolPolicyStore`, and trusted `OriginProtectionStore` resolution. Wire it in `src/server.ts` through a composite agent executor that routes by provider; do not add a second scheduler or provider-specific job submission path. Extend the existing `run_agent` contract in `supervisor/snooze/jobs.py` to allow Codex with exact provider/account/profile/model/timeout matching and Codex result validation. Register resources as `codex:<profileId>` with current models and configured capacity; the scheduler assignment’s selected account and profile binding must remain immutable from reservation through result receipt.

Before dispatch, resolve the authenticated OAuth client plus server-owned session to a verified origin binding. Derive protected profile IDs and the verified account subject server-side, exclude protected identities, and store the exact resolved account/profile on the assignment. Do not trust `CodexExecutionRequest.origin.callerId`, protected IDs, account IDs, or profile IDs supplied by the task body; the current Codex API documents `callerId` as advisory.

Map each mutating scheduler operation to a stable workspace task ID derived from its operation ID. Persist a durable attempt fence before `thread/start` / `turn/start`; after either request may have reached App Server, a timeout, lost receipt, worker exit, or lease loss is ambiguous and must retain the slot for reconciliation. Never automatically issue a replacement turn. Preserve profile ownership for every returned thread ID.

App Server runs with `approvalPolicy='on-request'`, read-only sandbox and network disabled. Pending approval requests are collected but the current API has no response method or durable approval workflow. Do not auto-approve or report completion while approval is unresolved; add explicit owner approval handling before accepting approval-gated work, or fail closed.

## Acceptance tests

1. With a resolved trusted origin and exact eligible profile/model, one turn starts. An unresolved origin, mismatched account/profile, or protected target is rejected before `thread/start`.
2. A successful fake App Server turn creates one owner-bound workspace artifact and completes only when account/profile/model, output byte limit, timestamps, and final marker all match. Approval requests remain unanswered and cannot complete the DAG task.
3. Cancellation and shutdown interrupt only the bound profile/thread/turn. A lost `thread/start` or `turn/start` receipt stays ambiguous after worker restart, retains slot capacity, and never causes a replacement launch.
