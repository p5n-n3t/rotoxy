# MCP tool servers

ROTOXY treats Model Context Protocol servers as a **tool registry**, separate from model providers and model-routing pools.

## Supported transports

- **Streamable HTTP** for hosted/remote MCP servers.
- **stdio** for local MCP processes.

ROTOXY uses the official Model Context Protocol TypeScript SDK to connect to configured servers and inspect their tool catalogs.

## Presets

### Mem0

Hosted endpoint:

```text
https://mcp.mem0.ai/mcp
```

Add it:

```bash
rotoxy mcp add mem0
```

ROTOXY prompts for the Mem0 API key without echoing it and stores it in `~/.config/rotoxy/secrets.env`. The remote server is then available through the protected ROTOXY relay at `/mcp/mem0`.

Official Mem0 documentation: https://docs.mem0.ai/platform/mem0-mcp

### Exa

Hosted endpoint:

```text
https://mcp.exa.ai/mcp
```

Add and test it:

```bash
rotoxy mcp add exa
rotoxy mcp test exa
```

Official Exa MCP page: https://exa.ai/mcp

### Firecrawl

ROTOXY uses Firecrawl's official stdio package:

```text
npx -y firecrawl-mcp
```

Add it:

```bash
rotoxy mcp add firecrawl
```

The `FIRECRAWL_API_KEY` value remains in the ROTOXY secret store. Synced clients execute the server through `rotoxy mcp stdio firecrawl`, so the key is not baked into their MCP command.

Official Firecrawl MCP documentation: https://docs.firecrawl.dev/mcp-server

## Generic/custom servers

```bash
rotoxy mcp add custom
```

For Streamable HTTP, enter a URL and choose no authentication, bearer authentication, or a custom secret header.

For stdio, enter the command, arguments, and any secret environment variables required by the server.

## Commands

```text
rotoxy mcp list [--json]
rotoxy mcp add [mem0|exa|firecrawl|custom]
rotoxy mcp test SERVER
rotoxy mcp tools SERVER
rotoxy mcp remove SERVER
rotoxy mcp assign SERVER TARGET
rotoxy mcp unassign SERVER TARGET
rotoxy mcp sync codex|claude|copilot|all [SERVER]
rotoxy mcp export [CLIENT]
rotoxy mcp endpoint SERVER
```

`test`/`tools` performs an actual MCP connection and `tools/list`; it is not a decorative TCP ping pretending to understand MCP.

## Remote HTTP relay

Every enabled remote HTTP MCP has a ROTOXY relay path:

```text
/mcp/SERVER_ID
```

Example:

```text
https://your-rotoxy-node.example/mcp/mem0
```

The flow is:

```text
MCP client
   │ ROTOXY client token
   ▼
ROTOXY /mcp/mem0
   │ Mem0 API key injected here
   ▼
https://mcp.mem0.ai/mcp
```

ROTOXY preserves MCP protocol/session headers and streams the upstream response, including SSE where the upstream server uses it.

## stdio wrapper

For local MCP processes:

```bash
rotoxy mcp stdio SERVER
```

This is primarily an internal command used by synchronized clients. ROTOXY resolves secret environment references and launches the configured MCP server with stdin/stdout attached transparently.

## Assignments

Assignments describe which MCP servers belong to which local worker/client profile:

```bash
rotoxy mcp assign mem0 codex
rotoxy mcp assign exa claude
rotoxy mcp assign firecrawl '*'
```

`*` is a global assignment. When no assignment exists for a supported client, `mcp sync` defaults to the full registry so first-time setup remains simple.

## Native client sync

Current native sync adapters:

- Codex CLI
- Claude Code
- GitHub Copilot CLI

ROTOXY uses each client's own MCP-management command rather than manually guessing its config-file format.

For remote HTTP MCPs, the client is pointed to the **local ROTOXY relay**, not directly at the upstream provider. Claude/Copilot store the rotatable ROTOXY client credential; Codex uses the `ROTOXY_CLIENT_TOKEN` environment variable, which ROTOXY automatically supplies to Codex workers it launches.

Other MCP clients can use:

```bash
rotoxy mcp export
```

as a standard configuration template.

## Security

MCP upstream keys use the same secret boundary as provider keys:

```text
~/.config/rotoxy/secrets.env
```

The MCP registry in `config.json` stores only secret **references**, not secret values.

Removing an MCP server also removes its ROTOXY-managed secret if no remaining provider/MCP configuration references it.
