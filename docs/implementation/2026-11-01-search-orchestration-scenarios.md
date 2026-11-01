# Search, crawler and orchestration boundaries — 2026-11-01

## Gateway locations and connections

The ROTOXY gateway runs on the desktop, loopback port 2030, behind its existing
Tailscale Funnel. `/mcp` is the full OAuth-authenticated control surface.
The added `/search/mcp` is a separate OAuth resource with only owner-hosted
Oracle search/fetch tools; its tokens cannot be used at `/mcp`, or vice versa.
It uses the same issuer, PKCE/consent and rotating refresh-token mechanisms.

The Oracle API runs on ora3, private port 8877; Cloudflare Tunnel exposes
`https://search.ziopsyop.tech`. Its direct `/search/mcp`, `/models/mcp` and
REST endpoints retain private Oracle Bearer authentication. For ChatGPT OAuth,
use `https://jq-xubuntu1.bigeye-escalator.ts.net/search/mcp`, not the direct
Cloudflare Bearer endpoint. Do not put an admin password in an API-key field.
Existing main-MCP clients can use `web_search`/`web_extract`, provider `oracle`.

Guarded extraction workers run on all six Oracle nodes at private port 8878.
Normal inference uses shared small models; requests are bounded and model
execution does not silently perform web search.

## Existing Crawl4AI

The containers are Crawl4AI, not CrewAI. Existing v0.9.2 containers on ora1,
ora3 and ora5 are not used for the public extraction path. They remain intact.
Their API is authenticated; browser subresource/redirect/DNS egress isolation
has not been verified. Installing a browser crawler does not establish that
arbitrary public URLs cannot reach private services. The guarded HTTP extractor
is the current deployed route. Browser rendering requires a separately tested
egress boundary before becoming an advertised capability.

## Honest comparison

| Capability | Current Oracle service | Remaining gap |
| --- | --- | --- |
| Ordinary web search | SearXNG metasearch, bounded results | Independent index, semantic ranking, freshness/quality comparison |
| Public page extraction | Six-node plain HTTP text with worker attribution | Clean Markdown, structured schema/CSS extraction |
| JavaScript/browser pages | Not advertised | Safe browser network isolation and rendering tests |
| Site mapping and crawling | Not advertised | Robots-aware bounded frontier, deduplication, cancellation and durable crawl artifacts |
| Batch/research workflow | Live bounded search/fetch/model verification | General durable research workflow and comparative quality evidence |
| Vendor-specific features | Use existing explicit provider adapters | No claim of full Exa/Firecrawl equivalence |

The official [Crawl4AI documentation](https://docs.crawl4ai.com/) distinguishes
its self-hosted browser/crawler from its hosted search service.
[Exa search](https://exa.ai/docs/reference/search) and
[Firecrawl](https://docs.firecrawl.dev/introduction) expose capabilities beyond
this cluster's currently verified text-fetch path. No vendor request is sent
as a hidden fallback and no CAPTCHA/access restriction is bypassed.

## How agents learn

Main-MCP initialize instructions direct agents to `rotoxy_guide`; `search` and
`oracle` topics explain workflows and limits. The search-only endpoint carries
its own initialize instructions, tool descriptions and read-only annotations.
`search` returns URL identifiers; `fetch(id)` retrieves that public URL.
The optional packaged/local skill mirrors these rules and removes retired
LightSprint launch instructions. MCP does not install skill files into clients
or force a client to choose a tool. The client must enable/select the connection
and honor the workflow. Account/interface availability remains subject to
[ChatGPT's connected-app controls](https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt).

## Decision models

Use code for health, capacity, fairness, budgets and retries. A capable model can
help decompose an unfamiliar objective or suggest specialist assignments; its
plan must still pass deterministic capability, dependency, permission and budget
checks. A tiny decision model is not automatically competent at architectural
planning. The retained TEV model is optional and has no measured planning benefit
yet; it is not activated simply to rotate hosts.

## Real bounded research proof

`scripts/oracle-api/verify-research-cluster.py` performed three real searches,
six public page extractions and six concurrent bounded Qwen completions. All six
extraction workers and all six model hosts participated. All model final markers
and finish reasons passed; model HTTP intervals overlapped for 8.410 seconds.
The ordinary-code rate-window wait consumed no model inference. The report at
`/tmp/rotoxy-oracle-research-verification.json` retains source URLs, text hashes,
worker attribution, model usage and timings. This is a real bounded pipeline,
not proof of a durable orchestration job or hours-long execution. Marker success
is not a general intelligence benchmark or independent review of answer quality.
