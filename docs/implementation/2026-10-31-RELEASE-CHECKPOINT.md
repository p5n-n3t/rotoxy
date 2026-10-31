# ROTOXY Oct31 release and Oracle checkpoint

## Current release — final verification

This section supersedes the earlier snapshots. Gateway, Oracle pool and monitor
all run immutable `e85b562f556906c6537b83fecb7503dbe6dbd38f`. CI `41223139348`
passed Node 22/24, including 646 Node tests and 527 Python tests. Build, focused
doctor/bridge tests, local/public health, authenticated MCP Fleet discovery, and
public OAuth metadata passed. Rollback drop-ins:
`/home/jq/.local/state/rotoxy/backups/release-20261031-e85b562/`.

Oracle direct inference is live at the public `/providers/oracle/v1` path. A
temporary scoped model token returned exact `ROTOXY_PUBLIC_OK`, reported model
`oracle/qwen3.5:2b`, and verified VM header `ora3`; the token was revoked.
The private origin's five-host inference smoke passed. Authenticated search and
extraction are live at `https://search.ziopsyop.tech`: real search results,
extraction, missing/invalid-token rejection, and private-address rejection all
passed. Cloudflare Tunnel version 2 preserves the existing Shodan route. See
the connection-readiness and Oracle reports for API limits and credential types.

LightSprint is externally blocked. Monitor observations were healthy early in
the run, began failing during the 16:37 UTC cycle, and all nine reported HTTP
401 by 16:43 UTC. Six other enabled positive-snapshot accounts also failed
read-only MCP initialization. No official published auth migration/incident was
found. Do not infer quota exhaustion, disable accounts automatically, change
authentication schemes, or launch replacement jobs from this evidence.

The fixed review job's supported reconciliation now queues the exact task-bound
GET. It completed as blocked/auth, assignment revision 4, with no session yet.
Original assignment: `ws-bc95744eebb98cba5590c72eff1ee1fa092d32eef32af348`;
provider task: `QjOCtgdP6tLpcNjhNwi9r`; owner account: maryjoebake. Its reservation
remains retained because the launch was ambiguous. Next action after the user
repairs that account's official upstream authentication: read current revision,
invoke revision-fenced `reconcile_task` for `renewal-review` once, and observe
the original task. Never resubmit or relaunch it. Auth-only inspection retries
are capped at three, with a 60-second cooldown.

Doctor no longer reports stale cached successes as current health. Cached probe
and tool evidence expires after five minutes; disabled accounts cannot supply
success evidence. Live public OAuth/Funnel checks pass; upstream/tool stages are
unverified when current evidence is missing. Browser QA remains unavailable
because local browser use is disabled in Work settings. No stale Claude process
was running, and no replacement was launched with the known network-blocked preset.

The user has a pending request to reconnect one LightSprint account through its
official flow. No secrets were requested in chat. The three untracked Oct22
handoff files remain untouched. Product-wide completion is not claimed.

## Earlier continuation — 16:10 UTC

This update supersedes the historical snapshot below. All three runtime consumers
(gateway, Oracle pool, workforce monitor) now use immutable release
`fa6801db586d8384910e0bb61675a6efc630dba0`. Local and public `/healthz` return
200; the existing authenticated MCP connection lists ROTOXY Fleet. CI
`41217470458` passed Node 22 and 24; subsequent CI on `fa6801d` also passed.
The manual account-pause protection is deployed. Thirteen focused route/admin
tests passed after the final TypeScript build. Rollback drop-ins are under
`/home/jq/.local/state/rotoxy/backups/release-20261031-fa6801d/`.

The monitor's post-restart cycle checked nine sessions, reported zero status
errors, and completed recovery processing. Desktop alarm delivery is not
configured; this is not a claim that dormant ChatGPT turns can be awakened.

The original rejected pre-launch reservation has now been released through the
supported cancel operation. The already-approved fixed LightSprint job advanced
through task creation, instruction patch and verified readback, then stopped at
an ambiguous launch response (`launch_session_identity_unverified`). Its provider
task is `QjOCtgdP6tLpcNjhNwi9r`. Do not submit or launch it again. Next action:
recover its session identity through pinned read-only provider inspection and
reconcile the original execution. No provider-start or terminal-result proof yet.

