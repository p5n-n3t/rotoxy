# Architecture

ROTOXY separates **API inference traffic** from **agent-worker delegation**.

## Data plane

```text
Client ── ROTOXY token ─► gateway :2025
                           │
                           ├─ provider pool ─► rotating accounts
                           │
                           └─ federated pool ─► provider/model targets
```

Providers own destination URLs, wire protocols, authentication rules, account lists, and policies. Provider pools rotate accounts. Federated pools rotate provider/model targets.

MCP servers live in a separate tool registry. Remote HTTP MCPs can be relayed through `/mcp/SERVER_ID`; stdio MCPs are launched through a ROTOXY wrapper that resolves their secret environment at runtime.

## Control plane

```text
~/.config/rotoxy/
├── config.json       routing, providers, pools, workers
├── secrets.env       provider API keys
├── token             ROTOXY client token
└── oauth/            isolated CLI profiles where supported

~/.local/state/rotoxy/
├── server.log
├── server.pid
├── usage-v2.json
└── worker-cursors.json
```

## Route precedence

1. default pool
2. URL route
3. ROTOXY routing headers
4. virtual-model selector
5. smart task/difficulty mapping when requested

Clients can therefore keep one stable URL while overriding individual requests.

## Compatibility

Providers declare a wire type such as `openai`, `anthropic`, `ollama`, or `google`. Federated pools reject incompatible wire mixtures rather than pretending every provider accepts the same request schema.

## Agent workers

Worker delegation is outside the inference data plane. ROTOXY launches supported CLIs in non-interactive/headless mode and returns their terminal result. A subscription OAuth session is treated as a worker identity, not as an API key.

## MCP tool plane

```text
Agent MCP client
   ├─ HTTP → ROTOXY /mcp/SERVER → upstream HTTP MCP
   └─ stdio → rotoxy mcp stdio SERVER → local MCP process
```

The MCP tool plane is deliberately independent from model routing. A model provider answers inference requests; an MCP server exposes tools/resources/prompts.
