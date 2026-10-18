# ACP as a backend bridge for the ROTOXY workspace UI

Verified 2026-10-18 against the official ACP spec, SDK repositories, agent adapter repositories, and ROTOXY's existing Node 22+/TypeScript/Express plus Python Snooze layout.

## Recommendation

Use **ACP v1 from the ROTOXY Node service as a backend client**, launching each supported ACP agent adapter as a supervised stdio subprocess. Keep the existing browser dashboard API as the browser-facing boundary: browser requests and subscribes through authenticated ROTOXY endpoints; the Node process maps them to ACP JSON-RPC and maps ACP session updates back to ROTOXY events/SSE. Do not expose raw ACP stdio, arbitrary agent launch parameters, or an unauthenticated ACP listener to the browser.

For an initial build, the official TypeScript package `@agentclientprotocol/sdk` is the closest fit. Use its stable v1 entry point and current fluent `client()` API, including handlers for `sessionUpdate` and `requestPermission`. Its v2 API is explicitly draft and requires an experimental import; avoid it for durable persisted sessions. The ACP v1 transport spec lists stdio as the defined transport and says agents/clients should support it; Streamable HTTP is still a draft proposal. The TypeScript SDK changelog also identifies Streamable HTTP and WebSocket support as experimental. A browser-facing ROTOXY SSE/WebSocket layer is its own app transport, not an ACP transport claim.

Keep ACP session transport separate from MCP tool capability. ACP is how ROTOXY's client process exchanges session, prompt, update, cancel, and permission messages with an agent. MCP is a separate tool-server protocol that an agent may use. Supplying MCP server configuration is optional and capability-negotiated; it is not required to use ACP sessions. Do not use “MCP connected” as a proxy for “ACP session connected,” or vice versa.

## SDK and adapter fit

