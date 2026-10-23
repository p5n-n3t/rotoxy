# Current delivery — 2026-10-23

The operator resumed implementation on October 23. Historical pause files are
recovery evidence and do not override that resume. Use the current Git state and
this file before starting another assignment.

## Verified runtime

- Activated immutable runtime `~/.local/share/rotoxy-releases/1ec9389` using
  service drop-ins. The original installation remains available for rollback.
- Real manual `down` then `up` succeeded: down withdrew the owned Funnel and
  stopped the app units; up restored all services and one root Funnel.
- Gateway and workforce monitor were stopped; restarted their existing units.
- Public `/healthz` returns 200; OAuth metadata uses the root ROTOXY issuer and
  `/oauth/register`, `/oauth/authorize`, `/oauth/token` endpoints.
- `claude mcp list` reports the ROTOXY MCP connection connected.
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
shell/lifecycle tests. Full Node run was 559/560: its only stale Fleet-label
assertion passed after correction. Full Python was 504/506: its two two-second
advisory subprocess timing failures passed on isolated rerun (5/5). Do not
describe those original full runs as entirely green.

Initial activation rolled back safely because the new strict loader rejected
the existing explicit empty disabled credit policy. The narrow compatibility
fix preserves that setting while strict callers and malformed policies still
fail closed. No credit setting was changed to make activation pass.

Private backup and executable code rollback are under
`~/.local/state/rotoxy/backups/release-20261023/`; SQLite snapshots passed
`quick_check`. The manual controller/CLI entrypoint now uses the release. CI
also runs isolated Fleet OAuth and Python supervisor checks.

## Remaining product work

1. Finish post-restart authenticated UI and client checks, then merge the
   verified source through PR #15. Do not repeat the completed activation,
   provider reviews, or backup. Browser sign-in expires on gateway restart.
2. Complete runtime provisioning/admission against supported provider contracts;
   keep fresh exact-model/effort selection unavailable without provider evidence.
3. Connect heterogeneous workspace dispatch (Oracle, local CLI, LightSprint)
   through their distinct capability and cancellation semantics.
4. Verify real bounded execution, overlapping multi-account work and durable
   restart/recovery behavior before increasing workforce concurrency.

The previous Claude release audit exhausted its bounded budget while loading
context and produced no findings; do not count it as a successful review or
repeat the same context-heavy launch.
