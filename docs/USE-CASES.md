# Use cases

## Stretch one provider across multiple accounts

Configure several API keys under one provider. ROTOXY round-robins requests and temporarily cools down accounts that return 429, 401, or 403.

Typical fit: Ollama Cloud accounts behind one endpoint.

## Change providers without reconfiguring clients

Keep the client pointed at the same ROTOXY URL and run:

```bash
rotoxy provider use PROVIDER_ID
```

Useful when testing quality, latency, availability, or account limits.

## Use the same model through several providers

Create a federated pool and map each provider to its own model ID. This works best when the providers share an API wire protocol.

Use round-robin for balancing, random for loose distribution, or failover when one provider should be preferred.

## Task-aware model selection

Map coding to a coding model, research to a long-context/research model, vision to a multimodal model, and routine extraction to a cheaper/faster model.

The classifier is local and deterministic. Inspect it with `rotoxy classify` before enabling mappings.

## Difficulty-aware model selection

Map routine jobs to a fast model, medium work to a balanced model, and hard reasoning/orchestration to a stronger model.

## Free OpenRouter fallback

Use the OpenRouter preset with `openrouter/free` or an explicit `:free` model. ROTOXY's OpenRouter policy rejects non-free model IDs.

## One main agent, several subscription workers

A shell-capable main agent can delegate work through:

```bash
rotoxy delegate --pool subscriptions --prompt "..."
```

or fan the same job out:

```bash
rotoxy fanout --pool subscriptions --prompt "..."
```

This is useful for independent reviews, research branches, code audits, or long-running parallel analysis.

## Private AI gateway over Tailscale

Use Tailscale Serve to keep the endpoint inside the Tailnet while retaining a stable HTTPS endpoint and ROTOXY's own client token.

Use Funnel only when the client cannot join the Tailnet and a public endpoint is actually necessary.

## Shared MCP tools across local agents

Register Mem0, Exa, Firecrawl, or a custom MCP server once in ROTOXY, test its tool catalog, then assign/sync it to Codex, Claude Code or Copilot. Remote API keys remain in the ROTOXY secret store instead of being copied into every agent configuration.
