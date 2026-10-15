# Unified model catalog cache and Cloudflare SSE compatibility

## Behavior

`POST /v1/chat/completions` now accepts Cloudflare `stream: true` while keeping the Workers AI call itself nonstreaming. The bounded completion is converted into OpenAI SSE frames: assistant role, escaped content, finish reason, optional usage, then `[DONE]`. `stream_options` is accepted only for streaming and only as `{ "include_usage": boolean }`; when true, a final usage chunk is emitted (with `null` if the provider supplied no usage). Tools, tool roles, multimodal content, and other unknown parameters return a sanitized 400. A closed client receives no later writes. The existing adapter controls upstream timeout and response bounds; because its interface has no abort signal, a client disconnect does not cancel an already-running provider request.

## Catalog

`GET /v1/models` retains the model:read gate and Cloudflare allowlist fallback when Ollama is unavailable. Results are cached in-process for at most 60 seconds and concurrent misses for the same configuration share one Ollama catalog request set. `X-Model-Catalog-Provenance` reports the Cloudflare allowlist, Ollama source state, and `cache-miss`, `cache-shared`, or `cache-hit`.

Cache identity uses public account metadata plus filesystem inode, size, and timestamps for the two credential-store files. It does not read, hash, log, or return secret contents. Store rewrites on enable/disable, rotation, add, or removal change that identity and force refresh on the next request. The first refresh still checks each eligible Ollama account; a successful catalog is reused by subsequent client dropdown requests.

## Verification and integration

The focused `node --test test/unified-model-api.test.mjs` covers SSE frame order/usage/escaping, malformed stream options, tool and multimodal rejection, request/output bounds, scope checks, client close, catalog singleflight/cache, and invalidation after rotation/enable/remove. Tests set temporary `HOME` and `TOKEN2OAUTH_CONFIG_DIR` before constructing `StateStore`. No server wiring was changed; keep mounting the unified router before the legacy model gateway. Full suite was intentionally not run.
