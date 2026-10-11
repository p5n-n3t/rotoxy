# Tavily Search and Extract adapter

`src/providers/tavily.ts` provides an injectable, capability-scoped adapter for Tavily's documented Search and Extract REST operations. It is not registered in the shared provider registry or exposed by the runtime in this change. The adapter declares Search and Extract supported; Map, Crawl, Research, and Usage are explicitly unsupported here.

## Request contract

- Search calls `POST https://api.tavily.com/search` and Extract calls `POST https://api.tavily.com/extract`. The origin and paths are constants, TLS is required, and redirects are rejected.
- The adapter resolves its API key through the injected `resolveCredential` function for each operation and sends it as `Authorization: Bearer …`. It has no environment-variable, file, or global-key lookup, and it never puts the key in the JSON body.
- Search exposes documented Tavily controls for search depth, chunks, topic, time/date filters, answer/raw-content/images/favicon, domain preferences, country/language, auto parameters, exact matching, usage, and safe search. Extract exposes documented query/chunk, depth, image/favicon, output format, timeout, and usage options. Unrecognized option names and invalid documented combinations fail before credentials are resolved.
- Extract adapts the shared single-URL operation shape to Tavily's `urls: [url]` request. It preserves partial failure visibility as `failedResults` but omits Tavily's free-form per-URL error strings.

## Bounds and error behavior

Queries are limited to 2,000 characters, target URLs to 2,048 characters, search results to 20, outgoing JSON to 32 KB, response JSON to 1 MB, snippets to 20,000 characters, and extracted content to 100,000 characters. The HTTP deadline defaults to 15 seconds and is capped at 30 seconds. Inputs and result URLs must be HTTP(S), and embedded URL credentials are rejected.

No retry or cross-provider fallback occurs. A failure after the HTTP call begins is marked `requestOutcome: "unknown"`; callers must not replay a potentially charged request automatically. HTTP 401 is classified as authentication, 429 as rate limiting (with bounded numeric `Retry-After`), and Tavily's documented 432/433 key/plan and PayGo limits as quota. Other statuses remain unknown unless they are standard timeout/server failures. Error messages never include query text, credentials, response bodies, or raw transport errors. Usage is reported as known only from the documented `usage.credits` response field.

## Verification and evidence boundary

`node --test test/tavily.test.mjs` exercises requests with stub fetch responses, including authentication placement, option mapping and rejection, bounds, partial extraction failures, deadlines, status categories, ambiguous transport errors, and secret/error redaction. The full `npm test` suite builds and passes (224 tests). These are mock tests only. No Tavily credentials or paid calls were used; the adapter is **officially documented and mock tested, not execution-verified**. Live compatibility, billing, quota behavior, and production networking remain unverified.

## Official sources

Documentation pages were checked on **2026-10-11 UTC**:

- [Tavily API introduction](https://docs.tavily.com/documentation/api-reference/introduction) — base URL, bearer API-key authentication, and endpoint overview.
- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) — request options, response shape, HTTP errors including 429 and documented quota statuses 432/433.
- [Tavily Extract API](https://docs.tavily.com/documentation/api-reference/endpoint/extract) — URL batch shape, options, content fields, and per-URL `failed_results` behavior.
