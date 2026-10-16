# Agent CLI integration research — 2026-10-16

Official public docs reviewed 2026-10-16; no CLI/API execution, provider calls, local configuration, or secrets accessed. Evidence grades and claim-level source URLs are in the adjacent JSON. Grade A is official vendor documentation; B is official project documentation on mutable GitHub main/master.

## Three different roles

An **agent client** consumes MCP tools in a human-facing agent loop. An **agent runner** starts agent turns and owns tools, sessions, and lifecycle. A **model inference endpoint** forwards model requests without necessarily running an agent. OpenCode and Hermes have client and runner surfaces. Hermes separately documents its tool-using agent API and its inference-only subscription proxy. MCPO converts MCP tools to OpenAPI/REST; it is not inference. MCPO `use_loopback` means local OAuth browser callback, not an inference gateway.

## OpenCode

**Inventory without reading secrets.** `opencode models [provider] --verbose` lists configured provider models and cost metadata. Headless HTTP routes include `GET /config/providers` (providers/default models), `GET /provider` (all/default/connected providers), `GET /provider/auth` (available auth methods), and `/doc` (OpenAPI schema). CLI `opencode auth list` is documented. `PUT /auth/:id` writes credentials; do not use it for inventory.

**Execution and state.** `opencode run <prompt>` supports `--session <id>` or `--continue`; `opencode serve` starts the HTTP backend. Useful routes: `POST /session`, `GET /session/status`, `POST /session/:id/message`, `POST /session/:id/prompt_async`, `GET /session/:id/message`, `POST /session/:id/abort`; `GET /event` and `/global/event` are SSE. `POST /session/:id/permissions/:permissionID` responds to an agent/tool permission request, not a provider-native account approval. Server auth can use `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME`.

**MCP, auth, usage.** Configure local stdio or remote HTTP MCP in OpenCode config; `opencode mcp list` and `opencode mcp auth <name>` manage connection/OAuth. Keep tokens in the client; do not copy its auth file. `opencode stats` reports session token/cost statistics. Docs list specific subscriptions (including ChatGPT Plus and GitHub Copilot) but support is provider-specific. OpenCode’s provider docs state Anthropic prohibits the former Claude Pro/Max plugin integration, removed from the bundle since 1.3.0. No universal provider-quota endpoint was found.

## Hermes Agent (NousResearch)

**Headless execution.** `hermes -z <prompt>` is a scriptable one-shot; `--resume <session>` / `--continue` resumes a local session. `--provider`, `--model`, and `--usage-file` are documented; exit codes distinguish completion, partial/failure, interruption, and empty output. `hermes serve` is a headless JSON-RPC/WebSocket backend, separate from the API server.

**Agent API.** With `API_SERVER_ENABLED` and required `API_SERVER_KEY`, Hermes exposes a tool-using agent backend: `POST /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events` (SSE), and `GET /v1/capabilities`. Session REST includes `GET /api/sessions`, `GET /api/sessions/{id}/messages`, `POST /api/sessions/{id}/chat[/stream]`. Controls: `POST /v1/runs/{id}/stop`, `/approval`, `/clarify`. Stop is cooperative and remains tracked until execution exits; approval/clarification replies bind to the pending control identity. They do not approve unrelated provider operations. The API key grants broad tool access, including terminal commands; profile keys and access need strict isolation.

**Model/auth/usage.** `GET /api/model/options` (Bearer key) returns authenticated providers, curated models, capabilities, and prices. Normal reads probe only the selected custom endpoint; `?refresh=1` probes more broadly, so do not refresh on passive polling. `GET /v1/models` only advertises the Hermes agent alias. CLI `hermes model`, `hermes auth list/status`, and `hermes usage --json` are documented; usage windows cover OpenAI Codex, Anthropic OAuth, and OpenRouter when available. `hermes -z --usage-file` reports estimated per-run cost, tokens, API calls, model/provider, and auxiliary totals; these are not guaranteed spend caps. OAuth support does not settle provider subscription terms. `hermes proxy start` is distinct, model-only inference for documented OAuth upstreams (Nous Portal and xAI); it replaces the client bearer with the stored upstream credential and should remain local or separately protected.

**MCP.** `hermes mcp` manages local stdio/remote HTTP MCP clients; Hermes docs also list running Hermes as an MCP server. `hermes import-agent` can migrate Claude/Codex instructions and MCP config, but explicitly does not import API keys or credentials.

## LiteLLM

Database-backed model management requires `STORE_MODEL_IN_DB`. Documented routes: `POST /model/new`, `GET /model/info` (keys masked), `POST /model/update`, `POST /model/delete` (admin-only). The add example uses `LITELLM_MASTER_KEY`. `config.yaml` models remain file-owned; select one source of truth. `GET /health/liveness` and `/health/readiness` are process/dependency checks. `GET /health` sends test inference to configured models, costs a few tokens each, and accepts any valid key; it is not passive discovery. Authenticated health details can reveal endpoint URLs/errors.

## MCPO, loopback, and minimum integration

The official MCPO command is `mcpo --port … --api-key … -- <mcp-server-command>`; it wraps MCP tools (stdio or supported HTTP transports) with OpenAPI/REST and generated `/docs`. OAuth uses dynamic registration; `use_loopback` defaults on for a browser callback (callback port default 3030). This is tool transport/auth plumbing, not model routing.

Minimum safe design: a trusted local registration selects a fixed OpenCode/Hermes profile and runner, or explicitly configured API URL, plus owner-scoped session IDs. Read non-secret inventory only; never scrape credential files or let event data choose commands, sessions, models, or profiles. Keep agent launch, inference, MCP tools, stop/approval, provider login, and endpoint refresh as separate capabilities with explicit operator action. Store usage with provenance/time; absent quota is unknown. Protect runner APIs as privileged control planes.

## Unknowns

Docs do not establish a universal OpenCode quota endpoint or generic native-provider approval API. Subscription compatibility remains vendor-specific. Installed versions, local profiles, live provider reachability, entitlements, quotas, and real costs were not verified. Hermes custom-provider refresh may call configured endpoints. See the adjacent JSON for sources, exact endpoints, and evidence grades.
