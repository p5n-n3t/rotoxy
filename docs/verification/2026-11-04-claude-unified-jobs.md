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
