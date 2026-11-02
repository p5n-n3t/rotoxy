# ROTOXY completion contract

Approved by the operator on 2026-11-02. This is the current implementation
contract, not a claim that its features are deployed. Supersedes conflicting
older rollout plans; preserve their Git history and operator handoff files.
Execution status lives in `../implementation/2026-11-02-completion-ledger.md`.

## Outcome and constraints

One shared provider control plane across authorized clients and project folders.
Project IDs describe work, not separate copies of provider credentials. A release
is ready when another client discovers permitted resources, submits useful work,
receives validated outputs, handles a blocker, and reconnects without losing state.

- Keep the brand/theme; simplify navigation and compact the workflows.
- Quality first, then economy; maximum speed is an explicit alternative.
- No permanent primary ChatGPT account. Protect initiating accounts per client.
- No browser token extraction, unverified model entitlement, pooled quota fiction,
  blind replay, invented credits, or misleading completion percentages.
- Maximum two native agents including the parent. Prefer bounded third-party
  execution once its adapter is verified. Routine implementation: Sol medium;
  Luna/Claude assignments with explicit ownership and acceptance evidence.
- Paid verification allowance: $5 total estimated, no purchases/top-ups. Track
  subscription usage separately. Stop new paid dispatch at the allowance; estimates
  and CLI budgets are not guaranteed provider billing ceilings.
- Stop after the Astra architectural pass for the operator to change models.
- Before a new worker launch, reconcile ROTOXY-owned stale Claude/Node processes.
  Never use a process-name-wide kill or terminate unrelated applications.

## Gate 1: trustworthy runtime and retirement

One configuration resolver supplies startup, CLI, dashboard, workers and gateway
adapters. Preserve the existing stores. Absent retired upstream is valid;
malformed explicitly configured upstream remains invalid. Resource configuration
reads and writes must use the same resolved path as execution. Private-file
ownership/mode checks remain enforced.

Derive readiness from active registrations, not legacy credential totals. Report
configured/authenticated/execution-verified/unavailable/stale independently, with
last evidence and remedy. Distinguish source, built, installed and running version.

Retire LightSprint from active adapters, probes, onboarding, inventories, routing,
quotas, monitoring, UI, tools, current documentation and packaged agent guidance.
Operator chose historical runtime purge too. Implement exact-ID, previewed,
backed-up purge with linked-record checks; preserve unrelated or mixed-provider
work. See retirement decision below. Do not rewrite Git history or delete the
operator's untracked handoffs.

CLI and dashboard call the same services. CLI default: human-readable status,
tables where useful, meaningful times, terse remedies. Explicit `--json` supports
automation and `--verbose` adds diagnostics. Normalize wrapper error handling and
exit codes. `rotoxy endpoints` and UI use one directory.

## Gate 2: usable resource pools and endpoints

Generate endpoint entries from adapters plus actual configured capabilities:

| Route | Contract |
| --- | --- |
| `/mcp` | Shared jobs, collaboration and permitted tools |
| `/search/mcp` | Search-only OAuth resource |
| `/v1/models`, `/v1/chat/completions` | Compatible inference only |
| `/providers/{pool}/v1/...` | Pool-pinned compatible inference |
| `/providers/{pool}/mcp` | Pool-scoped tools where implemented |

Show protocol, auth type, URL, permitted operations/models, evidence age, readiness,
and copyable examples. A route backed by no executor is not an available endpoint.
Use stable provider IDs; user-facing names may change. Keep existing compatible
routes/IDs through aliases. Direct Bedrock inference and Claude Code jobs differ.
Admin passwords are never API keys.

Nebius uses the existing encrypted generic OpenAI-compatible provider store and
the operator-supplied HTTPS base `https://nebius.ziopsyop.tech/v1`. Never put its key
in docs, tests, worker prompts or version control. Discover exact model IDs; model
API exposure and orchestration eligibility are separate choices. Preserve saved
allowlists on refresh. Mark $50 as an operator-reported balance. Verify the custom
proxy separately from the official upstream; catalog success is not inference proof.

Cloudflare cancellation must propagate; preserve ambiguous outcomes. Task validation
must check output contracts. Current Node receipt overstates marker evidence, but
Python already rejects missing markers: do not remove that downstream protection.
Marker tests prove format, not semantic relevance. Diagnose generic canary replies
with bounded, newly identified operations; never replay prior failed paid work.

## Gate 3: genuine Codex and Claude execution

Extend the existing Python durable registry/outbox and TypeScript executor. Do not
force new adapters into the retired provider's task/session API.

Discriminate `agent`, `inference`, and `search` task kinds. Each adapter declares
launch, observe, cancel, resume, approvals, model/effort selection and quota support;
unsupported operations are explicit. Requested and reported models remain distinct.
Generic model APIs do not become coding agents merely by receiving a prompt.

