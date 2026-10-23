# Recovering an uncertain remote execution

A worker being idle does not prove successful completion. Inspect the provider's
execution error, the original session, and the expected output receipt. A relay
failure such as `ACP_RELAY_DIED` remains a failure even if the session is idle.

## Observation versus redispatch

When a response or completion is uncertain, keep its account, session, attempt,
generation and reservations. Do not resend the instruction, change accounts, or
clear ownership merely because polling ended. Independent approved tasks may
continue; dependent tasks wait for verified output.

Each task may specify `observationTimeoutSeconds` from 60 to 604800 seconds.
The default is six hours from original dispatch. This is a monitoring deadline,
not a remote execution timeout or permission to retry. A valid completed receipt
can be collected after that deadline. Pending work after expiry needs explicit
reconciliation; it does not get a new launch or a fresh deadline automatically.

## Local operator recovery

Use a current source bundle containing `snooze.reconcile_job`. Before mutating the
ledger, take a consistent SQLite backup using SQLite's backup API. Preserve
private directory and file permissions. Copying an actively written database
without its WAL is not a consistent backup.

Read the assignment's current revision and confirm the original task is blocked
or ambiguous. The assignment must still be approved and queued or held. Then:

```sh
PYTHONPATH=supervisor python3 -m snooze.reconcile_job \
  --state-dir /path/to/existing/supervisor-state \
  --assignment-id JOB_ID \
  --task-id TASK_ID \
  --expected-revision REVISION
```

The directory must contain the existing `snooze.sqlite3` ledger. The command
refuses missing/incompatible databases. Local filesystem authority permits this
operator action; it is not an alternate MCP credential or remote login method.

The action queues one observation of the original execution. It checks the
original dispatch binding and rejects duplicate pending observations, stale
revisions, cancelled/completed assignments, and tasks without retained execution
ownership. Every accepted reconciliation increments assignment revision. Refresh
that revision before requesting another mutation, including another task in the
same assignment.

Read `job_status` and `job_results` afterwards. Completion requires a valid output
receipt, not just acceptance of the reconciliation request. Observation may still
return blocked or uncertain if provider evidence is missing. Leave the original
ownership intact in that case and investigate; do not loop on reconciliation.

## Verified recovery example

On 2026-10-22, `rotoxy-provisioning-module-20261022/provisioner-module` had been
held after an obsolete fixed poll-count limit while LightSprint continued working.
After a private SQLite backup, reconciliation at revision 2 queued observation
only. The existing observer collected the completed response, advanced the job to
revision 4, and released its reservation. Its original attempt, account, session
and generation were retained. A separately bounded artifact-export job then
retrieved the existing code; implementation was not repeated.

The revised elapsed-time monitoring and operator CLI are included in the
2026-10-23 immutable runtime release `89e6b90`. The example above remains
evidence of observation-only recovery of that original execution.

## Authenticated agent control (new source bundle)

When the connected gateway advertises the action, an owner with `jobs:write`
can call `job_control` with `action: "reconcile_task"`, the discovered `projectId`,
original `jobId` and `taskId`, and the current positive integer
`expectedRevision`. Ownership and project checks occur before the private bridge
mutation. A stale revision is rejected rather than silently refreshed. This is
the same observation-only operation as the local operator CLI. Discover the
installed schema before use. The 2026-10-23 runtime release includes this
action; client discovery and authorization must still succeed independently.

## Internal provisioning components

The provisioning coordinator and SQLite ledger are isolated source components;
they do not yet enable automatic account enrollment or session creation. The
ledger preserves uncertain reservations across restart and prevents changing a
known session binding. Exact requested model/effort pins require matching
provider evidence before success is reported. Missing/mismatched evidence keeps
the original session under reconciliation without relaunching it.

The SQLite implementation uses Node's built-in `node:sqlite`. Node 22.13.0 or
23.4.0 first exposes that module without an experimental command-line flag;
validate the supported Node runtime before wiring this component into a release.
See the [official Node SQLite history](https://nodejs.org/api/sqlite.html).
