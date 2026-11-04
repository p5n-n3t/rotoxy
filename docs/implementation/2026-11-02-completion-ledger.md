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

## Full regression and navigation status

`c2b9aa3` is pushed. Full regression was stopped after workspace execution test
stalled; isolated 75-second run exited 124. This is not a full-suite pass. Luna
is investigating read-only; do not infer retirement caused it without evidence.
Navigation changes and Activity/Settings landing routes are local, parent-wired;
first focused run exposed custom-nav group rendering incompatibility, now fixed.
Final rebuild and focused navigation tests passed 10/10. No deployment.
Workspace execution test is rerunning alone with a 240s outer deadline; no compiler
competition. Its own reconciliation deadline is120s, so prior75s isolation was
insufficient and cannot alone establish a regression.

## Workspace verification result

Standalone workspace execution test passed 2/2 in33s after compiler completion.
Prior75s isolation timeout and full-suite stall under memory pressure are not proof
of a retirement regression. Still require a complete post-retirement full-suite run.
Built-in browser access reports disabled in Work settings; visual acceptance remains
unverified. Navigation source/build/focused tests passed10/10 and is pushed3f0392f.

Luna now owns new `src/providers/claude-code-jobs.ts` and its synthetic tests only;
no paid launch or runtime integration is authorized by that module's existence.
Parent owns Oracle model catalog deduplication and growable host attribution tests.

## Complete run and targeted corrections

Full post-retirement Node run completed691 tests:686 passed,5 failed. Failures
were two navigation expectations and three retired-provider behavior expectations.
Resource map link restored; disclosure assertion limited to task panels; direct
retired MCP operations must fail without network; legacy readiness cannot become
available through credit readings. Affected suites and new Claude executor tests
passed35/35 after build at `/tmp/rotoxy-final-followups.log`.
The last globally green suite was before these retirement/navigation changes.
Do not call the complete suite green until a fresh full pass.

Claude CLI executor groundwork is locally verified with a fake executable: trusted
canonical paths, explicit Bedrock environment, stdin prompt, bounded output/time,
session/resume IDs, cancellation of owned child only and ambiguous post-start
failures. It is not wired into durable job dispatch and has no live-model proof.
Luna now owns Codex explicit profile-pinned turn execution groundwork and synthetic
tests; no native subscription execution is being launched.

## CI restored

GitHub run41429563666 passed for pushed9b7207b, providing complete CI evidence
after the navigation/retirement test corrections. Earlier navigation commits had
failed CI and are superseded. This is not runtime deployment evidence. Codex
profile-pinned turn groundwork remains local under its own focused build/test.

## Codex executor verification

Profile-pinned turn groundwork build and focused tests passed12/12 after final
security review. Installed protocol schema verified resume/turn fields. Resume
checks exact thread ID and pins model/cwd/on-request/read-only; every turn also
pins read-only sandbox with network disabled. No automatic approval or retry.
Origin label is advisory until the server-side broker verifies it; therefore
public/durable dispatch remains disabled. No real subscription task launched.

## Production access repair

Operator reported another chat could discover no workers. Actual liveMCP lacked
inferenceResources because gateway1c2 was never updated. Activated CI-passed03f9986
with private rollback backup, unchanged Funnel and CLI links corrected. LiveMCP
now discovers8 healthy CF resources and eligible Oracle pool. Production proof
rx-desktop-access-20261102-a completed and result retrieved via this MCP caller.
See ../verification/2026-11-02-production-worker-access.md. Source mixedcanary all3
complete (1.590s request overlap). Nebius encrypted onboarding+30-model catalog
passed; no Nebius inference/automatic selection. Two $0.001 conservative CF
verification reservations; no purchases/topups. No historical purge.

Origin broker files now pass four local tests, but remain unwired. Next:
integrate executor modules into durable jobs with
server-resolved origin protection and explicit permissions; do not claim native
subscription worker dispatch ready. Browser visual gate still unavailable.

## Individual pools and task-contract continuation

See `../verification/2026-11-02-pool-scenarios.md` for live catalog/operation
evidence and remaining coverage. Ollama, Cloudflare and Oracle direct catalogs
answer; no direct Claude Code/Codex inference API is advertised. Ollama completed
two classification requests but failed strict raw JSON both times. Official cloud
documentation confirms structured output unsupported; source now rejects those
contracts before spending quota. Oracle canonical credential resolution now matches
the directory when the environment override is absent. Explicit invalid overrides
remain failures. Source requested-model attribution is corrected for inference.

