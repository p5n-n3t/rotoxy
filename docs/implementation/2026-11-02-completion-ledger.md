# Completion ledger — 2026-11-02

Current contract: [completion contract](../design/2026-11-02-completion-contract.md).
Keep this ledger current; a source commit is not a deployed milestone.

## Current checkpoint

- Operator approved implementation, then asked to finish Astra-level decisions and
  stop for a switch to Sol medium. Do not continue routine parent work past that stop.
- Architecture is recorded; no paid test, new Claude worker, deployment or production
  data migration has been performed in this phase.
- Native delegate `planning_audit` (Luna) owns only gate-1 config/doctor/resource-path/
  health code and focused tests. Parent owns contract/ledger and integration review.
- Preserve three untracked October 22 operator handoff/planning files.
- Source baseline: `1081f424`; deployed runtime last observed: `1c2c7e99`.
- Existing mixed Cloudflare failure remains a failed acceptance test, not a retry target.

## Assignments and exit evidence

| ID | Owner / scope | Dependencies | Status | Required evidence |
| --- | --- | --- | --- | --- |
| A01 | Parent: architecture and recovery contracts | none | Decisions recorded | Contract reconciles audit with approved requirements |
| C01 | Luna: optional upstream, canonical resource config, truthful health | A01 | In progress | Focused tests + build; no weaker private-file checks |
| C02 | Next implementation lead: retirement manifest/migration and active removal | C01 | Pending | Exact preview, private backup, mixed-job isolation and crash recovery tests |
| C03 | CLI worker: shared diagnostics, human output, endpoint command | C01, E01 | Pending | Exit-code/JSON contract tests and readable installed CLI output |
| E01 | Provider worker: capability-backed endpoint directory | C01 | Pending | Scoped discovery and API isolation; no hypothetical working routes |
| E02 | Provider worker: Nebius encrypted onboarding and model choices | E01 | Pending | Real metadata + bounded inference, separate API/job selection |
| E03 | Provider worker: Cloudflare receipt/cancellation and canary diagnosis | C01 | Pending | Missing-marker/truncation/abort tests; new live job only |
| W01 | Agent worker: Codex execution and server approval transport | A01, C01 | Pending | Thread/turn receipts, approvals, cancel/restart, origin protection |
| W02 | Agent worker: Claude execution and owned-process reconciliation | A01, C01 | Pending | Bedrock task artifact, session/approval/error/recovery evidence |
| O01 | Oracle worker: shared capacity broker, catalogs, enrollment | A01 | Pending | Direct + ROTOXY concurrency isolation; added host without code change |
| O02 | Oracle worker: even/adaptive batches and model policy | O01 | Pending | Ordered chunk artifacts, model eligibility, fairness, no duplicate work |
| S01 | Search worker: guarded crawl/Markdown/schema extraction | O01 | Pending | DNS/redirect/egress, limits, cancel, provenance and research tests |
| R01 | Routing lead: validated objective planning and eligible-resource scheduling | W01,W02,O02,E02,E03 | Pending | Native-account protection, pins, budgets and mixed DAG proof |
| U01 | UI worker: six destinations, compact profiles/models, state explanations | C01,E01 | Pending | Built-in browser desktop/mobile/keyboard, all routes, no blank errors |
| U02 | UI worker: jobs, approvals, real analytics and durable inbox | R01,U01 | Pending | Source/event matching and reconnect without duplicate events |
| D01 | Docs worker: guide/skills/examples + removal of stale product descriptions | C02,E01,R01,U01 | Pending | MCP onboarding from another authorized client/project |
| V01 | Integration lead: full release verification and rollback | all required gates | Pending | Mixed execution, failures/restart, CI, installed CLI/browser, running SHA |

Assignments require explicit file ownership before dispatch. At most two native
agents including parent. Do not assign more workers merely to occupy slots.

## Verification budget

New phase allowance: $5 total estimated paid-provider verification; $0 newly
dispatched as of this checkpoint. Before dispatch, reserve a conservative estimate,
record operation/provider/model and stop conditions, then reconcile reported usage.
Unknown pricing or an unbounded call does not consume an assumed zero budget.
Subscription quotas and Oracle CPU work are recorded separately. Development-agent
spending is not silently charged to this verification allowance.

## Next action after model switch

Use Sol medium. Retrieve C01 result, inspect its narrow diff and tests, then complete
the C01 review. Begin C02/E01 with separate file ownership; keep runtime activation
gated by build/CI and rollback. Implement the remaining gates continuously, update
evidence here, and do not reconstruct earlier audits from scratch.
