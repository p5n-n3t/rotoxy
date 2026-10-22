# Shared orchestration upgrade — 2026-10-22

User approved implementation after the read-only audit. Branch:
`codex/recovery-provisioning-20261022`, based on `065a2d5`.

## Required behavior

- Shared fleet across trusted clients and repository folders. Preserve internal
  workspace ID `token2oauth`; user-facing identity is ROTOXY.
- All trusted agents may read shared job content. Mutation permissions remain separate.
- Persist execution intent before dispatch. An uncertain operation retains its
  account/session/attempt/generation and reservations. Never replay on timeout.
- Hold uncertain tasks and dependents; continue independent approved work.
- Do not automatically revive historical held or cancelled assignments.
- Unknown quota may receive explicitly bounded work. No purchases/top-ups.
- Provision workers only through demonstrated provider contracts; exact model
  and effort pins must fail visibly when unsupported.
- Ollama decision-model supervision is deferred.

## Worker ledger

| Assignment | Executor | Ownership | State |
|---|---|---|---|
| RX-RECOVERY-20261022 | Local Claude Sonnet, high effort, $5 CLI ceiling | `supervisor/snooze/jobs.py`, recovery tests | Recovery patch completed and reviewed; 35 Python tests passed. Follow-up installed-fix integration active |
| recovery-review | LightSprint, reported `gpt-6-luna` | Read-only scheduler review | Completed; result retrieved |
| provisioning-contract | LightSprint | Read-only provisioning contract audit | Completed on replacement job after original queued task cancellation verified |
| provisioner-module | LightSprint, reported model pending | New isolated provisioning coordinator and tests | Upstream completed; local commit c7161358550d94091acb86f7efa259cae6cccc05 reported with 9 focused tests. Artifact not yet locally retrieved; do not claim integrated. |
| Runtime reconciliation | Local coordinating agent | runtime configuration/types/tests | In progress |

Cloud job ID: `rotoxy-provisioning-audit-20261022`. Original assignment is now cancelled. Its unstarted provisioning task had no attempt, dispatch timestamp or session; cancellation was verified before replacement `rotoxy-provisioning-contract-20261022-b`. Do not revive the original. The completed review emphasizes reservation retention, scope locks,
generation fencing, and explicit treatment of historical holds.

## Evidence and current limits

Installed configuration: four bound accounts, seven sessions, maxWorkers seven,
automatic fresh operations disabled. Credential registry: twelve enabled
LightSprint accounts and one disabled. Those counts do not prove quota or slots.

Live upstream `tools/list` advertises workspace-scoped task creation and
`POST .../agent-sessions`. Its documented creation body does not expose an exact
model/effort selector. The existing adapter uses older non-workspace routes.
Do not invent a model field or treat launch HTTP success as execution proof.

Installed runtime has fixes absent from source: authenticated MCP membership,
session-based worker-loop concurrency and a larger parser ceiling. Source also
registers localCapacity=1 despite multiple sessions per account.

The current Python scheduler has a 32-worker software ceiling. Raising only the
TypeScript parser beyond this would be misleading; higher verified scale needs
an end-to-end limit change and overlap tests.

## Verification / next actions

Dependencies restored using the lockfile (`npm ci --ignore-scripts`). First build
identified missing SDK dependencies and the shared-membership type mismatch.
An initial test run read stale emitted JS; rebuild before rerunning tests.

Runtime integration tests: 7 passed. Access/API/validation checks: 16 passed. Full Node suite: 492 passed, zero failures. Python job suite after integration: 38 passed. Full Python suite: 464 passed, zero failures.
All 12 enabled LightSprint accounts passed a fresh authenticated tools/list probe; cached cooldowns were preserved because authentication does not prove rate-limit clearance or quota.

Next: review Claude changes, run Python regression suite; complete build and
runtime tests; implement durable provisioning against discovered contracts;
review coherent release bundle before any production restart. No production
deployment or account/session configuration mutation has occurred.

## Collection recovery discovered during this work

The cloud module task hit the existing 20-observation cutoff while its provider
was still running. The original session later completed successfully. Read-only
transcript inspection recovered its report without resending instructions. Its
patch is only in the remote sandbox; the reported branch was not pushed. Native
guidance export was denied by current tool policy (`policy_paid_block`) before
any send. No override or duplicate implementation was launched.

An explicit read-only observation reconciliation command is being implemented
by local Claude. It must preserve original attempt/generation/session and may
never requeue the chat operation. After review/tests and a consistent database
backup, use it on this exact blocked task to collect completion and release the
original reservation. Then request existing-artifact export through a new
durable task, not by redoing the implementation.

A new optional task `observationTimeoutSeconds` is being added (60 seconds to
seven days, default six hours). It controls monitoring only; expiry does not
cancel the provider or permit redispatch. TypeScript validation tests pass;
Python deadline enforcement is not yet integrated. Do not deploy this partial
API change before both sides and regression tests are complete.

## Resume checkpoint — original execution recovered

After the user's account switch, verified the original task was still held at
revision 2. Took a consistent private SQLite backup at
`~/.local/state/rotoxy/backups/reconcile-20261022T125026Z/snooze.sqlite3`.
Ran the reviewed local reconciliation CLI with revision 2. It queued one
observation and retained the original attempt, generation, account and session.
The installed observer collected the completed response: assignment complete at
revision 4, reservation released. No chat or launch was replayed.

