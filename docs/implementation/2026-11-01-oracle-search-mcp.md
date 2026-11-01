# Oracle search and model MCP interfaces

## Source change

The Oracle API source now defines two independent, Bearer-authenticated Streamable HTTP MCP endpoints:

- `POST /search/mcp` exposes `search_web` and `extract_url`.
- `POST /models/mcp` exposes `oracle_chat` for bounded, non-streaming completions on the fixed Oracle model allowlist.

Both endpoints reuse the existing REST handlers, request models, search/extraction concurrency semaphores, fixed search upstream, URL DNS/port/redirect checks, body caps, and inference node reservations. MCP tool arguments are validated by the same Pydantic request models. Search, extraction, invalid tool arguments, and upstream failures are returned as MCP tool errors with short API error details; unknown tool names and invalid JSON-RPC parameters use JSON-RPC errors. Search and inference remain separate MCP servers so a model client does not silently invoke search.

The supported protocol subset negotiates `2025-03-26`, `2025-06-18`, or `2025-11-25` during `initialize`, then handles `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. It is stateless and does not mint a session ID. POST accepts one JSON-RPC message per request; batches are rejected with HTTP 400. Request IDs must be strings or integers (not booleans or null), and `params`, when present, must be an object. Notifications with an `id` are invalid. POST replies use `application/json`; notification-only requests return 202 without a body. GET returns 405 with `Allow: POST`, which Streamable HTTP permits when the server does not offer an independent SSE stream. The endpoints require the standard Streamable HTTP Accept pair (`application/json, text/event-stream`) for POST and reject any `Origin` header on both POST and GET because they are machine-to-machine bearer interfaces, not browser endpoints. If an `MCP-Protocol-Version` header is present on POST or GET, it must match one of the supported versions or the server returns HTTP 400. Omission remains accepted for backwards compatibility.

There is no MCP SDK dependency in this service. The small protocol surface is implemented directly over the existing FastAPI app to avoid importing an additional server/runtime stack. Interoperability tests exercise initialize, catalog discovery, tool dispatch, authentication, notification replies, Origin rejection, and malformed/unknown tool inputs over ASGI HTTP.

## Search and extraction safety

`search_web` accepts only a bounded query and result limit and always uses the configured private SearXNG service. It does not accept a backend URL or engine selector. `extract_url` routes through the existing `ExtractRequest` and `_safe_fetch` path: standard HTTP/HTTPS ports only, one DNS resolution with public-address checks, numeric-address connection, redirects disabled, accepted text content types only, and existing timeout and byte limits. Attempts to extract private addresses remain rejected.

Both REST and MCP requests use the same API Bearer token and per-token rate limiter. Tool execution therefore consumes the API's existing per-request rate budget and the existing search, extraction, or per-node inference capacity. MCP provides no separate or larger quota.

## Six-node model routing

The fixed source inventory now includes ora1 (`100.65.151.42`) for `deepseek-r1:1.5b` and `qwen3.5:2b`; ora3, ora5, ora6, ora7, and ora8 retain their configured model sets. The bounded Oracle chat route reserves one configured host per request, with one concurrent inference per host in this API process. This is source configuration for six eligible hosts, not proof of six simultaneous requests across API processes or other Oracle clients; shared leases are not implemented here.

The normal-size defaults on ora1 are `qwen3.5:2b` and `deepseek-r1:1.5b`. `qwen2.5-coder:3b` remains in the explicit model allowlist on its existing hosts; its reported actual parameter size is 3.086B, so it is above the normal 3B ceiling and is only run when explicitly named by the caller. The model tool has no implicit model selection or automatic completion loop.

The `gemma4:e2b` catalog entry remains limited to ora8. Direct read-only `/api/tags` metadata from ora8 reported `gemma4:e2b`, 4,587,156,505 bytes, 4.6B parameters, GGUF/Q4_K_M. This fits the stated 5B ceiling. `gemma4:e4b` is excluded (inventory reported 7.518B). ora1 does not receive either Gemma model. MCP `oracle_chat` preserves the upstream `finish_reason` and `usage` fields, including `finish_reason: "length"` so truncation is visible to clients. It rejects unexpected model arguments and empty or oversized prompts.

## Safe multi-node extraction

Read-only host inventory on 2026-11-01 found six reachable nodes, each with 4 vCPU and about 24 GiB total RAM (about 20–22 GiB available when sampled). Crawl4AI 0.9.2 containers existed on ora1, ora3, and ora5 only. All three were healthy under a 4 GiB container memory limit (sampled at 165, 488, and 318 MiB); their API port is exposed on localhost and the Tailnet address. ora6, ora7, and ora8 had no Crawl4AI service. The browser service has no verified DNS pinning, redirect denial, or subresource egress policy in this inventory, so Oracle extraction does not dispatch to it.

Source now includes `safe_extraction_worker.py`, a lightweight worker that calls the existing `_safe_fetch` implementation. It validates the requested destination on the worker node, resolves and pins a public numeric address, follows no redirects, executes no JavaScript, and fetches no subresources. It requires the existing Oracle API Bearer token, exposes an authenticated capacity-aware `/health`, and allows one active extraction per worker. The API probes the fixed six-node allowlist, skips busy or unhealthy workers, selects healthy workers round-robin, and falls back to its own guarded fetch only when no worker is available before dispatch. After dispatch begins, it does not retry elsewhere if the response is ambiguous. The API's existing two-slot extraction semaphore remains the aggregate per-process limit, even after workers are deployed; each host is separately limited to one active worker call. Until separate deployment, missing worker services are treated as unhealthy and requests continue through the guarded local fallback. Results carry both `source_host` and `worker_id` in JSON and corresponding response headers.

`docker-compose.extraction-worker.yaml` binds worker port 8878 to localhost and Tailnet only, caps each worker at 512 MiB and 0.5 CPU, drops Linux capabilities, and mounts the existing token file read-only. `deploy-extraction-workers.sh` is dry-run by default. With explicit `--execute`, it transfers the existing token over SSH stdin to the same `/etc/oracle-api/api-token` path only on nodes where that file is absent. Existing token files are checked for root ownership and mode 600, compared byte-for-byte, and must already match; the script refuses to overwrite a different credential. Each node deployment backs up its source files and prior image, then restores them if the new worker does not become healthy. If a node had no prior token, failed deployment removes the copied token after attempting rollback. The deployment script was syntax-checked and dry-run only; no worker service was installed or started in this source task.

## Verification

`python -m unittest discover -s scripts/oracle-api -p 'test_*.py' -v` passes the MCP and extraction worker ASGI tests in a temporary virtual environment using the pinned `scripts/oracle-api/requirements.txt`. Tests cover worker authentication, single-slot capacity, the real private-address guard, fair health-aware selection, local fallback before dispatch, and no retry after ambiguous worker execution. Search and inference upstream handlers are replaced with local fakes; no paid model calls occur.

The existing six-host smoke script now expects `gemma4:e2b` in the model catalog and sends six harmless round-robin `qwen3.5:2b` checks to establish six distinct hosts when run against a deployment. That live smoke test was not run in this source-only task. No DNS, tunnel, deployment, container, or service restart was performed, so neither MCP endpoint is claimed live.

## Specification references

- [MCP Streamable HTTP transport, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): one JSON-RPC message per POST, Accept headers, notification 202 replies, GET 405 allowance, Origin validation, and protocol-version headers.
- [MCP server tools, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): tool schemas, `tools/list`, `tools/call`, and protocol versus tool error handling.
