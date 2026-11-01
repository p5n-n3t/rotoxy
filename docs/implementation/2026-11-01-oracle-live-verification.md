# Oracle live verification — 2026-11-01

Release source `06fd92f` passed GitHub CI run `41322887279` before the
Oracle API deployment. The gateway, queue daemon, and monitor retain their
previous immutable release until a separate tested integration.

## Deployed interfaces

- `https://search.ziopsyop.tech/search/mcp`: `search_web`, `extract_url`.
- `https://search.ziopsyop.tech/models/mcp`: `oracle_chat`.
- Existing REST search/extraction and OpenAI-compatible model routes remain.

These are separate stateless machine-to-machine Bearer MCP surfaces.
ROTOXY's main OAuth MCP is a different authentication boundary. Endpoint
registration alone is not client interoperability proof.

## Actual execution

Public initialize and tool discovery passed for both MCP surfaces. Missing
authentication returned 401. Search returned Python documentation; extraction
retrieved Example Domain and rejected a loopback target with an MCP tool error.
`oracle_chat` returned exact `ORACLE_MCP_OK`, host `ora1`, model `qwen3.5:2b`,
finish reason `stop`, prompt/completion usage 23/6 tokens.

A separate private REST smoke executed six bounded requests, all HTTP 200
with exact `ORACLE_API_OK`. Actual host sequence: ora3, ora5, ora6, ora7,
ora8, ora1. Measured durations: 6.67, 5.95, 6.51, 7.38, 5.87, 0.88 seconds.
This proves six-host routing and terminal results, **not six simultaneous
inferences or shared leases across consumers**. Catalog excludes GPT-OSS 20B.

The first local Python public probe received HTTP 403 with its default
User-Agent; curl and an identified integration User-Agent reached the service.
The test was corrected before any model request. Cloudflare edge filtering
must be considered when diagnosing a client's transport response.

## Runtime safety and remaining work

The durable Oracle queue reports zero running/dispatching tasks but 14
historical ambiguous outcomes. These were not retried, cleared or relabelled.
Its configuration retains ora1 disabled until supported reconciliation and
configuration application can complete. The independent API includes ora1.

Search currently uses a private SearXNG instance; guarded extraction runs on
ora3. Crawl4AI containers exist on ora1/ora3/ora5, but their browser subresource
egress safety has not been established. Multi-node guarded HTTP extraction
is a separate implementation, not a claim about the deployed release.

## Rollback

Deployment backup on ora3:
`/opt/jq-worker/oracle-api/backups/oracle-api-20261101T154940Z`.
It contains the previous source/configuration and Docker image reference.
Private environment files remain owner-only; never publish them. The deploy
script automatically restores the prior image/configuration on health failure.
No DNS/tunnel route or API token was changed in this deployment.

## ROTOXY search integration

The main web-tool facade gains explicit `provider: "oracle"` routing to the
fixed private Oracle API. It uses the existing owner-only Oracle token file,
not an Exa credential or a caller-supplied backend URL. Enable the binding
in the private `web-tools.json` as
`"oracle": {"enabled": true, "features": {"search": "supported", "extract": "supported"}}`.
Existing client web-tool permissions and OAuth scopes still apply. Disabling
this binding removes Oracle from discovery on the next operation. Search has
provider-specific limits of 2–200 characters and 1–10 results; extraction is
bounded plain-text HTTP. There is no paid fallback or blind retry.

Source regression coverage checks scopes, client permissions, private file
permissions, fixed destination, correct credential isolation, and failed-call
non-replay. Root integration is not live until its tested release is deployed.
