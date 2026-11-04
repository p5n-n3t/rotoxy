# Claude Code in unified durable jobs — 2026-11-04

The existing Claude workspace executor is now an explicit agent capability in the
main durable scheduler. Oracle/Cloudflare inference contracts remain distinct.
The scheduler is still the only DAG queue; the existing Claude attempt table is
still the only Claude launch ledger.

## Client contract

Discover `job_workers.agentResources`. Only project-bound, enabled trusted profiles
and selected models appear. Include the reported account ID in `eligibleAccountIds`:

```json
{
  "mode": "agent",
  "provider": "claude-code",
  "profileId": "claude-bedrock-local",
  "model": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "timeoutMs": 90000
}
```

Use this as a task's `execution` field in the existing `job_submit` contract.
The output limit is at most 16384 bytes. A result must end with the task's exact
completion marker. Use ordinary job status/results/inbox tools for this DAG.
Explicit workspace task tools remain supported; those IDs are not job IDs.

Profile capacity is one and shared with explicit Claude workspace calls. Busy
profiles pause new scheduler dispatch; account/model routing controls are checked
again at dispatch. This is read-only Read/Glob/Grep execution with the existing
$0.25 per-run CLI setting, not a provider-guaranteed billing ceiling. Account quota
is not invented, and Claude Code does not gain a new API entitlement.

## Ownership and recovery

Python derives project/client/job/task identity from the authenticated durable
assignment, never caller instruction fields. The operation maps to a stable
workspace task ID. Its existing owner/profile/prompt-bound attempt is inspected
before launching. Lost/failed/cancelled/expired operations cannot blindly relaunch.
Accepted results require matching reported model/profile and a stored review
artifact, in addition to the output contract. Results retain attempt/artifact/
profile IDs and CLI-reported cost evidence. Times describe the orchestration
interval, not GPU inference timing.

Job cancellation first persists the scheduler state, then requests cancellation of
its matching owned Claude child. A cancellation fence also covers cancellation
while submission is in progress. Post-launch outcomes remain ambiguous; no work
is substituted. Shutdown cancels owned DAG children before waiting for workers.
Late generation-conflicting receipts produce a diagnostic and are not retried
forever. Artifacts already produced are retained for review.

## Local verification

- Existing targeted scheduler/runtime/schema tests: 69 passed before cancellation
  additions; final agent/worker integration subset: 43 passed.
- Real Python bridge + actual synthetic CLI: two dependent DAG nodes completed,
  each with model, attempt, artifact and cost metadata; idempotent resubmission did
  not launch more processes. A third long-running node was cancelled; its owned
  child exited and the private attempt remained ambiguous without replacement.
- New Python agent registry tests: 5 passed; existing job registry tests: 90 passed.
- Onboarding/MCP/agent subset: 17 passed before final cancellation additions.

These local tests use synthetic credentials and executables, not live Bedrock
inference. Full CI, production activation and bounded live execution are separate
release gates. This change does not prove arbitrary objective decomposition,
autonomous code editing, dormant ChatGPT wake-up, or the full product roadmap.

Follow-up review added cancellation fences before invocation/profile discovery,
plus registry-failure isolation and requested-model attribution for agent nodes.
Tests cover cancellation before invoke and during delayed discovery with zero
launches. CI41855286203 exposed an old test's positional schema assumption; the
assertion now locates the fresh branch by discriminant. Final focused subset13/13
passes, including the real Python/synthetic CLI dependency+cancellation test.

## Installed gate and capacity finding

CI41855929937 passed 751 Node tests on each of Node22/24, 553 Python supervisor
tests and 18 Oracle API tests. Release4fbe0ed was activated after a consistent
private rollback backup at
`~/.local/state/rotoxy/releases/rollback-claude-dag-1793805492/`.

Live job `rx-unified-claude-oracle-20261104-a` completed its Claude and Oracle nodes
with verified arithmetic output and completion markers. Claude requested/reported
Haiku matched and its review artifact was retrieved; CLI-reported cost$0.002182.
Oracle reported `oracle/qwen3.5:2b` on ora6. Their measured client invocation
intervals overlapped12.814seconds (not proof of GPU timing).

Cloudflare remained queued because an unrelated client's ambiguous task retained
that account slot. No slot was released and that client's work was untouched.
The controlled probe job was cancelled after inspection, retaining its completed
outputs. Its three-provider completion gate did NOT pass. Private report and
$0.27 estimated budget reservation retain this result; no ambiguous call was replayed.

The follow-up adds a read-only authenticated private capacity endpoint, reporting
configured capacity, occupied slots, available slots and retained ambiguous slots.
Discovery exposes those distinctions. New inference assignments prefer a free
eligible account when available; already dispatched stateful work stays pinned.
If all eligible accounts are busy, queueing remains valid. Missing occupancy data
is explicitly reported; configured capacity is not labelled free capacity.
Tests cover retained-slot counting without double-counting repository attempts,
no state mutation from reads, endpoint authentication, and free-account selection.

Capacity follow-up verification caught a stored credential ID starting with `_`.
Its old validator rejected the entire capacity request. Account-key validation is
now consistent across capacity, MCP submission schema/parser, and claimed worker
operations (job/task identifiers retain their stricter rules). Regression tests
exercise underscore account IDs in routing and actual worker dispatch. The second
live job `rx-unified-capacity-20261104-b` completed Claude file inspection and
Oracle computation with8.004seconds of client-interval overlap; Cloudflare was
excluded because occupancy was explicitly unavailable, not counted as executed.
Its Claude CLI reported$0.004763. A final capacity/three-provider gate remains.

