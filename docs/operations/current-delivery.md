# Current delivery — 2026-10-23

The operator resumed implementation on October 23. Historical pause files are
recovery evidence and do not override that resume. Use the current Git state and
this file before starting another assignment.

## Verified runtime

- Gateway and workforce monitor were stopped; restarted their existing units.
- Public `/healthz` returns 200; OAuth metadata uses the root ROTOXY issuer and
  `/oauth/register`, `/oauth/authorize`, `/oauth/token` endpoints.
- `claude mcp list` reports the ROTOXY MCP connection connected.
- Seven registered LightSprint sessions across four accounts responded to
  read-only status checks. All report `gpt-6-luna` and idle; one sandbox is
  finished. Observation access is not evidence of active execution or quota.
- Account quota, provider slot entitlement and thirty-worker overlap remain
  unverified. Existing bindings are not thirty dispatchable cloud agents.

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

## Remaining product work

1. Activate and verify the tested bundle, including authenticated UI and tool
   discovery. Do not equate OAuth metadata with a complete MCP execution test.
2. Complete runtime provisioning/admission against supported provider contracts;
   keep fresh exact-model/effort selection unavailable without provider evidence.
3. Connect heterogeneous workspace dispatch (Oracle, local CLI, LightSprint)
   through their distinct capability and cancellation semantics.
4. Verify real bounded execution, overlapping multi-account work and durable
   restart/recovery behavior before increasing workforce concurrency.

The previous Claude release audit exhausted its bounded budget while loading
context and produced no findings; do not count it as a successful review or
repeat the same context-heavy launch.
