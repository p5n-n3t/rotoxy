# Bedrock inference and Claude Code workers — 2026-11-02

These are two interfaces over one AWS identity and billing capacity. Direct
Bedrock is Anthropic Messages inference; Claude Code is a bounded local agent.
Neither grants additional models or transferable subscription quota.

## Implemented interfaces

- `/providers/claude/v1/models`: operator-selected exact model IDs.
- `/providers/claude/v1/messages`: authenticated direct Bedrock inference using
  the existing scoped model token mechanism. Admin passwords are not API tokens.
- Main MCP `claude_workers`: enabled trusted runner profiles, models and capacity.
- Main MCP `claude_task_submit`: one queued workspace task, explicit profile/model,
  durable attempt before launch. Requires `jobs:write`.
- Main MCP `claude_task_status`: private owner-bound attempt/result, no execution.
- Main MCP `claude_task_cancel`: cancellation of an owned active child; ambiguous
  post-launch outcomes stay available for reconciliation. Requires `jobs:write`.

Create the task through `workspace_update` and retrieve the workspace revision
before updates. The worker publishes a review artifact; provider success does not
approve the artifact or merge code. The task remains `review` until an independent
reviewer acts. Private attempt results are not shared merely by Fleet membership.

This worker uses the existing Agent Workspace SQLite database and Claude attempt
table. The additive migration preserves old unowned attempts and refuses takeover.
No second scheduler, task database or credential registry is introduced. Duplicate
attempts never automatically relaunch. Interrupted attempts become ambiguous on
reconciliation and affected tasks are blocked rather than left falsely running.

## Policy and credential source

The current worker permits only Read, Glob and Grep, runs in an operator-approved
working directory, uses `--bare`, denies interactive permission prompts, and has a
one-process capacity limit. It supports read-only repository investigation and
review proposals. Autonomous code edits, arbitrary shell commands, background
subagents and native approval workflows are not enabled by this policy.

Each run has a $0.25 CLI budget setting and bounded timeout. This is not a
provider-guaranteed billing ceiling. Direct Bedrock and Claude Code share AWS
spending; do not sum their capacity as independent account allowances.

`ROTOXY_BEDROCK_CREDENTIAL_SOURCE` references the existing owner-private Claude
settings file. Only the supported AWS settings enter the adapters. Keys are not
copied into ROTOXY state or runner profiles. The source file was tightened to
owner-only permissions without changing credential values. Explicit process AWS
settings take precedence. Configure `ROTOXY_CLAUDE_BINARY`,
`ROTOXY_CLAUDE_WORKER_CWDS` and `ROTOXY_CLAUDE_WORKER_ENABLED=1` for worker exposure.

The three operator-permitted models are Opus 4.6, Sonnet 4.6 and Haiku 4.5. Use the
exact model IDs returned by discovery. Model selection is explicit, so no omitted
field silently chooses the most expensive option. Only Haiku was executed in this
verification; allowlisting the other models is not fresh entitlement proof.

## Live source-gateway evidence

Operation `bedrock-direct-haiku-20261102-a` invoked Haiku directly with SDK retries
zero and 32 maximum output tokens. Exact marker passed; AWS response reported
23 input tokens, 12 output tokens and `end_turn`.

Operation `claude-worker-bedrock-20261102-a` passed through the source gateway's
MCP submit/status path, the real SQLite attempt bridge, the trusted Claude profile,
and the actual Bedrock-backed Claude CLI. The exact marker was retrieved, the
reported model matched the requested Haiku ID, and a review artifact was created.
Claude reported $0.001626; that is CLI cost evidence, not an AWS billing receipt.
The workspace task reached review. No files were edited and no tools requested.

The same source gateway returned three catalog entries and passed an actual
`/providers/claude/v1/messages` request with a scoped model token, 18 reported input
and 11 output tokens. The short-lived token was revoked afterwards. These tests
used a temporary local gateway and a short-lived locally issued scoped JWT tied
to an existing registered OAuth client, not a new external client OAuth login.

Private receipts and budget reservations are under
`~/.local/state/rotoxy/verification/`. The conservative reservation for this worker
verification is $0.25, plus $0.01 for each bounded direct API test; these are
estimates. No top-up, purchase or ambiguous retry occurred.

## Feedback and remaining boundaries

Supported MCP Events clients can subscribe to `rotoxy.job.changed` with
`jobId="claude:<taskId>"` and the same project ID. Results ready for review emit
complete while the workspace artifact remains pending review. Delivery remains
owner-bound. Actual ChatGPT event subscription/reaction still requires client QA.

Claude workspace attempts are not yet main `job_submit` DAG tasks. Use their
advertised tools instead of passing these IDs to `job_status` or `job_wait`.
This implementation does not establish automatic native-chat resumption, full
mixed-provider planning, or code-editing worker policy. Existing Oracle and
Cloudflare DAG execution remains separate and unchanged.

## Installed release verification

Activated commit `7e4290d094a26a18f08236d0420ab8629feb7734` after
[CI 41510207022](https://github.com/p5n-n3t/rotoxy/actions/runs/41510207022)
passed: 741 Node tests on each of Node 22 and 24, 548 Python supervisor tests,
and the Oracle API job. The previous fixture-only CI failure is retained in the
ledger; the portable fixture fix is included.

The gateway process working directory and both CLI symlinks reference this
release. Public `/healthz` returned HTTP 200 after startup.
`rotoxy-cli endpoints` lists the Bedrock Anthropic Messages endpoint.

Operation `claude-worker-installed-20261102-a` then passed against the installed
gateway with its real authorization backend: trusted profile discovery, stored
workspace task creation, durable submit/status, actual Haiku execution, exact
result marker, matching reported model, and review artifact. Claude reported
$0.001566. Its direct catalog contained three selected models; the installed
Messages route also passed exact-result inference (18 input, 11 output tokens).
This used a temporary local scoped JWT for an existing registered OAuth client,
not a fresh external OAuth consent test. The temporary model token was revoked.
A test-harness argument validation failure occurred before task creation or launch;
the corrected harness used the same reservation after confirming no attempt existed.
No ambiguous provider operation was replayed. A separate $0.26 estimate was reserved
for this installed verification; the CLI limit is not a guaranteed billing ceiling.

The built-in browser reported local browser use disabled in Work settings. No
authenticated dashboard screenshot or actual ChatGPT event reaction is claimed.

Rollback material is private at
`~/.local/state/rotoxy/releases/rollback-7e4290d-1793647859/`: previous service
drop-in, CLI link targets, private configuration copies, and consistent SQLite
backups. To roll back code, restore that service drop-in and CLI links, then run
user-systemd daemon-reload and restart only `rotoxy-gateway.service`. Keep Funnel
and unrelated services unchanged. Do not overwrite current databases from backup
without reconciling work created after this release.
