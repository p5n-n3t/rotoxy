# Completion ledger — 2026-11-02

Current contract: [completion contract](../design/2026-11-02-completion-contract.md).
Keep this ledger current; a source commit is not a deployed milestone.

## Current checkpoint

- Operator resumed implementation on Sol after the architectural pass.
- Source checkpoint `9f7d26e`: config/doctor/health corrections, shared Oracle-aware
  search configuration validation and UI, Cloudflare receipt/cancellation fixes,
  and clean forwarding of CLI diagnostic failures.
- No paid test, new Claude worker, deployment or production data migration occurred.
- C01 build +29 focused tests; Oracle-aware resource regression 2/2;
  E03 focused tests 10/10; control wrapper tests 11/11. Full Node suite passed 682/682
  at `/tmp/rotoxy-completion-node-tests.log`; durable jobs passed 90/90.
  C03 subsequent build and CLI-focused tests passed 2/2.
- C03 readable CLI subset is locally verified. Endpoint command remains pending E01.
- Preserve three untracked October 22 operator handoff/planning files.
- Source baseline: `1081f424`; deployed runtime last observed: `1c2c7e99`.
- Existing mixed Cloudflare failure remains a failed acceptance test, not a retry target.

## Assignments and exit evidence

| ID | Owner / scope | Dependencies | Status | Required evidence |
| --- | --- | --- | --- | --- |
| A01 | Parent: architecture and recovery contracts | none | Decisions recorded | Contract reconciles audit with approved requirements |
| C01 | Luna/parent: optional upstream, canonical resource config, truthful health | A01 | Locally verified; not deployed | Focused tests + build; no weaker private-file checks |
| C02 | Luna: exact-ID preview; active retirement fence | C01 | Preview tested; apply unsupported; fence in progress | Exact preview, private backup, mixed-job isolation and crash recovery tests |
| C03 | Luna: shared diagnostics, human output; endpoint command still awaits E01 | C01, E01 | Readable views verified; endpoints pending | Exit-code/JSON contract tests and readable installed CLI output |
| E01 | Parent: shared authenticated directory, dashboard and CLI | C01 | Local implementation/test in progress; provider MCP scopes pending | Scoped discovery and API isolation; no hypothetical working routes |
| E02 | Provider worker: Nebius encrypted onboarding and model choices | E01 | Pending | Real metadata + bounded inference, separate API/job selection |
| E03 | Luna: Cloudflare receipt/cancellation; live canary diagnosis remains | C01 | Local receipt tests passed; live pending | Missing-marker/truncation/abort tests; new live job only |
| W01 | Luna: Codex server approval transport; durable execution still pending | A01, C01 | Transport groundwork under verification | Thread/turn receipts, approvals, cancel/restart, origin protection |
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

## Exact next action

C01/E03/C03 subset reviewed and locally tested. Continue C02/E01 with explicit
ownership: retirement preview and capability-backed endpoint directory, then remaining
worker execution/routing/UI gates. Running gateway and monitor are unchanged. No
release activation until release/rollback and browser acceptance checks. Never kill
the active monitor/gateway as stale workers.

## Resumed endpoint/retirement checkpoint

Operator resumed on Sol after switching accounts. No Astra needed for current work.
New endpoint directory uses existing encrypted provider stores; `/admin/endpoints`
and `/admin/api/v1/endpoints` require admin authentication; `rotoxy endpoints`
uses the same function. Status is local metadata, not authentication/inference
verification. Custom provider paths are derived from saved IDs. Public generic
`/providers` remains a static protocol directory; scoped provider MCP routes remain
pending and must not be claimed complete.

Retirement script is read-only preview. Its `--apply` explicitly refuses because
cross-store dependency classification and journaled restore are not implemented.
No production purge, paid test, runtime deployment or new Claude process occurred.

## Source checkpoint de50128

- E01 shared directory committed/pushed as `389d22a`; focused provider/CLI/directory
  checks passed 13/13, final directory API/CLI parity regression passed 1/1.
- C02 preview committed/pushed in `1f93315` + mixed-sibling correction `de50128`;
  synthetic preview tests passed 3/3. Apply remains explicitly unsupported.
- Active provider retirement fence is currently delegated, uncommitted and under
  focused verification. Retrieve its result before staging those files.
- No new paid calls, runtime purge or deployment. Astra is not needed currently.

## Retirement and Codex transport continuation

- `9e9bc92` commits retired provider execution guards; focused adapter/runtime
  suites passed 46/46, including no Python assignment creation and preserved Oracle
  inference eligibility. Six obsolete session-success tests now assert retirement.
- Parent extended active-view filtering to legacy account counts, inventories,
  probes and tool refresh; local retirement/UI integration passed 15/15.
- Luna implemented Codex transport server-request handling and one-time response
  support; no approval is automatically answered. This is not an executor.
- Final single build succeeded; Codex/retirement tests passed 10/10. The concurrent
  build was stopped by its owner. Host memory/swap pressure slowed verification.
- Runtime remains unchanged; no native subscription worker launched after the
  operator account switch, no paid test, purge or deployment.
