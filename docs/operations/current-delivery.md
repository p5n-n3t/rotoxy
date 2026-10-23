# Current delivery — 2026-10-23

The operator resumed implementation on October 23. Historical pause files are
recovery evidence and do not override that resume. Use the current Git state and
this file before starting another assignment.

## Verified runtime

- Activated immutable runtime `~/.local/share/rotoxy-releases/1a9e067` using
  service drop-ins. The original installation remains available for rollback.
- Real manual `down` then `up` succeeded: down withdrew the owned Funnel and
  stopped the app units; up restored all services and one root Funnel.
- Gateway and workforce monitor were stopped; restarted their existing units.
- Public `/healthz` returns 200; OAuth metadata uses the root ROTOXY issuer and
  `/oauth/register`, `/oauth/authorize`, `/oauth/token` endpoints.
- `claude mcp list` reports the ROTOXY MCP connection connected after activation.
- PR #15 merged as `a0f5a1c`; follow-up PR #16 merged as `88fe7cc`.
  The active follow-up adds `/admin/fleet` and redirects authenticated old links.
  Its CI Node 22/24 and full Python suite passed (run 39971822398), and its
  installed OAuth smoke and post-activation Claude reconnect passed.
- PR #15 validation: Local Node suite: 560/560 passed; CI Node 22
  and 24 and the full Python suite passed. Installed OAuth/Fleet smoke passed.
- Desktop connector read-only calls currently return an internal error while
  Claude reconnects. Reconnect the Desktop app; do not treat it as verified.
- Browser authenticated workforce checks passed before activation; post-update
  visual checks are blocked by local browser use being disabled in Work settings.
- Seven registered LightSprint sessions across four accounts responded to
  read-only status checks. All report `gpt-6-luna` and idle; one sandbox is
  finished. Observation access is not evidence of active execution or quota.
- Account quota, provider slot entitlement and thirty-worker overlap remain
  unverified. Existing bindings are not thirty dispatchable cloud agents.
- Three bounded source reviews completed on ORA5, ORA6, and ORA7 with 81 seconds
  of measured execution overlap. Five earlier reviews used ORA1 because of
  stale catalog failures; refreshing catalogs and periodic daemon refresh
  corrected that eligibility problem. A speculative Oracle review claim about
  monotonic-clock drift was rejected; advisory output is not validation proof.

## Integration changes

- ROTOXY Fleet labels preserve existing machine IDs and durable ownership.
- Existing-session binding administration verifies account/session identity and
  reported model; it does not create or launch provider sessions.
- Release audit now stages and verifies the portable skill and scenario files.
- Manual controller supports an explicitly approved migration of the exact
  persistent root mapping to its foreground Funnel unit. Foreign mounts are
  refused, unrelated ports are preserved, and global route resets are forbidden.

## Release gate

Run the full Node suite, focused lifecycle and shell regressions, offline package
audit, installed-package smoke, and applicable supervisor checks. Capture an
owner-only config backup plus SQLite backup snapshots before activation. Deploy
a versioned code directory with a reversible service override; keep credentials,
job IDs, account/session mappings and provider policy in the existing store.

Completed checks: offline tarball audit; installed-package boot; real PKCE to
Python Fleet discovery/snapshot; zero-provider recovery/restart proof; 46 Oracle
tests; 12 credit-policy compatibility tests; 13 runtime/readiness tests; 13
shell/lifecycle tests. The final local Node run passed 560/560, and CI on Node
22/24 plus the full Python suite passed at commit `89e6b90`. Earlier full Python
execution under local host load had two subprocess timing failures; the isolated
rerun and final CI passed. Keep the earlier logs as historical evidence.

Initial activation rolled back safely because the new strict loader rejected
the existing explicit empty disabled credit policy. The narrow compatibility
fix preserves that setting while strict callers and malformed policies still
fail closed. No credit setting was changed to make activation pass.

Private backup and executable code rollback are under
`~/.local/state/rotoxy/backups/release-20261023/`; SQLite snapshots passed
`quick_check`. The manual controller/CLI entrypoint now uses the release. CI
also runs isolated Fleet OAuth and Python supervisor checks.

## Remaining product work

1. Verify Desktop connector discovery after reconnect and post-restart browser
   checks when browser access is enabled. Do not repeat the completed release.
2. Complete runtime provisioning/admission against supported provider contracts;
   keep fresh exact-model/effort selection unavailable without provider evidence.
3. Connect heterogeneous workspace dispatch (Oracle, local CLI, LightSprint)
   through their distinct capability and cancellation semantics.
4. Verify real bounded execution, overlapping multi-account work and durable
   restart/recovery behavior before increasing workforce concurrency.

The previous Claude release audit exhausted its bounded budget while loading
context and produced no findings; do not count it as a successful review or
repeat the same context-heavy launch.


## Quota update — 2026-10-23

PR #17 merged as `15e068c`; immutable runtime `0de87f1` activates durable
provider-USD session-cost tracking. Its CI Node 22/24 and Python checks pass.
The monitor has collected seven real session-cost baselines with zero launches.
Repeated, stale or decreasing counters do not manufacture debits; an initial
reading is a baseline rather than historical spend charged again.

Twelve owner-reported quota readings and refresh dates are saved privately. Four
accounts declared depleted are disabled regardless of provider overage behavior;
jqthefoo is unused with a full 10M-credit baseline. Seven new amounts require
used-versus-remaining clarification before replacing historical balances. The
configured maryjoebake account was omitted from the new report and stays
unverified. Do not reinterpret these pending inputs or automatically refill
accounts on calendar dates. The raw import and pre-change backup are private
under the existing configuration directory.

Official pricing confirms 10M credits per Pro seat but supplies no fixed
USD-to-credit exchange rate. Track reported USD independently until conversion
is evidenced; sandbox, planning and unregistered session coverage are incomplete.
See [accounting behavior](lightsprint-quota-accounting.md).
