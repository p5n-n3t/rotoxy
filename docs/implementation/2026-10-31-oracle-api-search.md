# Private Oracle model API and search/extraction status

## API capability

The ora3 service at `http://100.114.191.111:8877` is being upgraded from the Crawl4AI proxy to an authenticated, bounded Oracle API. Its implemented routes are:

- `GET /health`: liveness only.
- `GET /v1/models`: OpenAI-compatible catalog for the fixed five-node model allowlist; requires Bearer authentication.
- `POST /v1/chat/completions`: OpenAI-compatible non-streaming chat completion; requires Bearer authentication.
- `POST /extract` (and compatibility alias `POST /scrape`): bounded single-document text extraction; requires Bearer authentication.

The local ROTOXY adapter reads the existing API credential from the owner-only local file `/home/jq/.config/rotoxy/oracle-api-token`; the value is not committed or printed. ora3 has the same unrotated credential in `/etc/oracle-api/api-token` (root-owned, mode `0600`) in addition to the existing service env file.

The inference adapter only sends to fixed Tailnet IPs. General and coding models are configured across ora3/5/6/7/8; `tev1:0.8b` and `gemma4:e2b` are limited to ora8. Requests are non-streaming, cap prompt text at 24 KB, output at 512 tokens, context at 4096, response bytes at 1 MB, and timeout at 120 seconds. Round-robin selection skips a host already reserved by the API process. All five Ollama containers report `OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=1`, which also constrains concurrent generation from other clients such as the pool.

## URL extraction safety

Extraction is a plain HTTP fetch and HTML text parser. It permits HTTP/HTTPS on standard ports only, resolves DNS once, rejects any non-global answer, connects to the validated numeric address, and uses the original hostname for Host and TLS verification. It does not follow redirects, execute JavaScript, load subresources, or contact browser-discovered URLs. Fetches are capped at 1 MB and extracted text at 24 KB. Only HTML, XHTML, and plain text responses are accepted. No redirecting page is returned as if fetched successfully.

## Search limitation

No SearXNG, Firecrawl, or other search-index service is installed on ora3. A direct read-only probe of DuckDuckGo's HTML search endpoint returned HTTP 202 with an anomaly/challenge page and no result links. No `/search` route is implemented or advertised. URL extraction is document retrieval and is not represented as web search. Public search publication remains blocked until an existing/approved search source is available.

## Host/model inventory

At the pre-deploy read-only inventory, ora3/5/6/7/8 each had no active Ollama process (`/api/ps` empty). None listed an exact `gpt-oss:20b` model; therefore no such model was present to remove. A large opaque `llamacpp:*` blob on ora3/ora5 and other unrelated models on ora7/ora8 were not deleted. `qwen3.5:9b` remains installed on several hosts but is excluded from the API model allowlist and the current Oracle pool dispatch configuration. This is disk inventory, not a deletion claim.

## Deployment and rollback

`deploy-ora3.sh` backs up `/opt/jq-worker/oracle-api/app.py` and `docker-compose.yaml` to a private timestamped directory under `/opt/jq-worker/backups/`, installs these repository files, rebuilds only the `oracle-api` image, restarts only that container, and restores the two backed-up files automatically if health fails. The compose file binds port 8877 only to loopback and ora3's Tailnet address and configures one Uvicorn worker. It does not edit the existing cloudflared tunnel or publish DNS. Manual rollback is to copy the two files from the printed backup directory and run `docker compose up -d --no-deps oracle-api` from `/opt/jq-worker/oracle-api`.

## Verification

Local source syntax checks passed with `python3 -m py_compile` and `bash -n`. Container-to-node Ollama `/api/version` checks returned 200 for all five configured hosts. Authenticated model catalog, missing/invalid-token rejection, public extraction, private-URL rejection, and one harmless inference to each host are exercised by `smoke-test-ora3.py`; final results and the actual backup path are recorded after deployment.