Codex reuses isolated profiles and official App Server; Claude uses supported
programmatic execution and structured session events with the configured Bedrock
credentials. Preserve tools/permissions and isolated repository ownership.
Transport must distinguish client replies, server requests and notifications.
Handle server request IDs as opaque string/number values, maintain separate maps,
persist approval identity and resolution, and send each answer at most once.
Authentication/metadata discovery must not start agent work.

Persist task/attempt/generation, provider/profile, session/thread/turn, worker owner,
requested/reported model, execution receipt, artifacts, usage and pending decisions.
Success requires provider terminal success AND the task-specific output validator.
Transport receipt, idle state, process exit alone, or a final marker alone is not
proof of a valid coding artifact. Long task progress is durable events, not logs only.

## Gate 4: routing and Oracle growth

The planner decomposes objectives into bounded tasks with dependencies, capabilities,
output contracts and resource ceilings. Reuse supplied DAGs without another planning
call. A complex objective can use an explicitly selected capable planning resource;
the resulting DAG goes through ordinary deterministic validation before any launch.
Planner cannot grant permissions, add credentials or increase its own budget.

Deterministic eligibility order: user pins and required capability/model/effort;
authorization and origin protection; enabled/readiness/quota; capacity; quality
threshold; expected cost/latency; fairness among equivalent candidates. An impossible
pin is a blocker, not permission to substitute. Account rate limits are not grounds
to evade provider restrictions. Fairness applies between clients/jobs as well as hosts.

Oracle is one registry and two capabilities: compute and search. Use the existing
ora3 gateway; no additional general framework or per-node decision-model hierarchy.
Enrollment: trusted SSH alias, reachability, service/model inventory, policy/limits,
verification, then enable. Registered aliases are operator-managed; jobs cannot
submit arbitrary SSH targets or upstream URLs. Catalog lists unique eligible model
identities, preserving quantization/revision distinctions internally. Installed,
permitted and loaded are separate states. No hardcoded six-host restriction.

Default common family is the verified small-model catalog, normally <=3B. A 4-5B
specialist requires explicit selection; oversized models are ineligible everywhere.
Check loaded models and tasks before uninstalling prohibited models. Retain at most
one optional experimental decision service; no CPU Joey-1 deployment dependency.

Even mode balances independent chunks across eligible healthy hosts, preserves input
order and durable per-chunk output, and avoids duplicating non-idempotent work.
Adaptive mode uses model capability, queue, measured throughput and resource pressure.
Do not split arbitrary prose or promise linear speedup for dependent tasks.

Search uses the same nodes, private gateway and resource accounting. Retain guarded
HTTP extraction; add bounded robots-aware crawl frontier, deduplication, cancellation,
Markdown/structured extraction and evidence references. Existing Crawl4AI browser
rendering remains disabled until DNS/redirect/subresource egress isolation passes.
This is metasearch plus extraction, not a new independent Exa index.

## Gate 5: practical dashboard and client guidance

Six destinations: Overview, Jobs, Pools, Connections, Activity, Settings. Fold Fleet
controls into these destinations. Pools contains inference, agent and search
capabilities with suitable controls; these types must not be visually conflated.
Use compact cards, expandable details, model filters, real quota bars, task graphs,
timelines and routing explanations. Keep details and raw JSON behind disclosure.

Every menu link names its destination; no overview-anchor substitutes for unrelated
screens. Errors render inside the app shell with remedy. Monitor freshness uses
timestamps and configured cadence; no workers running is not supervisor failure.
Approvals differ from questions. Backend inbox/event handling survives the client;
unsupported chat wake-up remains an honest handoff, not a fake delivered turn.

2026-11-02 documentation update: supported ChatGPT Work/Cloud plugins now have an
official MCP Events subscription/webhook path. See [worker feedback](../architecture/worker-feedback.md).
Do not duplicate the implemented event service or bounded `job_wait`, and do not
extend this support claim to arbitrary chats or clients. A real subscribed client
reaction remains a separate acceptance gate from callback receipt.

Maintain MCP initialize instructions, `rotoxy_guide`, schemas/examples and optional
skill together. Clients do not automatically install local skills through MCP.

## Gate 6: release proof

Test configuration parity, migration isolation, endpoint auth/audience and pool
isolation, exact model selection, metadata vs inference readiness, real worker
execution/approval/cancel/recovery, origin changes, dynamic host enrollment, shared
resource limits, overlapping mixed work, dependency failure, long chunked work,
research provenance, reconnect and gateway restart without duplicate launch.

Built-in browser: desktop/mobile, keyboard/focus, every menu destination, compact
sign-in/model controls, actionable empty/error states and no scroll traps. Match
analytics to persisted events. Compare running commit to tested release manifest.
Prepare rollback before activation; no production success claim from local tests.

