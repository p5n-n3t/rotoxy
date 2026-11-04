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
