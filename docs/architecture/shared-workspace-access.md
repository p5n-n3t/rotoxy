# ROTOXY Fleet access

ROTOXY has one provider Fleet/control plane. Repository, folder, and project names are task context for a job, not separate provider workspaces or provider entitlements. The durable internal ID `token2oauth` remains a compatibility key for existing OAuth grants, jobs, and session ownership; user-facing UI calls it **ROTOXY Fleet** without migrating jobs, tasks, or historical records.

Fleet access does not merge project data. A job still records its repository, scope keys, owner, budget, artifacts, and durable event ledger. Semantic memory is kept project-context scoped, with a separate ROTOXY operations memory; credentials, private prompts, and raw provider output do not go into either memory store.

## One-time OAuth consent

An operator may opt in by adding to the private supervisor.json root:

    "sharedWorkspace": { "projectId": "token2oauth", "membership": "consented_oauth" }

This configuration requires an existing project ID. Admission requires an OAuth client issued by this gateway with an unexpired refresh grant containing the MCP scope. Registered but unconsented clients are not admitted. The ordinary MCP middleware still verifies signed access tokens, issuer, audience and read/write tool scopes. Other projects retain explicit client memberships. Resources and private results remain bounded to the verified caller.

The gateway re-reads the private supervisor policy on authorization so an external permission edit or revocation is effective without restart. Invalid policies fail closed. An OAuth client whose consent grant has expired or been revoked loses automatically granted access. The admin access page distinguishes inherited access from legacy explicit grants. The shared policy can be removed without rewriting any historical project or account data.

## Endpoint roles

- /mcp: main authorized agent workspace and resource-dispatch tools. A client may use it from any folder or from ChatGPT Web, Desktop or CLI.
- /providers/<id>/v1 and /pools/<id>/v1: equivalent provider-pinned OpenAI-compatible model APIs, subject to ROTOXY model token scopes and model namespace validation. Providers never spill into another adapter.
- /providers/claude/v1/messages: separate Anthropic Messages inference API backed by locally configured Amazon Bedrock credentials.
- /pools/<id>/mcp is NOT a supported gateway endpoint. Do not represent it as fully implemented.

## Provider limitations

The main durable job scheduler currently runs registered LightSprint sessions; it does not automatically dispatch every Ollama, Bedrock, Oracle, or Codex profile. Oracle has separate MCP tools. Claude Code under Amazon Bedrock is a local CLI worker, not a transferable cloud login. The shipped bounded Python Claude Code worker has a durable attempt ledger and a per-task budget limit, but is not yet connected to the heterogeneous workspace_dispatch scheduler. Do not export values from the user's local Claude settings or claim a direct Bedrock Messages call executes Claude Code tools.

Do not remove credit limits, consent checks, result ownership, or authorization errors to make provider counts look bigger. Test configured, live execution rather than inferring availability from model/account catalogs.