## Architectural decisions requiring continuity

### Durable authority and recovery

The Python registry owns task state, reservations, approvals and outbox. Node owns
provider I/O, never a second independent task scheduler. Reserve and enqueue in the
same SQLite transaction; operation IDs and generations fence replies. Persist intent
before external launch. Ambiguous sends retain reservations until read-only provider
reconciliation or operator disposition. Timeouts do not prove upstream stopped.
Provider observation and artifact validation are separate steps. Only verified safe
pre-send failure may retry automatically; policy-bounded explicit retry uses a new
attempt. Cancel acknowledgement is not terminal execution evidence by itself.

### Native-account protection

Bind authenticated client + initiating session to canonical account identity from
official account metadata or operator-selected profile. Multiple profiles of the
same provider identity are protected together. Never guess from an email label or
MCP OAuth client identity. Protect the union of active origin bindings. One client
cannot clear another client's binding. Native account changes invalidate pending
eligibility and require a new selection. Persist bindings across restart; expiration
marks the binding unresolved and blocks that client's subscription dispatch until
reconfirmed, rather than quietly making its account eligible. API/local work remains
available. No automatic native chat account switch or combined quota promise.

### Oracle capacity has one owner

The ora3 execution gateway owns per-host capacity for ALL public/direct and ROTOXY
compute/search routes. ROTOXY owns DAG state; its reservations are intent, not proof
of a free physical slot. Gateway durable operation IDs deduplicate dispatch and
expose execution status; node workers enforce their local resource ceiling as a
second guard. Start with one inference slot plus bounded extraction per host and
shared pressure limits. Do not keep separate bypass queues that directly call Ollama.
After restart, ambiguous node activity fences the slot until reconciled. Gateway
unavailability queues/blocks work; there is no direct-node bypass. Fairness/host
selection use this broker, without shared SQLite files over a network filesystem.

### Ownership before process cleanup

Persist launch UUID, task/attempt, executable realpath, PID, process start identity,
process group and owner. Before a new launch, reconcile an existing owned process.
Age or process name is not stale proof. If no recoverable live operation owns it,
gracefully terminate only the matching owned process group, wait a bounded interval,
then force-stop only with the same identity still confirmed. PID reuse, gateway
processes, user Claude sessions and unrelated Node services are never kill targets.
No blanket `pkill node`, `killall node`, or `pkill claude`.

### Retirement migration transaction boundary

Create an exact manifest from provider IDs/account/session relationships, never
substring deletion over arbitrary JSON. Classify mixed jobs and cross-provider
references first. Pause only affected legacy dispatch; refuse destructive migration
while unresolved external legacy work exists. Preview IDs/counts, backup consistent
SQLite stores and private config, then use an idempotent step journal because a set
of SQLite/JSON stores is not one atomic transaction. Delete linked child records,
remove legacy references in mixed records, preserve the valid sibling task graph,
then remove accounts/config. Do not retarget dependencies onto unrelated tasks.
Resume on journaled steps; verify no active legacy bindings and unchanged unrelated
records. Backups remain owner-private with explicit retention; do not delete rollback
evidence automatically. Git history and operator handoffs are not runtime records.
For permanently inaccessible retired accounts, the preview may record explicit
operator-authorized abandonment of unreconcilable work and its retained backup.
This is deletion authorization, never evidence that an upstream task was cancelled
or completed. It allows the requested purge without inventing provider state.

### Endpoint and scope isolation

The directory is an authenticated capability/readiness projection of existing stores.
Never expose account-private data in public unauthenticated discovery. Provider MCP
paths apply provider scope server-side; tool filtering alone is insufficient.
Protected-resource metadata/audiences match each advertised endpoint. Global and
provider-specific inference routes share model allowlists and credential brokerage.
API exposure, job eligibility and client authorization are independent controls.

## Evidence and research

- Source audited: `1081f424`; live runtime observed at `1c2c7e99` on 2026-11-02.
- CI run `41337400731`: completed successfully; not deployment proof.
- Doctor reproduced `config.invalid` for missing upstream; resource router uses
  `store.dir/web-tools.json` while execution accepts another configured path.
- Codex transport currently treats numeric IDs as ordinary pending replies; its
  extension must handle server-originated approvals without ID-map collision.
- Missing-marker Cloudflare results are already blocked by Python final validation
  (`supervisor/snooze/jobs.py`); do not regress this while fixing Node receipts.
- Official Codex App Server: https://learn.chatgpt.com/docs/app-server
- Official Claude programmatic execution: https://code.claude.com/docs/en/headless
- Nebius API: https://api.tokenfactory.nebius.com/docs
- Joey-1 model card: https://huggingface.co/baselabs/joey-1 (2B decision model;
  documented serving setup requires CUDA; CPU/Ollama deployment not verified).
