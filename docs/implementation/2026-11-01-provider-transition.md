# Provider transition and dynamic Codex account protection

The operator permanently retired LightSprint on November 1, 2026. This
supersedes every older checkpoint asking for LightSprint reauthentication,
quota renewal, session inspection, new jobs, or workforce expansion.

## Runtime changes verified

- Removed 13 legacy LightSprint credentials from the active gateway store.
- Cleared their supervisor account IDs, session registrations and fresh launch
  bindings. Kept historical jobs, artifacts and event records.
- Disabled the LightSprint routing pool and removed its resource rules.
- Removed the global upstream URL; built-in MCP tools remain available through
  the gateway's supported local-tool mode.
- Removed legacy monitor recovery/advice settings. Its next cycle checked zero
  retired sessions and submitted no guidance. The monitor process remains
  running for future provider-independent supervision.
- Existing authenticated MCP still discovers ROTOXY Fleet. `job_workers`
  reports no old account or worker bindings. This legacy job-worker interface
  does not represent Oracle inference capacity or Codex profile readiness.
- Cached Oracle catalog still contains the five small-model hosts ora3/5/6/7/8;
  ora1 remains disabled/unverified. No Oracle model or API configuration changed.

Private pre-change configuration and SQLite backups are under
`/home/jq/.local/state/rotoxy/backups/retire-lightsprint-20261101T130408Z/`.
They contain private material and must not be committed. Restoring these files
would restore obsolete provider access; do so only on an explicit new operator
instruction, never as an automatic recovery action.

## Codex metadata observations

The existing official Codex App Server profile manager returned ChatGPT sign-in
metadata for seven profiles: five Plus and two Free. The four earlier Plus
profiles each reported 0% used in their five-hour window, with weekly usage of
13%, 27%, 1% and 36% at their respective checks. The newly added Plus profile
reported 100% in its five-hour window and a 16% weekly reading; its rate bucket
was exhausted and must not receive new work on that evidence. Free profiles
reported 30-day windows, not five-hour windows. These are timestamped observations,
not current balances. No inference turn was started by this metadata check.
Model catalogs are discovery metadata, not account execution entitlement.

## Source changes and remaining boundary

The active navigation, provider card/directory, routing pool control and credit
display no longer offer LightSprint. Its old session-provisioning paths return
410. Historical adapter/schema code remains to read and test old records; this
does not make the provider eligible for dispatch.

The Codex pool policy has no permanently primary account. It requires a resolved
per-session origin context and excludes that context's protected profiles from
quota-ranked worker candidates. It also checks account enablement and per-profile
concurrency. A separate task-fit predicate checks model/effort, complexity, fresh
known quota, and a conservative routine/Luna policy for Free workers.

This policy module is not a completed Codex execution scheduler. Remaining work
is the client-origin identity/lease broker, durable profile reservation, official
thread/turn launch, completion/approval event handling, and same-profile restart
reconciliation. Keep subscription dispatch disabled until those paths are wired
and a controlled task has returned a verified result. Do not expose signed-in
profiles as a working combined subscription inference API.

Delta was researched as an optional conversation/worktree synchronization
adapter; it was not installed and no project material was uploaded. See
`docs/research/2026-11-01-delta-and-account-orchestration.md` for sources and the
integration decision. Browser QA remains blocked by Work settings disabling
local browser use; rendered route and navigation tests supply narrower evidence.
