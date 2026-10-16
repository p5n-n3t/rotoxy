# Agent Workspace AW1 engine handoff

This branch adds a private SQLite engine for the project-scoped Agent Workspace
contract. The executable is `python -m snooze.agent_workspace --db ABSOLUTE_PATH`;
it reads one bounded JSON object from stdin and writes exactly one JSON result
to stdout. Supported commands are `snapshot` and `update`. Node remains the
authorization boundary: pass only a trusted actor (`client:<verified OAuth
client_id>` or `admin:local`) and an already-authorized project ID. The Python
process does not derive identity, authorize OAuth scopes, send provider
requests, launch jobs, fetch repositories, merge code, or approve provider
actions.

Each project has one optimistic workspace revision. `update` runs under
`BEGIN IMMEDIATE`; the idempotency receipt is checked before revision
comparison, and conflicting key reuse fails. Tasks, dependencies, claims,
messages and per-actor inbox receipts, artifacts, review decisions, and
metadata-only event cursors survive process restarts. Task creation accepts
only existing same-project dependencies (up to 16), which makes cycles
unrepresentable; claims atomically require every dependency complete. Review
approval requires an independent participant, except the explicitly trusted
admin actor. Broadcast/direct message visibility is limited to sender,
recipient, admin, or broadcast participants. Unknown projects have an empty
snapshot and cannot read another project's rows.

The schema accepts only the AW1 action DTO fields and bounds IDs, text,
descriptions, input bytes, page sizes, and output bytes. Events retain metadata
only; task-update notes are validated/redacted but not persisted as event
bodies. Explicit message and artifact text are stripped of control characters
and common credential patterns. The database directory/file are set to modes
0700/0600; symlinks are refused. Keep the DB path in Node's private state area.

## Root integration

Add a `SupervisorBackend` adapter that invokes this module without a shell,
passes JSON over stdin, enforces a child timeout, and treats nonzero exit or
malformed stdout as a fixed unavailable error. Do not let callers set `actor`
or `projectId` in the action body: derive actor from verified claims/admin
session and authorize the project before invoking the CLI. Mount the agreed
admin endpoints and MCP `workspace_snapshot` (`jobs:read`) /
`workspace_update` (`jobs:write`) in the Node owner branch. Keep MCP scope
checks and admin CSRF/session checks there. `projects()` should continue to
come from the existing backend `listProjects`; the engine does not invent a
project catalog. Snapshot records are user-authored workspace data, not
provider-verified results; account/model labels are claims only. No automatic
completion, external approval, GitHub mutation, or provider interaction is
implemented here.

## Focused evidence

`PYTHONPATH=supervisor python -m unittest supervisor.tests.test_agent_workspace`
exercises independent CLI processes against temporary databases, including
restart durability, idempotency before revision checks, revision conflicts,
membership and assignee restrictions, dependency gating, self-review refusal,
inbox receipts, project isolation, secret redaction, and private file modes.