## Final installed mixed-provider proof

Release8cc347a passed CI41858645741 and was activated with rollback material at
`~/.local/state/rotoxy/releases/rollback-account-ids-1793806458/`.
Live job `rx-unified-all-providers-20261104-c` completed all three nodes:

- Claude Code via Bedrock Haiku read package.json and returned the requested
  inspection result, exact marker, matching model, attempt and review artifact.
  CLI reported$0.004905.
- Oracle returned validated arithmetic and marker, reporting qwen3.5:2b on ora7.
- Cloudflare returned validated arithmetic and marker through its selected Llama
  endpoint. It did not report a model ID; the selected endpoint is the model
  evidence, as required by the existing Cloudflare contract.

All results were retrieved via the ordinary job results operation. There was
pairwise overlap (Claude/Oracle and Oracle/Cloudflare), but no common interval for
all three. Do not claim three simultaneous executions. These measured intervals
cover client invocations, not GPU execution. Discovery correctly showed six free
Cloudflare accounts and two retained slots at the observed time. Retained work
from other clients was not modified. Verification used short-lived locally issued
scoped JWTs for a registered client, not a fresh external OAuth login.

The lifecycle CLI also now defaults to concise readable output, retains --json
for automation, and reports actual local health in status. Focused launcher tests
pass14/14; installation of the wrapper does not require a backend restart.

## Restart and diagnostic follow-ups

The real Python/synthetic CLI test now restarts the supervisor after success and
cancellation and retrieves both completed outputs without additional launches.
It exposed provisional native profile registration during bootstrap clearing a
retained binding. Bootstrap now preserves native bindings and defers the worker
until the trusted executor attaches; no claim can dispatch through an absent
executor. Native runtime and workspace proofs remain read-only/bounded.

Generic workspace owner/summary metadata now identifies ROTOXY. Only the exact
legacy synthetic owner tuple is normalized in the read DTO; real historical
provider participants and message sender snapshots are not rewritten. Optional
upstream doctor checks no longer probe retired/absent targets or report stale
upstream inventory as a current tools error. Authenticated local tool discovery
is still a separate proof; a 401 is not relabelled a successful tools/list.

All three public Funnel DNS A addresses returned the login page with TLS
verification enabled (HTTP200, approximately4–5seconds). Previous host-only checks
resolved the private100.x Tailscale address and therefore were not independent
public-ingress proof. Browser navigation subsequently reported its browser.user
API unavailable; no authenticated visual QA is claimed from that failure.

The capacity bottleneck was traced to five retained global slots, three from the
retired workspace provider. Exact backed-up retirement released only those three;
see 2026-11-04-legacy-slot-retirement.md. The initial follow-up probe d failed at
read-only discovery, before any budget reservation/submission; do not treat that
as a provider launch or blindly replay a submitted operation.

Optional, unconfigured upstream probes now have explicit skipped status. Missing
required evidence remains unverified and actual failures remain failed. Doctor
can report healthy when all configured requirements pass without falsely claiming
an authenticated local tools/list observation. The repository's portable guide
and optional orchestration skill describe the verified agent/inference contract,
capacity distinctions, origin protection and no-replay rules. Native Claude task
cards now link to the durable parent job and external task ID.

## Restored-capacity verification

Job `rx-unified-restored-capacity-20261104-d` completed all three tasks after the
exact legacy reservation retirement. Claude Haiku through Bedrock produced a
review artifact (attempt7), Oracle qwen3.5:2b ran on ora5, and Cloudflare's pinned
llama-3.1-8b-instruct-fp8 endpoint returned the required arithmetic and marker.
All three client invocation intervals overlap by2.455 seconds. This measures
request lifetimes, not internal GPU execution. Claude reported $0.004889; actual
Cloudflare charges remain unreported. The initial read-only discovery failure
created no assignment or budget reservation; both were checked absent before
this one submission. No ambiguous mutation was replayed.

Authentication used a temporary locally signed scoped JWT for an existing
registered OAuth client. This does not prove a new external client's OAuth consent
or dormant-chat event delivery. Private receipts remain outside version control.

## Activated release and rollback

Runtime and installed CLI activated from immutable release
`f5e9b89688ca6b1b49235a0dbd54c3e0e28d5ebf`. Its CI41874702231 passed on
Node22/24 (755 Node tests per job),562 Python supervisor tests and18 Oracle API
tests. Doctor reports healthy: optional absent upstream checks are explicitly
skipped, with process/config/credentials/OAuth/Funnel evidence checked. Public
Funnel edge176.58.90.63 returned login HTTP200 with TLS verification. Gateway,
Oracle pool, monitor and Funnel units report active; local readiness is ready.

After activation, job_results returned the three completed results from job c;
Claude artifact attribution survived, and exact synthetic legacy owner attribution
was corrected without changing real historical provider actors. No replay occurred.

Activation backup:
`~/.local/state/rotoxy/releases/rollback-activation-1793812193/`.
It contains the previous service drop-in, CLI link targets, supervisor config and
consistent scheduler database backup. Roll back service/CLI references only after
checking for active operations. Do not restore the whole old database over newer
client work. Funnel configuration was untouched.

The built-in browser lists an authenticated Admin tab after operator login, but
its inspection control reports unavailable. No authenticated visual acceptance is
claimed. MCP Events server support still has no proven live ChatGPT subscription
and reaction. Codex subscription execution remains unwired; see its separate audit.
Verification-sidecar conservative reservations total$1.59; this is an estimate,
not a guaranteed bill or a substitute for provider-reported usage.
