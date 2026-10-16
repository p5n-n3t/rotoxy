# Agent Workspace reconciliation checkpoint

This change adds an internal read-only reconciler for already-published workspace execution bindings. `WorkspaceExecutionService` exposes only callback closures for its private SQLite `claim_reconciliation` and `settle_reconciliation` commands; `WorkspaceReconciler` accepts injected `claim`, owner-scoped `sync`, and `settle` callbacks. It has no constructor timer, polls three rows per run by default, and starts an unref'd 30-second timeout only after `start()`.

The SQLite bridge additively migrates `settled`, `last_polled_at`, and `lease_until`. Claims run inside `BEGIN IMMEDIATE`, return only `{ projectId, jobId, clientId }`, select oldest eligible records, enforce a 30-second minimum poll interval, and lease for 120 seconds. Settlement requires the full owner/project/job key. The bridge performs no provider operation. The reconciler settles only explicit terminal `dispatch.state` values when both `projectionPending` and `resultsUnavailable` are explicitly `false`; all other outcomes remain available for a later poll. Result counters expose no provider error strings or prompt data.

Root should wire the sync callback to the existing `AgentWorkspaceService.sync(projectId, jobId, clientId)` so current membership is rechecked and projections can report `projectionPending`. No new HTTP, MCP, server, proxy, or UI route is included. No `job_submit`, model invocation, retry, or automatic reassignment is added.

Focused tests use a temporary `StateStore` and real local SQLite/Python CLI calls for lease persistence, owner scoping, and settlement, plus injected sync callbacks for terminal and uncertain cases, overlap, and stop behavior. Run `npm run build` and `node --test test/workspace-reconciler.test.mjs`.