New live Oracle job `rx-oracle-contracts-20261102-a` completed three tasks on ora5,
ora3 and ora6, with 8.840s overlap between independent requests and dependency
ordering preserved. Classification passed exact text; transformation/extraction
repeated markers and failed exact-text validation. Scheduler completion is not
arbitrary artifact validation. No automatic replay or additional paid API call.

Local build plus pool/gateway/origin suites passed9/9; Python durable-job suite
passed90/90. A follow-up build/tests covers the new trusted Claude profile adapter.
That adapter reuses the existing registry and process executor; it is not yet a
durable public dispatch path. Latest source changes are not deployed. Next is
durable executor integration and origin-binding routes, then full mixed-pool,
restart/worker-loss and browser acceptance; never mark the overall plan finished
from these focused tests alone.

## Worker-feedback delivery upgrade

The operator correctly identified that inbox persistence alone does not tell a
dormant originating agent when work changes. Live Oracle completion events were
retrieved from the inbox, but the legacy monitor has no Oracle event-to-native
delivery path. No automatic resumption is claimed for that monitor.

Official MCP Events documentation now describes an event-driven ChatGPT Work/Cloud
plugin path. This supersedes blanket statements that ChatGPT cannot respond to
MCP-originated events. Added opt-in source support for `events/list`, subscribe and
unsubscribe, encrypted subscriptions, public pinned callbacks, signed verification
and delivery, durable outbox/receipts, secret rotation, access rechecks and epoch
revocation. Added read-scoped `job_wait` for active callers, with slow-sibling and
guidance handling. Updated portable MCP guide and optional skill together.

TypeScript build passed. Integrated focused suite passed38/38; subsequently added
real-disk restart case passed with the entire event suite10/10. No live callback
or resulting ChatGPT turn has been observed. Environment opt-in is currently off
on the live03f9986 gateway. `6c95d76` is pushed and full CI41439361329 passed.
Feedback commit `bb4ad7b` passed full CI41443919065 and is activated. Public
healthz is healthy; native MCP job_status still works and now reports the real
requested inference model. Installed short-lived local test JWT proved events
advertisement/catalog, job_wait and private callback rejection; zero subscriptions
were registered. It is not proof of a real ChatGPT subscription or response.
Rollback backup: `/home/jq/.local/state/rotoxy/releases/rollback-bb4ad7b-1793622313`.
No paid calls, old monitor restart or production data purge occurred.

Follow-up build and16 focused tests passed for fast-job subscription catch-up
and post-dispatch Oracle timeout ambiguity. Do not replay a lost synchronous
response: the main DAG does not yet use the separate durable Oracle queue's
stable ID/status/result mapping. That bridge also requires queue finish evidence
and host-binding reconciliation. Actual supported-client subscription and
response remain the feedback acceptance gate. Details: `../architecture/worker-feedback.md`.

## Activated feedback follow-up

Running code/CLI: `73cf0d021ac3d8d8aae45ab2eb5c496889665262`.
Full CI41445419922 passed; targeted follow-up16/16 passed. Rollback backup:
`/home/jq/.local/state/rotoxy/releases/rollback-73cf0d0-1793622858`.
No active operations/tasks existed at restart. Public healthz and the existing
native MCP guide work after activation; guide advertises bounded waiting, MCP
Events and slow-Oracle uncertainty. No real event subscription has been created.
The operator has been asked to perform the supported Work/Cloud subscription
step for the completed Oracle test job; do not fabricate its callback or reaction.

Exact next actions: verify that client subscription/delivery/reaction; then
integrate DAG Oracle work with stable-ID durable queue and terminal evidence,
preserving host eligibility. Codex/Claude native resume wiring and the remaining
completion gates above are still open. Do not implement another event engine.

## Claude Code and direct Bedrock continuation

User approved both paths under the existing AWS identity. New source connects the
existing trusted runner/executor to the workspace attempt table through an additive
owner/profile-bound Python ledger bridge. It exposes claude_workers, submit/status
and owned cancellation, plus agentResources in job_workers. Shared AWS source is
an owner-private settings reference; no credential is copied into ROTOXY state.
Direct Messages and model-list routes use the three selected operator model IDs.
The endpoint directory includes the Anthropic Messages base URL.

Actual source gateway task claude-worker-bedrock-20261102-a completed through MCP
and real CLI, exact marker and review artifact retrieved. Haiku requested/reported
IDs match; CLI cost $0.001626. Direct Haiku SDK and gateway Messages requests also
passed exact output checks. Opus/Sonnet are permitted, not newly execution-tested.
No provider call was replayed. Owner-only source settings permissions were fixed.
Private pre-migration backup: ~/.config/rotoxy/backups/claude-durable-1793646514.

