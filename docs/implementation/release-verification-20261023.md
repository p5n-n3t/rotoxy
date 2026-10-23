# ROTOXY release verification — 2026-10-23

## Current release: pool controls and confirmed quota snapshots

PR #19 merged as `b9896fb`; immutable runtime `146ccc2` is active. The Desktop
checkout is on main. Confirmed used-credit readings were reconciled in the private
snapshot ledger, including the additional zero-usage account. Four depleted
credentials remain disabled. Exact balances and credentials are excluded here.

Final CI run `40017208433` passed on Node 22 and 24: 570 Node tests, installed
OAuth/Python wiring smoke, and 507 Python tests. Local focused runs passed 74
checks before the account-removal safeguard and 41 checks afterward. A later
local integration probe timed out at the Python bridge on the memory-starved
host; it is not reported as a pass. The default full suite now limits execution
to two concurrent files. The final CI passed with the original recovery deadline
and assertions, not an increased timeout.

Post-activation evidence:

- Gateway, workforce monitor, Oracle pool and Funnel services are active.
- Public `/healthz` reports healthy.
- Native MCP discovers ROTOXY Fleet; its inventory contains 13 accounts and seven
  registered sessions. These are inventory counts, not active worker capacity.
- Claude Code reports the consolidated server connected.
- A credential-pinned, read-only legacy LightSprint session-status request succeeds.
- The authenticated browser session expired on restart. Live visual verification
  awaits sign-in; a disposable local browser preview also timed out. Neither is
  reported as a visual pass.

See `docs/operations/pool-dispatch-controls.md` for supported pool switches and
account ceilings. Provider-reported quota enums may remain unavailable while the
separately sourced manual monthly snapshot is present; manual snapshots are not
live provider measurements. Dollar-to-credit conversion remains unverified.

The upstream MCP description now documents workspace-scoped LightSprint routes.
A read-only scoped stacks request was rejected by the existing gateway allowlist;
the legacy pinned status request succeeded. See
`docs/operations/lightsprint-api-compatibility.md` before changing adapters or
repeating capability research.

Rollback code to `51b007c` using the private `*.before-pool-controls.conf` service
overrides under `~/.local/state/rotoxy/backups/release-20261023/`, restore the CLI
symlink, daemon-reload and restart the same three services. Preserve the private
quota ledger; rolling back code does not require undoing corrected readings.

## Earlier release evidence (historical)

The sections below describe earlier releases; their runtime hashes, test counts
and browser state are superseded by the current release evidence above.

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
