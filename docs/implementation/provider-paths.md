# Direct provider paths

ROTOXY exposes provider-pinned inference paths for clients that need a conventional model API instead of the multi-agent workspace tools:

| Path | Protocol | Model IDs |
| --- | --- | --- |
| `/providers/ollama/v1` | OpenAI-compatible chat completions | `ollama/<model>` |
| `/providers/cloudflare/v1` | OpenAI-compatible chat completions | `cloudflare/<account-model>` |
| `/providers/openai/v1` | OpenAI-compatible chat completions | `openai/<model>` |
| `/providers/openrouter/v1` | OpenAI-compatible chat completions | `openrouter/<model>` |
| `/providers/custom-<24-char-id>/v1` | Configured OpenAI-compatible endpoint | `custom-<exact-id>/<model>` |

Each path reuses the existing `/v1/models` or `/v1/chat/completions` implementation, so the normal ROTOXY scoped bearer token remains required (`model:read` for catalogs and `model:invoke` for calls). Model catalogs are filtered to the selected provider, and invocation rejects a model whose prefix does not match the selected path. A rejected provider/model combination never reaches another adapter as fallback. Catalog requests currently use the unified catalog implementation; that implementation may refresh the Ollama model list while serving a different provider's catalog, but it does not send inference to another provider.

`GET /providers` returns a static capability directory. It does not expose custom provider IDs, account labels, credential state, secrets, or usage; it publishes only the custom path template. Each configured custom provider automatically uses its exact opaque ID in the direct path and model prefix. IDs are case-sensitive and are never normalized, so the route and model prefix must preserve the provider ID returned by ROTOXY.

The `claude` entry points to the separate opt-in Anthropic Messages adapter at `/providers/claude/v1/messages`; its availability depends on that adapter and operator-configured Bedrock credentials. Claude Code is a local CLI agent and does not itself provide a model inference HTTP endpoint. LightSprint remains a workspace-job integration, and Oracle pool inference remains unavailable on these direct paths until a dedicated adapter is mounted.

The path middleware must be mounted before the unified model API. Provider-specific routers that own paths such as `/providers/claude/v1/messages` should be mounted before this middleware; it deliberately delegates the `claude` namespace so that the dedicated adapter owns its native protocol.

This feature does not expose distributed jobs, agent-to-agent coordination, Codex profile dispatch, Claude subscription access, or workspace supervision. Those are separate workspace-mode capabilities.
