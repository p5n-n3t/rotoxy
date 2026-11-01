# Delta and dynamic account orchestration

Verified against official documentation on 2026-11-01. This is an integration
decision, not an implementation or execution claim.

## Delta's useful boundary

[Delta's CLI](https://delta.dev/docs/cli/get-started) manages conversations and
worktrees. Its [coding-agent plugin contract](https://delta.dev/docs/cli/build-a-plugin)
provides append/watch operations, child references, turn ownership and restart
handling. This is useful for an optional shared conversation surface in ROTOXY.
The documented client remains responsible for running its agents. Delta is not
the provider-account scheduler or a mechanism for extending a native chat's
subscription quota.

Adopt these concepts in ROTOXY's own durable workspace: stable event identity,
acknowledged delivery, parent/child attribution, explicit ownership, reconnect
deduplication and isolated worker changes. A future Delta adapter should use its
versioned CLI contract, with explicit user-selected conversation/file sharing.
Do not scrape its private storage or export all project files by default.

The published [reference plugin](https://github.com/zed-industries/delta-claude)
is AGPL-3.0. No code was copied. Do not vendor its implementation into this MIT
repository without resolving license compatibility and distribution obligations.
An independent adapter using documented commands is the proposed boundary.
No Delta software was installed and no conversation or files were uploaded.

## Account orchestration decision

Use ROTOXY's existing official Codex App Server profiles and isolated CODEX_HOME
directories. [OpenCodex](https://github.com/lidge-jun/opencodex) confirms that its
account pool routes new sessions with quota-aware policies; that is a useful
reference, not proof that quota can be combined or that its request failover is
safe for durable worker operations.

The [official App Server](https://learn.chatgpt.com/docs/app-server) provides
account/model/rate-window metadata and thread/turn execution. ROTOXY must bind
each task to its selected profile, thread and turn, preserve ownership, and
reconcile ambiguous starts before another attempt. A five-hour or weekly usage
percentage remains a measurement of one reported bucket on one account.

No account is permanently primary. Protect the account used by each initiating
client/session; the same profile may be a worker for another session when the
operator permits it. Account identity must be resolved through a supported
client binding, not inferred from generic MCP OAuth. Unknown origin identity
blocks automatic subscription dispatch while independent Oracle/API resources
can remain eligible. ROTOXY cannot transparently change the account or quota
used by the native ChatGPT Desktop conversation. Native fallback is a handoff or
continued native turn, not an automatic credential switch.

For simultaneous native clients, the scheduler should protect the union of
their active origin-account leases unless the operator explicitly allows worker
sharing. Closing a client or changing sign-in must expire or replace its lease;
it must not permanently reserve an account. The current policy filter accepts
multiple protected IDs, but the client identity/lease broker and execution
scheduler are still required integrations, not implemented by that filter.

Routing order: capability and tool requirements; task complexity and requested
model/effort; account permissions and protected origin; fresh reported quota;
available capacity; expected latency and cost; fairness among equivalent
candidates. Oracle/Ollama inference is suited to bounded routine text work;
search/extraction is a separate capability, not a coding agent. Cloudflare and
other model APIs remain subject to their own credentials and measured limits.

Five Oracle VMs are not required to use five Codex accounts: inference runs in
OpenAI's service, while the official Codex clients run locally or in isolated
remote execution environments. Remote VMs are valuable for sandboxed tools and
repositories, not additional subscription quota. Do not clone auth files onto
VMs; use each worker's official sign-in flow when remote workers are provisioned.
