# Changelog

## 2.1.0

- MCP registry with Streamable HTTP and stdio transports.
- Built-in Mem0, Exa and Firecrawl presets plus generic/custom MCP configuration.
- Live MCP `tools/list` inspection through the official MCP TypeScript SDK.
- Protected `/mcp/SERVER` HTTP relay that keeps upstream MCP credentials inside ROTOXY.
- Secret-safe stdio wrapper for local MCP servers.
- Per-worker/client MCP assignments and native sync adapters for Codex, Claude Code and Copilot CLI.
- MCP configuration integrated into the main `rotoxy configure` menu.

## 2.0.0

- Multi-provider configuration and provider pools.
- Federated same-model cross-provider pools.
- One-URL provider switching.
- Task-category and difficulty smart routers.
- ROTOXY virtual-model and URL routing selectors.
- OpenRouter free-only policy.
- Human-readable colored terminal output with explicit `--json`.
- Per-provider/account/model/pool usage tracking.
- Local agent CLI detection, delegation and fan-out.
- Conservative OAuth/subscription worker profiles without credential scraping.
- Optional Tailscale named Services layout.
- Interactive v2 installer and configuration UI.
- Expanded documentation, CI and automated routing tests.

## 1.0.0

- Ollama Cloud account-key round-robin proxy.
- Tailscale Serve/Funnel exposure.
- ROTOXY client-token authentication.
- Per-account usage meter.
