# ROTOXY release verification — 2026-10-23

## Integrated and activated

PR #15 merged to main as `a0f5a1c`. Follow-up PR #16 merged as `88fe7cc`;
immutable runtime `1a9e067` is active. The authenticated Fleet page is now
`/admin/fleet`; old links redirect without migrating durable identifiers.
Both Node CI jobs and full Python checks passed in run 39971822398.
Post-activation health and Claude reconnect passed; all four service units
reported active. The public Fleet page correctly redirects unauthenticated
visitors to login. Visual verification remains pending.
Gateway, Oracle daemon, workforce monitor and foreground Funnel units are active.
The Desktop source checkout now contains main rather than the October 7 branch.
Existing untracked handoffs and other worktrees remain intact.

The release preserves encrypted credentials, OAuth grants, session mappings,
SQLite ledgers, and the operator's explicit disabled credit-admission setting.
An initial failed activation rolled back before the compatibility fix. A later
MCP reconnect defect came from rejecting an existing `authenticatedClients`
search permission; that configuration is now supported without granting any new
permission. Search discovery failures do not disable unrelated MCP tools.

## Evidence

| Check | Observed result |
| --- | --- |
| Local Node suite | 560/560 passed |
| GitHub CI Node 22 and 24 | Passed, run 39952583525 |
| GitHub CI full Python suite | Passed |
| Installed real OAuth PKCE + Python workspace snapshot | Passed with disposable state and zero provider calls |
| Claude MCP reconnect | Connected after activation |
| Public gateway health | HTTP 200 |
| Authenticated browser before final activation | Overview and worker account/model/task attribution observed |
| Post-activation browser check | Blocked: local browser use disabled in Work settings |
| Desktop ROTOXY connector calls | Internal error on project discovery and Oracle catalog; reconnect pending |
| Oracle execution | Three earlier source reviews overlapped 81 seconds on ORA5/6/7 |
| LightSprint | Seven existing sessions observed across four accounts; no new launch or quota proof |

Neither OAuth registration nor idle LightSprint sessions prove successful model
execution, exact model choice, account credits, or twelve concurrent slots.
Thirty-worker execution has not been verified. Automatic cross-provider dispatch
and new LightSprint session provisioning remain separate incomplete integration
work; the existing-session workflow must not be presented as those features.

## Recovery

Private backup: `~/.local/state/rotoxy/backups/release-20261023/`.
The backup contains consistent SQLite snapshots, which passed `quick_check`,
original service overrides, and `rollback-code.sh`. Original installation code
is retained. Do not delete `rotoxy-releases/1000096`: the active release uses its
installed dependency directory. Reconcile any active worker operations before
rolling code back. Never replay an ambiguous provider mutation.

## Follow-up reviews

Two additional bounded `qwen3.5:9b` reviews completed concurrently on ORA6 and
ORA7: `rx-followup-20261023-contract` and `rx-followup-20261023-id-review`.
The account-ID compatibility finding is addressed by regression coverage for
leading `_` and `-` without changing persisted IDs or workspace validation.
The contract reviewer correctly distinguished missing evidence from unsupported
upstream functionality. Its suggestion to infer executable capabilities by
parsing natural-language prose was rejected: launch authorization needs a
reviewed adapter contract with explicit correlation and mutation semantics.
