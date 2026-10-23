# LightSprint API compatibility checkpoint — 2026-10-23

## Verified evidence

The current exposed MCP description documents `/api/workspaces/{workspaceId}/`
scoping. It lists task creation, `POST .../agent-sessions` launch with a task
reference and engine selector, session status/transcript, native turn cancellation
at `.../actions/cancel`, and session stop by PATCH with `status: stopped`.
This tool description does not establish exact model or reasoning selection.
Never substitute a guessed per-task launch endpoint.

A scoped GET stacks request was denied by ROTOXY's existing endpoint allowlist.
A separate credential-pinned legacy GET session status on a registered account
succeeded. The observation establishes a policy/adapter compatibility gap, not
failure of every existing route. No launch or model inference was attempted.

A bounded Claude Haiku source audit confirmed hardcoded legacy routes in
`src/providers/lightsprint-jobs.ts`. Its migration suggestions are advisory; do
not infer authorization or exact launch schemas from the audit itself.

## Next adapter work

1. Read each account's authenticated MCP catalog and retain verified workspace
   scope. A tool description obtained through one pooled account is not a
   workspace grant for other accounts.
2. Implement a reviewed workspace-scoped contract alongside existing verified
   legacy routes. Missing ROTOXY-specific contract markers mean evidence is
   missing, not that the upstream feature is unsupported.
3. Add narrow policy rules only after validating per-account/workspace ownership.
   Maintain session affinity, explicit no-auto-merge launch behavior, pause
   enforcement and supported cancellation paths.
4. Test both route families, wrong-workspace rejection, model pin limitations,
   cancellation while dispatch is paused, and ambiguous launch reconciliation.
   Never retry a possibly accepted launch using a different route family.

Quota snapshots, active sessions, local concurrency ceilings and provider slot
entitlements are separate measurements. Neither this API description nor a
successful status read verifies twelve executing slots per account.

## Route preparation — 2026-10-24

`LightSprintWorkspaceContract` now builds immutable account/workspace-bound route
descriptors for task and session operations, with path-fragment validation. Every
session route retains the workspace prefix, including cancellation and stop.
This pure helper performs no I/O and is not yet connected to live provisioning.
Its account comparison validates local binding, not upstream membership. Session
listing is not proof of idempotency or exact launch reconciliation.

Claude Code produced the initial implementation; integration review corrected
legacy session paths and an unsupported correlation claim. The 22 focused tests
pass. Next: obtain account-pinned workspace evidence and integrate the narrow
transport/policy path without weakening ambiguous-operation safeguards.
