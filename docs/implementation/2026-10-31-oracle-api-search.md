# Private Oracle model API and search/extraction status

## API capability

The ora3 service at `http://100.114.191.111:8877` now runs an authenticated, bounded Oracle API. Its implemented routes are:

- `GET /health`: liveness only.
- `GET /v1/models`: OpenAI-compatible catalog for the fixed five-node model allowlist; requires Bearer authentication.
- `POST /v1/chat/completions`: OpenAI-compatible non-streaming chat completion; requires Bearer authentication.
- `POST /search`: authenticated SearXNG JSON search with a two-request fail-fast concurrency bound, 20-second timeout, 512 KB upstream body cap, and 10-result maximum.
- `POST /extract` (and compatibility alias `POST /scrape`): bounded single-document text extraction; requires Bearer authentication.

The local ROTOXY adapter reads the existing API credential from the owner-only local file `/home/jq/.config/rotoxy/oracle-api-token`; the value is not committed or printed. ora3 has the same unrotated credential in `/etc/oracle-api/api-token` (root-owned, mode `0600`) in addition to the existing service env file.

The inference adapter only sends to fixed Tailnet IPs. General and coding models are configured across ora3/5/6/7/8; `tev1:0.8b` and `gemma4:e2b` are limited to ora8. Requests are non-streaming, cap prompt text at 24 KB, output at 512 tokens, context at 4096, response bytes at 1 MB, and timeout at 120 seconds. Round-robin selection skips a host already reserved by the API process. All five Ollama containers report `OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=1`, which also constrains concurrent generation from other clients such as the pool.

## URL extraction safety

Extraction is a plain HTTP fetch and HTML text parser. It permits HTTP/HTTPS on standard ports only, resolves DNS once, rejects any non-global answer, connects to the validated numeric address, and uses the original hostname for Host and TLS verification. It does not follow redirects, execute JavaScript, load subresources, or contact browser-discovered URLs. Fetches are capped at 1 MB and extracted text at 24 KB. Only HTML, XHTML, and plain text responses are accepted. No redirecting page is returned as if fetched successfully.

## Search limitation

The direct DuckDuckGo HTML endpoint returned HTTP 202 with an anomaly/challenge page and no result links. A pinned official SearXNG container is now deployed privately on `oracle-api_default` with no host port, 512 MiB memory cap, 1 CPU, and JSON format explicitly enabled. The API accepts a bounded query string and returns title, URL, excerpt, and engine fields only. One authenticated live query for `python official documentation` returned HTTP 200 and five results; the first was Python.org's `Our Documentation` at `https://www.python.org/doc/`. SearXNG aggregated 40 results in the direct container probe; DuckDuckGo showed a CAPTCHA warning, while aggregation still returned the Python.org result. The SearXNG instance is not exposed through the tunnel or public DNS. This deployment follows the [official container installation guidance](https://docs.searxng.org/admin/installation-docker) and [search API format guidance](https://docs.searxng.org/dev/search_api.html).

## Host/model inventory

At the pre-deploy read-only inventory, ora3/5/6/7/8 each had no active Ollama process (`/api/ps` empty). None listed an exact `gpt-oss:20b` model; therefore no such model was present to remove. A large opaque `llamacpp:*` blob on ora3/ora5 and other unrelated models on ora7/ora8 were not deleted. `qwen3.5:9b` remains installed on several hosts but is excluded from the API model allowlist and the current Oracle pool dispatch configuration. This is disk inventory, not a deletion claim.

## Deployment and rollback

`deploy-ora3.sh` backs up the app, compose file, Dockerfile, requirements, dockerignore, SearXNG settings, private `.env`, and prior Oracle image ID/tag under `/opt/jq-worker/oracle-api/backups/`. It rebuilds only the `oracle-api` image, starts the SearXNG service and Oracle API, checks both health states, and restores backed-up Oracle configuration/image if health fails. The compose file binds Oracle port 8877 only to loopback and ora3's Tailnet address and configures one Uvicorn worker; SearXNG has no published port. It does not edit the existing cloudflared tunnel or publish DNS. Latest deployment backup: `/opt/jq-worker/oracle-api/backups/oracle-api-20261031T164650Z`.

## Verification

Local source syntax checks passed with `python3 -m py_compile`, `bash -n`, and `git diff --check`. Final live smoke after the SearXNG deployment on 2026-10-31: missing and invalid auth both 401; model catalog 200 with five models and no `gpt-oss:20b`; private URL rejected with 422; Example Domain extraction 200 with title and expected text; authenticated search 200 with five Python documentation results; one harmless `ORACLE_API_OK` inference succeeded on each of ora3, ora5, ora6, ora7, and ora8 (5.82–6.60 seconds). Host attribution was distinct across all five. Both containers reported healthy; sampled SearXNG use was 117.8 MiB / 512 MiB. The parent bridge catalog was verified 200 before this deployment; bridge chat should be retested now against the updated origin.

## Public route verification

After the authorized `search.ziopsyop.tech` tunnel route was published, the public API was checked on 2026-10-31: `/health` 200; missing and invalid Bearer tokens for `/search` 401; valid authenticated search 200 with five results and Python.org first; Example Domain extraction 200 with expected title/text; private loopback URL extraction rejected with 422. No token values were printed or included in this report. Python's default `urllib` user agent received a Cloudflare 1010 response during the first probe; standard `curl` and Node `fetch` succeeded with their default user agents, and the authenticated functional checks passed using a browser-like standard UA. No Cloudflare rule was changed as part of these checks.
