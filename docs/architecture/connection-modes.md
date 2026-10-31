# ROTOXY connection modes

## Workspace orchestration

The canonical `/mcp` endpoint is the agent control surface. An orchestrator uses durable tasks, messages, artifacts, reviews and provider adapters. A CLI agent, cloud workspace and inference model are different resource capabilities; a provider adapter must describe which it implements.

Session resource selection must be an explicit allowlist, intersected with the authenticated client's permissions, project policy, available quota and configured execution limits. Selecting a provider does not authorize every account or premium model. An empty explicit selection must mean no eligible workers, never all workers. A child agent receives the parent's allowed resources or a narrower subset; it cannot broaden them. Persist the selection with the durable job so a reconnect cannot reset it. This is the required dispatch contract, not a claim that heterogeneous dispatch and its selection UI are complete.

## Direct provider use

Provider-pinned paths allow another program to use one pool without submitting a distributed job. The path fixes the provider; model selection and account pooling happen only inside that provider. It must not spill into another provider on quota errors, unsupported models, or outages.

Implemented inference surfaces use `/providers/<provider>/v1`. Supported OpenAI-compatible providers expose `models` and `chat/completions` using the existing model gateway key and its scopes. Model IDs remain namespaced to avoid ambiguity. The provider directory describes implemented protocols separately from configuration and live execution evidence.

The Bedrock Claude adapter uses `/providers/claude/v1/messages` with the Anthropic Messages request/response protocol. Its downstream key is a scoped ROTOXY model key, not an AWS key or the administrative password. AWS credentials remain server-side and are resolved through the configured AWS credential mechanism. This inference route does not launch Claude Code, execute its local tools, or inherit its MCP configuration. Claude Code worker execution belongs to workspace mode.

Codex and LightSprint are workspace/CLI capabilities, not HTTP inference routes. The opt-in Oracle adapter exposes `/providers/oracle/v1/models` and non-streaming `/providers/oracle/v1/chat/completions` through the fixed private Oracle gateway. It uses scoped ROTOXY model tokens and `oracle/` model IDs. The host must configure `ROTOXY_ORACLE_API_TOKEN_FILE` as an absolute owner-only file containing the separately authorized private gateway token. Missing configuration returns 503; unauthorized calls return 401. It does not grant shell execution, share MCP OAuth credentials or retry ambiguous inference failures. Private and public gateway acceptance evidence must be recorded separately.

## External client setup

Choose the protocol supported by the external program, then the matching ROTOXY provider base URL and an appropriately scoped model key. A program supporting Anthropic Messages can use the Claude/Bedrock route once that backend is configured and tested. A program supporting only MCP cannot consume a Messages endpoint as MCP, and the inverse also applies. Custom provider support in a named third-party application must be verified from that application's current documentation or a real connection test.

Keep one public host and Funnel. Provider paths are application routes within the same server, not additional Funnel instances. Existing OAuth issuer and resource binding remain canonical; inference model keys and MCP OAuth tokens are distinct credentials.
