# Oracle search and model MCP interfaces

## Source change

The Oracle API source now defines two independent, Bearer-authenticated Streamable HTTP MCP endpoints:

- `POST /search/mcp` exposes `search_web` and `extract_url`.
- `POST /models/mcp` exposes `oracle_chat` for bounded, non-streaming completions on the fixed Oracle model allowlist.

Both endpoints reuse the existing REST handlers, request models, search/extraction concurrency semaphores, fixed search upstream, URL DNS/port/redirect checks, body caps, and inference node reservations. MCP tool arguments are validated by the same Pydantic request models. Search and extraction errors are returned as MCP tool errors with short API error details; unknown tools and malformed parameters use JSON-RPC errors. Search and inference remain separate MCP servers so a model client does not silently invoke search.

The supported protocol subset negotiates `2025-03-26`, `2025-06-18`, or `2025-11-25` during `initialize`, then handles `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. It is stateless and does not mint a session ID. POST replies use `application/json`; notification-only requests return 202 without a body. GET returns 405 with `Allow: POST`, which Streamable HTTP permits when the server does not offer an independent SSE stream. Batch POST bodies are bounded to eight messages. The endpoints require the standard Streamable HTTP Accept pair (`application/json, text/event-stream`) for POST and reject any `Origin` header because they are machine-to-machine bearer interfaces, not browser endpoints.

There is no MCP SDK dependency in this service. The small protocol surface is implemented directly over the existing FastAPI app to avoid importing an additional server/runtime stack. Interoperability tests exercise initialize, catalog discovery, tool dispatch, authentication, notification replies, Origin rejection, and malformed/unknown tool inputs over ASGI HTTP.

## Search and extraction safety

`search_web` accepts only a bounded query and result limit and always uses the configured private SearXNG service. It does not accept a backend URL or engine selector. `extract_url` routes through the existing `ExtractRequest` and `_safe_fetch` path: standard HTTP/HTTPS ports only, one DNS resolution with public-address checks, numeric-address connection, redirects disabled, accepted text content types only, and existing timeout and byte limits. Attempts to extract private addresses remain rejected.

Both REST and MCP requests use the same API Bearer token and per-token rate limiter. Tool execution therefore consumes the API's existing per-request rate budget and the existing search, extraction, or per-node inference capacity. MCP provides no separate or larger quota.

## Six-node model routing

The fixed source inventory now includes ora1 (`100.65.151.42`) for `deepseek-r1:1.5b` and `qwen3.5:2b`; ora3, ora5, ora6, ora7, and ora8 retain their configured model sets. The bounded Oracle chat route reserves one configured host per request, with one concurrent inference per host in this API process. This is source configuration for six eligible hosts, not proof of six simultaneous requests across API processes or other Oracle clients; shared leases are not implemented here.

The normal-size defaults on ora1 are `qwen3.5:2b` and `deepseek-r1:1.5b`. `qwen2.5-coder:3b` remains in the explicit model allowlist on its existing hosts; its reported actual parameter size is 3.086B, so it is above the normal 3B ceiling and is only run when explicitly named by the caller. The model tool has no implicit model selection or automatic completion loop.

The `gemma4:e2b` catalog entry remains limited to ora8. Direct read-only `/api/tags` metadata from ora8 reported `gemma4:e2b`, 4,587,156,505 bytes, 4.6B parameters, GGUF/Q4_K_M. This fits the stated 5B ceiling. `gemma4:e4b` is excluded (inventory reported 7.518B). ora1 does not receive either Gemma model.

## Verification

`python -m unittest discover -s scripts/oracle-api -p 'test_*.py' -v` passed all five MCP tests in a temporary virtual environment using the pinned `scripts/oracle-api/requirements.txt`. The search and inference upstream handlers were replaced with local fakes, while extraction exercised the real URL validation/dispatch path with a mocked fetch function; the private-address rejection check uses the real guard. The tests do not make paid model calls.

The existing six-host smoke script now expects `gemma4:e2b` in the model catalog and sends six harmless round-robin `qwen3.5:2b` checks to establish six distinct hosts when run against a deployment. That live smoke test was not run in this source-only task. No DNS, tunnel, deployment, container, or service restart was performed, so neither MCP endpoint is claimed live.

## Specification references

- [MCP Streamable HTTP transport, 2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports): endpoint POST behavior, Accept headers, notification 202 replies, GET 405 allowance, Origin and authentication security guidance.
- [MCP server tools, 2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/server/tools): tool schemas, `tools/list`, `tools/call`, and protocol versus tool error handling.
