# ROTOXY Fleet quickstart for MCP clients

ROTOXY exposes one shared provider Fleet per configured gateway. Clients on
different folders or machines use that Fleet through their own OAuth identity;
projects are authorization and job-context namespaces, not separate provider
pools. A folder name, repository name, or guessed ID grants no access.

## Connect and discover

Connect to the gateway's Streamable HTTP MCP endpoint (`/mcp`) using its OAuth
flow. Request only the scopes needed: `mcp` for ordinary proxied tools,
`jobs:read` for Fleet/job discovery and results, and `jobs:write` for job
submission and controls. Consent does not imply project membership. Call
`tools/list`, then `rotoxy_guide` with `topic: "start"` or `"dispatch"`.

Call `workspace_projects` with `{}` and use a returned `projectId` exactly as
opaque context. An empty list means an administrator must grant this client
access. Then call `job_workers` with `{ "projectId": "<returned-id>" }` and
choose only account IDs marked `dispatchBound` and workers marked `eligible`.
Capacity and provider-slot entitlement can be unknown; a registered or idle
session is not proof of usable quota or completion.

ROTOXY sends provider requests through account-pinned LightSprint MCP
connections. Its scoped transport checks each credential's own catalog and
workspace before using workspace routes; discovery from one account does not
authorize another account. For `job_submit`, the registered session supplies
the account, workspace, provider, and reported model context. Do not send a
session ID or choose a provider/model in the job arguments. See the
[LightSprint compatibility notes](lightsprint-api-compatibility.md) for the
verified route families and their limits.

## Submit one bounded existing-session DAG

Submit the whole caller-authored DAG in one `job_submit` call. Use explicit
`path:` or `record:` scope keys, list prerequisites in `dependsOn`, and keep
instructions and output limits small. The schema allows 1–100 tasks, 1–50
eligible accounts, instructions up to 16 KiB per task, and text output up to
32 KiB (also subject to the operator's lower local cap). Each task must use
`execution: {"mode":"existing-session"}`. Reuse one stable `jobId` and one
stable `idempotencyKey` for the same logical submission; never mint a new key
to retry a timeout.

Replace the two example IDs below with the exact IDs returned to this client
by `workspace_projects` and `job_workers`. This one-task example assumes the
configured output cap is at least 1024 bytes.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "job_submit",
    "arguments": {
      "schemaVersion": 1,
      "jobId": "quickstart-readme-check-20261024",
      "idempotencyKey": "quickstart-readme-check-20261024-v1",
      "projectId": "replace-with-project-id",
      "eligibleAccountIds": ["replace-with-eligible-account-id"],
      "tasks": [{
        "taskId": "check-readme",
        "dependsOn": [],
        "scopeKeys": ["path:README.md"],
        "instructions": "Check README.md for spelling errors. Return a brief finding; make no edits.",
        "execution": { "mode": "existing-session" },
        "output": {
          "kind": "text",
          "maxBytes": 1024,
          "format": "plain-text",
          "expectedMarker": "README_CHECK_DONE"
        }
      }]
    }
  }
}
```

For collaborator-visible task metadata, use `workspace_dispatch` if it is
advertised; it explicitly publishes the assignment. A direct `job_submit` is
owner-scoped. Neither tool automatically decomposes work: callers author the
DAG and own its path/record scopes.

## Monitor, control, and prove completion

Use `job_status` (`projectId`, `jobId`) after submission, then `job_results`
(`projectId`, `jobId`, optionally `taskId`). A task is complete only when the
durable status is complete and its bounded result is present with the exact
expected marker; an idle session alone is not proof. Keep the provider-reported
model separate from any model expectation.

`job_control` supports project-scoped `pause_dispatch`, `resume_dispatch`, and
`emergency_stop`, plus job cancellation and task reconciliation. A pause stops
new dispatch; it does not terminate work already sent to a provider. Cancellation
of a ROTOXY job also does not prove that the upstream session stopped. Reconcile
against the original session when offered rather than submitting duplicate work.

When strict credit admission is enabled, the scheduler reserves credit before
sending a paid session message. A credit denial holds/blocks dispatch; do not
bypass it by switching accounts or creating a new job key. Any locally approved
unknown-credit exception is a separate operator-only workflow, not an MCP
permission. Account and session affinity are fixed per task after reservation;
the scheduler prevents concurrent reuse of a registered session. Scheduling
profiles cap local concurrency (economy 1, balanced 3, throughput 32, or custom
1–32), further limited by operator controls; these are not provider slot counts.

Read `job_inbox` for incidents. Treat `ACP_RELAY_DIED` as a failure even if a
session also reports idle. Acknowledge an event only after recording its
disposition; acknowledgement does not repair the incident. After a timeout or
lost mutation response, read `job_status` and reconcile the original job. Never
blindly replay an ambiguous call.

## Current boundaries

The durable `job_submit` path rejects fresh launches; it supports registered
existing sessions and bounded text results only. Automatic decomposition,
structured output, provider/model/effort selection, guaranteed native message
delivery, dormant-session wakeup, and verified provider slot counts are not
promised. Use only capabilities actually returned by `tools/list` and their
current schemas.