Oracle's new scoped API bridge is deployed at `/providers/oracle/v1`. Catalog
discovery returned five small models. The first inference returned 422 because
of the origin's request-body middleware; worker commit `7c399d4` repairs that
origin defect and is being deployed separately. Re-test after origin deployment;
catalog success alone is not inference proof. Authenticated URL extraction and
five-host inference smoke tests remain in progress. No public DNS was published.
No exact `gpt-oss:20b` model was present on the five reachable hosts; ora1 remains
unreachable and unverified. Browser validation is currently blocked by the app's
"Local browser use is disabled in Work settings" restriction.

## Historical snapshot — superseded where noted above

Gateway and Oracle systemd units now run the same immutable release `5b91dd7a9575ee0d9aa0f279812f1b867fd859e4`. GitHub CI41188333312 passed Node22/24 on rerun. Rollback drop-ins: `/home/jq/.local/state/rotoxy/backups/release-20261031-5b91dd7/`. Gateway health24 configured/19selectable is inventory, not execution capacity.

LightSprint12 reported balances and dates saved; five depleted paused, joeyqleq8.04m restored from quota-only pause. ecummi16 untouched. Dates are scheduled pending verification; generic MCP paths lack strict admission so date alone does not enable spending. Manual account toggle protection commits b1b5d4f/79ed486 built and four focused renewal tests passed; not deployed yet.

Oracle pool config: `/home/jq/.local/state/rotoxy/oracle-pool/config.json`, sixhosts/fiveenabled,ora1unreachable,ora8added. Default qwen3.5:2b, coder3b, deepseek1.5b; tev1onlyora8, optionalgemma4:e2b onlyora8. Oneinference/host,fivetotal. Live MCP job `rotoxy-small-live-20261031` completed onora8 actualmodelqwen3.5:2b,oneattempt,5.44remote seconds,returnedexactly ORACLE_SMALL_OK. Historical9b/20bresults remain readable; new MCP submissions exclude those models. GPT-OSS20B removal NOT independently verified after interrupted Claude work.

LightSprint identity/ref and stateless adapter verification bugs fixed9844a4d+5b91dd7. Prior job `rotoxy-renewal-review-20261031` remains held before inference; never replay. Newjob `rotoxy-renewal-review-fixed-20261031` accepted, lastworkspace_syncqueued, no terminalproviderresult yet. Use workspace_sync originalID, rawjob_status requires privateassignmentID. Do not claim liveLightSprint completion.

Latest CI d93afb8 test-only observerfix still timedout Node22 backgroundreconciliation; first test-race hypothesis was insufficient. Production5b91dd7 rerunpassed but recurring scheduler/test issue remains. Diagnose lease/backlog/existingautomaticreconciler with deterministic instrumentation; do not increase deadlines or hide tests.

Oracle private services: ora3 `/opt/jq-worker/oracle-api/app.py` +compose, containeroracle-apihealthy port8877loopback/tailnet; /scrape backed by authenticatedCrawl4AI; /models proxyLiteLLM. No /search implementation verified, noOpenAIchatproxy verified, noMCPsearchverified. SSRF code checks initialDNS only; redirect/subresource/DNSrebinding protections insufficient for publicexposure. NoDNSpublished. LiteLLM unauth/models returned401. Domainziopsyop.tech zonef5e90699d3add60ffec98b3c7ada87c5, acct0228e3fe174bbc185f30b1d4eaf5f166; search.ziopsyop.techunused. Existingora3tunnela71d202a-2d51-405a-9d26-0d3096464688; preserveexistingroutes.

User explicitly requires staleClaude processes killed before replacement. Trackedtasks task-mvw6ry8a-0qqmwe and task-mvw7ja8o-q1n244 cancelled, PIDs verifiedgone. Last task preset in cc companion uses sandbox networkallowedDomains[]; SSH Bash failed. Do not launch same preset again or send shellcommands to inferenceworkers. Need supported per-task scoped SSH networking or parent nativeSSH operations. Nativeforwarders hitquota; avoid spawning more nativeagents blindly. Briefs `/tmp/rotoxy-oracle-api-search-20261031-brief.md` and `/tmp/rotoxy-oracle-20261031-brief.md` preserve scope.

Next: retrieve newLightSprintjob terminalresult; diagnose recurrent Node22reconciliation; finish privateOracleAPI auth+scrape/search security and directinference route; verify20Bremovals; publish authenticatedsearchhostname only after tests; promote manualpausefix aftergreenCI. Preserve threeuntrackedOct22handoffdocs.
