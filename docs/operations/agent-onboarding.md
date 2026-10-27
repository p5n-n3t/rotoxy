# Agent onboarding

ROTOXY makes safe operational guidance available to any authenticated MCP client,
including a client working from a repository unrelated to the ROTOXY checkout.
It does not make credentials, projects, workers, or provider capacity globally
available merely because a client connects.

## What a connected agent receives

Clients with the `mcp` scope discover the read-only `rotoxy_guide` tool. It has
five short, versioned topics: `start`, `dispatch`, `recovery`, `providers`, and
`collaboration`. The collaboration topic explains the opt-in `shareMode: "fleet"`
and returned `shareHandle` workflow for one execution across authorized clients.
Local-only ROTOXY discovery also returns a compact equivalent instruction during
MCP initialization. The guide intentionally avoids account
identifiers, credentials, static balances and unsupported model claims.

The repository also distributes the optional `rotoxy-orchestrate` skill. Clients
that support installable skills can install it for deeper workflow guidance and
examples. MCP hosts control whether they load skills or server resources, so a
gateway connection cannot guarantee that a host has read a skill. Permissions,
budgets, affinity, retries and policy remain enforced by the backend.

## Required discovery sequence

1. Authenticate the exact client through the supported OAuth flow.
2. Call `tools/list` and `rotoxy_guide`.
3. When available, call `workspace_projects`; use only a project returned for
   that client.
4. Read live worker, job and incident state before dispatching work.
5. Use advertised tools and schemas only. Retain durable IDs and validate output
   artifacts before reporting completion.

An empty authorized-project list means the client needs membership from a ROTOXY
administrator. Project membership is explicit; it is not inferred from a local
folder, GitHub repository, email address or another client's authorization.

## Sharing one execution across agents

`workspace_dispatch` is private by default. The initiating agent can set
`shareMode` to `fleet` to create a bounded collaboration handle for that specific
job. It records the returned `shareHandle` in a durable workspace handoff; an
authorized Fleet client can pass that handle to `workspace_sync` to inspect its
status and bounded results without re-submitting work.

The share handle is not an invitation to a provider account. It does not change
the initiator's account/session affinity, reveal private instructions, grant
review approval, or allow a collaborator to issue a native provider message.
Keep it out of public commits, issues, and prompts. Fleet membership is checked
before any provider read, so a revoked client loses access immediately.

## Operational boundaries

- A provider catalog, connected account, or idle session is not proof of usable
  quota, model entitlement, capacity, or completion.
- `ACP_RELAY_DIED` overrides a provider's idle label and requires incident-aware
  handling.
- Workspace messages and notifications are durable ledger records. They do not
  prove native provider delivery or wake a dormant desktop/web conversation.
- A review approval records a review decision; it does not merge a pull request.
- Never replay an ambiguous mutating call. Reconcile the original work or leave
  an actionable handoff with job/task IDs, evidence and the next action.

See [the scenario reference](../../skills/rotoxy-orchestrate/references/scenarios.md)
for concrete flows.
