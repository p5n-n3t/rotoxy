# Cloudflare Workers AI adapter checkpoint

Base: `origin/main` at `15767e1c31410bc9125f543c53d372fe8e865efb`. Branch: `codex/rotoxy-cloudflare-20261015`.

## Provider contract checked (2026-10-15)

- Catalog: Cloudflare API reference, [`GET /accounts/{account_id}/ai/models/search`](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/).
- Inference: Cloudflare API reference, [`POST /accounts/{account_id}/ai/run/{model_name}`](https://developers.cloudflare.com/api/resources/ai/methods/run/).
- Route definitions cross-checked against Cloudflare’s [official API schema](https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json).

## Implemented

`src/cloudflare-ai.ts` exports `CloudflareCredentialStore`, `CloudflareAIAdapter`, typed CRUD/input options and `CloudflareAIError`. Credentials use the existing StateStore lock, AES-GCM master-key helpers, atomic rename, private directory/file modes, and never expose tokens in list/add/update results. Account IDs are canonicalized 32-hex values and duplicates are rejected. Labels, token newlines, model IDs, JSON input, response bytes, and timeout are bounded. Empty model allowlists deny inference.

The adapter uses only the fixed Cloudflare API host and account-pinned route paths. It selects enabled, non-cooldown accounts by least in-flight count with round-robin ties; the default per-process cap is one active request per account. `max_tokens` is clamped when supplied. HTTP 429 sets a bounded cooldown. Inference is sent once: transport errors are sanitized as ambiguous and never retried.

Root integration can instantiate `new CloudflareCredentialStore(store)` and `new CloudflareAIAdapter(credentials)`, then mount credential CRUD behind existing admin authentication/CSRF and connect `listModels()` / `run({model,input})` to the model gateway. This branch intentionally does not edit shared server, API, auth, or UI files. Selection counters are process-local; cross-process concurrency coordination and root route/gateway wiring remain integration work.

## Verification

Tests set temporary `HOME` and `TOKEN2OAUTH_CONFIG_DIR` before constructing `StateStore`. `npm run build` passed; focused tests passed 2/2; full `npm test` passed 341/341 with no failures. Fake-fetch checks cover credential secrecy/mode, duplicate and malformed records, catalog/inference routes, model allowlists, token cap, concurrent account selection, cooldown, oversized responses, and no retry after ambiguous inference. No live Cloudflare account or provider request was used.