| Component | Status and license | Practical use |
|---|---|---|
| [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) | Official; Apache-2.0. Stable `@agentclientprotocol/sdk` entry point supports v1. `experimental/v2` is draft and may change incompatibly. | Use in Node as ACP **client**. Register typed handlers for agent updates and permission requests, connect over stdio streams, and use generated protocol types/helpers instead of hand-writing JSON-RPC framing. Avoid deprecated connection classes; current README uses `client()` and `connectWith()`. |
| [ACP Python SDK](https://github.com/agentclientprotocol/python-sdk) | Official; Apache-2.0. Python asyncio client/agent support, generated Pydantic schema models, stdio JSON-RPC plumbing, and examples for streaming/permissions. | Good if Snooze later needs to become the ACP client or if implementing an ACP-native Python worker. For the present browser dashboard, it would add a second ACP session owner and a Node↔Python bridge; prefer Node ownership and keep Snooze as durable supervisor. The repo describes release schema tracking, but its public README does not label a separate v2 API stable; use only documented v1 interfaces until verified. |
| [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp) | Official ACP project adapter; Apache-2.0. Wraps the Claude Agent SDK as an ACP stdio agent. | Reusable adapter pattern and ready path for Claude sessions. Permission requests, tool calls, child transcript updates and MCP status are translated by the adapter. Check auth/model/tool configuration against the installed adapter version. |
| [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp) | Official ACP project adapter; Apache-2.0. ACP stdio server wraps Codex App Server operations. | Ready path for Codex CLI sessions; adapter translates ACP requests/events and supports auth methods. Persist its ACP session ID; do not assume the ACP conversation ID is the same thing as a ROTOXY job or provider-side process ID. |
| [OpenCode ACP server](https://github.com/anomalyco/opencode) | OpenCode project; MIT. Exposes `opencode acp` over stdio NDJSON. Its normal server/client APIs are also available but are OpenCode-specific. | Treat as a separately tested ACP agent executable. Use its published `acp` command for interoperability; don't bind the UI to OpenCode's private APIs unless a deliberate provider-specific adapter is wanted. |

ACP is designed around editor/client ↔ coding-agent interaction. These adapters demonstrate useful interoperability but do not guarantee equal support for every ACP method, mode, permission policy, session list/resume behavior, image, terminal, or extension. At initialization, persist the peer's advertised protocol version and capabilities and gate UI actions on those capabilities.

## Small integration boundary

1. **Agent profile:** allowlisted adapter ID, executable/package version, fixed launch arguments, controlled environment, supported auth mode, and permitted workspace roots. Do not accept a binary path or arbitrary arguments from a browser request.
2. **Session mapping:** persist a ROTOXY conversation ID to `{adapter_id, adapter_version, acp_protocol_version, acp_session_id, cwd/workspace_id, capabilities, created_at, last_seen_at}`. Keep this separate from Snooze job/worker IDs and provider process IDs. A session ID is an opaque agent-owned identifier; resume/list availability is capability-specific. If the child exits, retain the mapping and mark availability unknown until a reconnect/list/resume result proves otherwise.
3. **Ordered event bridge:** map ACP `session/update`, prompt completion, errors, cancellation, and permission requests into ROTOXY's existing event stream with a stable sequence number and source IDs. Store enough events/state to reconnect the browser after a refresh without relying on transient in-memory stream chunks. Keep adapter payload/raw event fields for diagnostics where safe.
4. **Permission mediation:** surface ACP `requestPermission` as a pending, session-scoped ROTOXY action. Require an explicit authenticated user decision, bind the decision to that pending request and exact action/input, and return the protocol response to the same live ACP connection. Never interpret UI delivery/timeout as consent. On lost connection, record the pending approval as interrupted/unknown and do not replay approval to a fresh session.
5. **Workspace and process controls:** launch only server-selected agents in validated workspace roots; scope environment and secrets; bound output/message size and process count; capture stderr separately from protocol stdout; terminate/cancel through ACP where available and report process exit as a distinct observed fact. Agent file/tool permission is not equivalent to Snooze's job approval or stop state.

## ACP is not MCP

| Concern | ACP | MCP |
|---|---|---|
| Purpose here | Browser-facing ROTOXY backend acts as a client of an agent session. | An agent or ROTOXY host discovers/calls tools exposed by MCP servers. |
| Typical channel | v1 stdio JSON-RPC subprocess; Streamable HTTP proposal remains draft in ACP transport docs. | MCP's own transports and session lifecycle, configured independently. |
| Main operations | Initialize, create/load session, prompt, receive updates, cancel, answer permission request. | List/call tools and exchange resource/prompt capabilities with an MCP server. |
| Ownership | ROTOXY maps user conversation to agent-owned ACP session ID. | Agent/client owns its MCP server connections and tool capability scope. |

ACP v2 session setup includes optional MCP server configuration and capability negotiation. That does not merge the protocols: one ACP agent session can exist with no client-provided MCP servers, and MCP tool reachability does not establish that an ACP agent session is resumable. Keep MCP server policy/credentials out of the ACP session ID mapping except for an explicit, separately authorized configuration reference.

## Phased practical path

- Start with one Node-owned ACP v1 client runner using the official TypeScript SDK and one adapter at a time. Exercise `initialize → session/new → prompt → updates → cancel/complete`; add permission mediation before enabling tools that can modify a workspace.
- Add the browser bridge over existing ROTOXY auth and event APIs, then persist conversation-to-ACP-session mappings and reconnect behavior.
- Add Claude, Codex, and OpenCode as distinct allowlisted adapter profiles; show each adapter's negotiated features, auth state, and resume support in the dashboard.
- Keep ACP v2 and ACP-over-HTTP/WebSocket out of the compatibility baseline until their spec/SDK status is stable and the chosen agents advertise matching support.

## Official sources

- ACP v1 transport status and stdio rules: https://agentclientprotocol.com/protocol/v1/transports
- ACP protocol overview, v1 and v2 draft navigation: https://agentclientprotocol.com/
- TypeScript SDK README/API recommendation and v2 warning: https://github.com/agentclientprotocol/typescript-sdk
- TypeScript SDK release notes (v1.0 stable release, experimental transport/v2 changes): https://github.com/agentclientprotocol/typescript-sdk/releases
- Python SDK README, generated schema, stdio, helpers, Apache-2.0: https://github.com/agentclientprotocol/python-sdk
- Claude Agent SDK ACP adapter: https://github.com/agentclientprotocol/claude-agent-acp
- Codex App Server ACP adapter: https://github.com/agentclientprotocol/codex-acp
- OpenCode ACP command and stdio docs: https://github.com/anomalyco/opencode
- ACP v2 optional MCP server setup/capability requirements: https://agentclientprotocol.com/protocol/v2/session-setup

License/status claims are from the linked official repository pages and docs checked 2026-10-18. The exact latest adapter feature set is release-dependent; pin and inspect versions before implementation. No packages were installed for this research.
