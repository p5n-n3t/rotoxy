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
| provisioner-module | LightSprint, reported model pending | New isolated provisioning coordinator and tests | Dispatched; `rotoxy-provisioning-module-20261022` |
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

Runtime integration tests: 7 passed. Access/API/validation checks: 16 passed. Full Node suite: 492 passed, zero failures. Python job suite with the recovery patch: 35 passed.
All 12 enabled LightSprint accounts passed a fresh authenticated tools/list probe; cached cooldowns were preserved because authentication does not prove rate-limit clearance or quota.

Next: review Claude changes, run Python regression suite; complete build and
runtime tests; implement durable provisioning against discovered contracts;
review coherent release bundle before any production restart. No production
deployment or account/session configuration mutation has occurred.