A separate bounded export assignment retrieved the already-produced artifact.
Its normal branch push was independently verified by git fetch. Integrated
`c7161358550d94091acb86f7efa259cae6cccc05` as `303d0c4` (two new files only).
The coordinator is injected infrastructure, not automatic production provisioning.
Its 9 focused tests passed after a fresh TypeScript build.

Final recovery review by local Claude Sonnet found no blocking ownership,
reservation, or redispatch defects. Retained unconditional revision increments:
each reconciliation mutates state and must fence concurrent callers. A real
UTF-8 instruction-size validation inconsistency is assigned for correction.

Active assignments:
- Local Claude RX-RECONCILE-API: owner/revision-bound observation-only MCP/bridge
  control, tests, UTF-8 instruction validation. No production access.
- LightSprint `rotoxy-provision-ledger-20261022-b`: durable SQLite coordinator
  ledger and tests, account l2thepete. Original account-ngilfordz assignment was
  cancelled with no attempt/dispatch before replacement; existing unresolved
  session reservations were not cleared.

Current full Python run: 480 tests, 3 Oracle fleet-config CLI subprocess timeouts,
477 passed. Focused rerun pending. Full Node run pending. Earlier 54 focused
recovery tests and 11 focused Node tests passed. No service deployment/restart.

## Verified integration checkpoint

- Recovery committed as `fc5434c`; original-session collection proved live.
- Coordinator imported as `303d0c4`; pin-evidence correction committed `a55a4ee`.
- Ledger imported from verified cloud commit `18dcdc3fbe080416bd8927531a44dc9326ed5f76`
  as `d3be907`. Only the two owned new files were imported.
- Integration additionally retains mismatched-pin evidence in SQLite and prevents
  replacing a previously known session binding. Separate-process reservation
  race and coordinator/restart tests pass.
- Authenticated MCP/bridge `reconcile_task` is implemented with owner/client,
  project and caller-supplied revision checks. Schema rejects account/session
  overrides and unsafe revisions. UTF-8 instruction bounds now match Python.
- Latest fresh build and focused Node run: 31 passed, zero failures.
- Local Claude bridge run: 10 passed. Full Node baseline after recovery: 493
  passed. Full Python: 480 run, three Oracle CLI timeout errors; all four tests in
  that affected file passed on isolated rerun. No assertion failure was observed.
- Both artifact-export and replacement-ledger cloud jobs are complete, results
  retrieved, reservations released. Account ngilfordz's unstarted ledger job
  remains cancelled; historical reservations were preserved.
- Provisioning remains internal until a discovered provider adapter, explicit
  admission and runtime wiring are verified. No automatic session creation or
  claim of twelve slots/account has been enabled. No production deployment.

## Account-contract evidence and final safety follow-ups

Read-only discovery cloud task completed and its commit `97d3030` was independently
fetched and integrated as `972d11b`. Fresh native MCP catalogs revealed the live
workspace-prefix/ellipsis format; added that observed format and regression
coverage. Build and 28 discovery/existing-adapter tests pass.

All twelve enabled accounts passed fresh independent catalog probes, recognized
as workspace-task contracts. All twelve returned repository lists containing an
exact ROTOXY repository identifier. Disabled Joey was left untouched. No credits,
slot entitlement or exact model/effort selectors were inferred. Private evidence
and account matrix are under `~/.local/state/rotoxy/preflight/`.

Bounded local Opus review found no blocking issue in duplicate launch, retained
reservation, session identity, pin evidence, ownership or revision fencing. Its
optional-repository blocked-slot observation prompted a follow-up: retained
post-dispatch blocked tasks now hold session/account/scope and global/job/project
capacity; pre-dispatch blocks do not. Read-only reconciliation can still run at
capacity. That follow-up passed 61 Python job tests.

Current final review correction in progress: keep enabled/authorized original
session observations available when dispatch quota is depleted or health is
transiently degraded. Mutation eligibility remains unchanged. This is not yet
verified or deployed; wait for the assigned Claude tests before packaging.
Draft integration PR: https://github.com/p5n-n3t/rotoxy/pull/14

## Final recovery verification

Final focused verification passed: fresh TypeScript build; 87 Node tests across
worker/runtime/validation/provisioning/discovery/adapters; 65 Python job tests;
10 Python bridge tests. The last Sonnet implementation reached its CLI budget
before verification; the integration lead reviewed its partial changes, completed
regressions and ran these final checks. Do not treat that worker's budget stop as
an independently completed verification receipt.

Additional verified fixes: read-only observation is independent of quota and
transient dispatch health, while disabled/revoked accounts remain blocked;
expired transient cooldowns restore supervisor eligibility without clearing
separate auth or quota blocks; an idle session with a dead relay or pending
approval never receives a new job instruction. Cached health was not manually
reset and provider credits were not inferred.

Fresh-session dispatch remains disabled. Production deployment is being prepared
as a full versioned bundle for the gateway and its private supervisor bridge,
with rollback and preserved state; no deployment is yet claimed by this entry.
