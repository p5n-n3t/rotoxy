# Agent workspace release — 2026-10-16

Status: deployed and pushed to the canonical `p5n-n3t/rotoxy` main branch at
`270e4e7db4220781f36d2f576974ceb46505b5b5`. This is an implemented collaboration
milestone, not completion of the full product roadmap.

## Working behavior

- `/admin/agents` is the shared agent workspace. The authenticated MCP tools
  `workspace_snapshot` and `workspace_update` expose the same durable tasks,
  participants, messages, artifacts and independent review decisions.
- Project membership comes from the supervisor binding. Actor identity comes
  from the authenticated client. Atomic task claims, expected revisions,
  idempotency receipts and SQLite transactions prevent conflicting updates.
- Private recipient messages remain recipient-scoped; admin access is explicit.
  Review decisions do not merge GitHub pull requests or approve provider-native
  tool execution. Configured account/model references are labeled as reported
  metadata, not inferred entitlements or observed capacity.
- `/admin/codex`, directly linked under Resources, provides official isolated
  ChatGPT/Codex profile enrollment. The running gateway now has an explicit
  trusted Codex executable configured. Two existing Plus profiles successfully
  returned account, model and rate-window observations without inference.
  No automatic subscription rotation or subscription-backed inference API was
  enabled. The official device login still requires the operator's account choice.
- A bounded Claude Code worker uses the local AWS Bedrock credential chain and
  fixed inference-only CLI flags. A real task returned the expected marker and
  entered artifact review. Re-running the same task skipped inference because its
  durable attempt already existed. This does not establish Claude's MCP OAuth
  consent, a separate client authorization flow.
- The page detects durable workspace revisions using ordinary code. It preserves
  unsaved form input before refreshing. The independent supervisor continues to
  monitor registered cloud sessions without an interactive chat or an LLM timer.

## Evidence

- Full Node suite: **409 passed, 0 failed**.
- Full Python suite on ora5 from the public source archive: **335 passed**.
- Package verification: 450 archive files, 54 Python modules, 15 explicit imports.
- Isolated fresh-home packed install, canonical commands, manual boot-off plan,
  loopback health and owned-process shutdown passed.
- Two-client real OAuth/MCP tests cover project isolation, actor spoofing, scopes,
  atomic claims, private messaging and independent artifact review.
- Authenticated local browser checks at 1280×720, 1440×900 and 390×844 cover the
  workspace and enrollment page. No horizontal overflow or desktop sidebar scroll
  was observed. Native task forms and unsaved-draft revision detection passed.
- ChatGPT Desktop's built-in browser rejected the target with
  `ERR_BLOCKED_BY_CLIENT`; it did not provide visual proof. The recorded browser
  proof above comes from the local application test browser.
- Public and loopback `/healthz` both returned healthy after deployment. The
  public `/mcp` returned the correct OAuth resource challenge; discovery returned
  200 and protected admin pages redirected to the proper login page.

Private receipts and sanitized test logs are under
`~/.local/state/rotoxy/batches/20261016/agent-workspace/`. No credentials are
included in this report or repository.

## Runtime and rollback

Canonical runtime: `~/.local/share/rotoxy`; config: `~/.config/rotoxy`; operational
state: `~/.local/state/rotoxy`. All canonical gateway, Oracle pool, monitor and
Funnel units were active after deployment. Root Funnel ownership remains with the
single gateway. Boot remains manual.

Previous runtime: `~/.local/share/rotoxy-pre-agents-20261016T004122Z`.
State backup: `~/.local/state/rotoxy/backups/pre-agents-20261016T004122Z`.
The live and backup workspace SQLite files both passed `quick_check`.

For a runtime rollback, stop the canonical gateway/Oracle/monitor units, preserve
the current runtime and databases, restore the preceding runtime directory, then
restart those units and verify `/healthz` and root OAuth discovery. Do not restore
an older database over newly recorded tasks or replay uncertain provider actions.
The deployment helper already rolls back the runtime if startup health fails.

## Current limits and next integration

The shared collaboration system, existing durable LightSprint jobs, Oracle task
pool and bounded Claude worker are functional. They are not yet one universal
cross-provider task scheduler. A shared task reference does not itself launch a
provider worker. The next integration connects explicitly published workspace
assignments to the existing owner-scoped job dispatcher, with durable submission
intents and read-only reconciliation after ambiguous outcomes.

LightSprint native sub-agent discovery succeeded on one owned task. That is not
proof of unrestricted discovery across accounts, exact selectable model support,
12 active slots per account or 35 overlapping workers. Twelve configured accounts
and eleven selectable accounts are health inventory counts, not usable inference
capacity. Provider credits remain dated observations where no live API exists.

Claude MCP consent has not completed; a successful Bedrock CLI task is separate
evidence. Dormant ChatGPT conversations cannot be claimed awakened by MCP events.
Durable inboxes and explicit supported resumption adapters remain the handoff.