Worker policy is read-only tools, one process, explicit model, bounded timeout and
$0.25 CLI budget (not a guaranteed billing limit). Results up to16KiB are retained;
workspace artifacts preview them, not silently replace the full result. Native
Claude attempts remain separate from the main Oracle/CF DAG. MCP Events can
observe claude:<taskId>; a real ChatGPT reaction still needs client verification.

Focused integrated Node subset49/49 passed before the final cancellation/result
retention additions. Python bridge+legacy15/15 and result-retention Node12/12 pass.
Final cancellation tests/CI/activation remain pending; current live still73cf0d0.
See docs/verification/2026-11-02-bedrock-claude-workers.md. Do not duplicate the
new existing-DB bridge or claim unrestricted coding/autonomous approval support.

Claude worker CI41509466823 failed on two synthetic CLI tests because their shebang
assumed /usr/bin/node. Use process.execPath in fixtures; the real Bedrock canaries
are not the failing cases. Root also moved model/profile preflight ahead of attempt
reservation and redacts exact loaded AWS credential values before result storage.
Latest runtime build passed; full corrected CI is required before activation.

### Claude/Bedrock release gate closed — 2026-11-02

Running code:7e4290d094a26a18f08236d0420ab8629feb7734. CI41510207022 green
(741 Node tests per runtime22/24,548 supervisor Python tests,Oracle API green).
Installed real Claude task succeeded, matching Haiku model and review artifact;
CLI-reported cost$0.001566. Installed direct Bedrock catalog(3 models) and Messages
exact-response execution passed. Publichealthz200; CLI endpoint directory updated.
Private backup rollback-7e4290d-1793647859 preserves old service/links/config/DBs.
No fresh external OAuth login or visual QA claimed; built-in browser disabled.

Remaining product work is separate: Claude workspace tasks are not main job_submit
DAG tasks; worker policy is read-only Read/Glob/Grep at capacity1. Actual ChatGPT
event callback/reaction, unrestricted coding policy, full mixed-provider planning,
and historical retired-provider purge are not complete. Next integrate the existing
Claude execution contract with the main scheduler before claiming automatic
mixed-provider Claude dispatch; preserve private attempts and do not replay them.

### Main Claude DAG integration — 2026-11-04 (local gate)

Added explicit agent/claude-code task execution, trusted profile discovery and
main-scheduler binding. Reuses Claude workspace task/attempt ledger; no duplicate
queue. Python enforces profile/model/time/output/owner fences and no replay after
lease loss. Job cancellation now reaches owned Claude children; generation-conflict
receipts are bounded. Real Python+fakeCLI integration passes dependencies,
idempotency, artifacts and cancellation. Final agent/worker subset43/43 passed;
Python5new+90existing passed. See verification/2026-11-04-claude-unified-jobs.md.
Next: full CI, private config profile binding, backed-up release activation, real
bounded Claude/Oracle mixed job, and restart/result retrieval proof. Do not claim
those production gates complete from local tests.

### Unified execution production gate — 2026-11-04

Running backend8cc347a, readable launcher66e859b. One ordinary job completed
Claude/Bedrock, Oracle and Cloudflare tasks with validated outputs and model/source
attribution; Claude package inspection matched local name and dependency count.
Pairwise execution overlap verified; no triple-overlap claim. Job IDs and detailed
proof are in verification/2026-11-04-claude-unified-jobs.md. Configured, occupied,
available and retained capacity are distinct; another client's ambiguous slots
were never cleared. Full backend CI752Node per22/24,556Python and18Oracle passed.

Follow-up source fixes: generic ROTOXY metadata no longer claims LightSprint;
retired optional-upstream doctor probes are skipped truthfully; native worker
startup now defers dispatch until executor attachment and preserves durable
profile bindings during bootstrap. Real Python restart test verifies persisted
results without replay after cancellation. Root corrected CLI formatter test
expectations after an extra plan-output detail changed its snapshot (CI41860043789).
Next: full final CI, activate these small follow-ups, rerun doctor and retrieve
existing job results without paid calls. Built-in browser navigation is failing
its browser.user API; all3 public Funnel edges return login200 in4–5seconds.
The fresh login link is available; authenticated visual QA still pending.

Still open beyond this gate: Codex subscription durable execution/native-account
protection end to end; actual client callback/resumption QA; exact-ID historical
retirement purge with backup/rollback; remaining search/Oracle/UI acceptance and
arbitrary-objective planner gates. Do not count static registrations as execution.
