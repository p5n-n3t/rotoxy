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

A subsequent controlled parallel test sent six bounded Qwen requests together.
All six returned exact `PARALLEL_ORACLE_OK` from distinct hosts. Durations:
ora1 9.605s, ora6 7.845s, ora5 6.819s, ora3 7.128s, ora8 9.074s, ora7 7.447s.
All six HTTP request intervals overlapped for 6.816 seconds; overall wall time
was 9.605 seconds. This establishes overlapping successful routed requests,
not a shared capacity lease with other clients or per-token execution timing.

The first local Python public probe received HTTP 403 with its default
User-Agent; curl and an identified integration User-Agent reached the service.
The test was corrected before any model request. Cloudflare edge filtering
must be considered when diagnosing a client's transport response.

## Runtime safety and remaining work

The durable Oracle queue reports zero running/dispatching tasks but 14
historical ambiguous outcomes. These were not retried, cleared or relabelled.
Its configuration retains ora1 disabled until supported reconciliation and
configuration application can complete. The independent API includes ora1.

Search uses a private SearXNG instance. Guarded HTTP extraction workers are
now deployed on ora1/ora3/ora5/ora6/ora7/ora8, Tailnet port 8878, each with
one extraction slot, a 512 MiB memory limit and read-only root filesystem.
Crawl4AI containers exist on ora1/ora3/ora5, but their browser subresource
egress safety has not been established; they are not used by this path.

Worker source `aeaa3f7` passed full CI run `41324469597`. Deployment backup
ID on each host is `20261101T160505Z-195001`, under that host's private
`~/.local/state/rotoxy-oracle-extraction-workers/backups/` directory.

The first live extraction run skipped ora1 in an initial health selection and
selected ora3 twice. A subsequent call completed on ora1, and all six worker
health checks passed. Source review exposed a fairness bug when advancing past
an unhealthy host: the cursor advanced from the attempted position instead
of the actual selection. Fix `1e62cc7` adds a regression test (16 tests pass).
The fixed API was deployed with backup
`/opt/jq-worker/oracle-api/backups/oracle-api-20261101T161228Z`.

After that deployment, six consecutive public `/extract` requests retrieved
Example Domain from ora1, ora3, ora5, ora6, ora7, ora8 in order. A public MCP
`extract_url` call also returned the correct text and `worker_id: ora1`.
These were real network fetches, not mocked responses. Responses include
`source_host` separately from `worker_id`; attribution survives MCP encoding.
API aggregate extraction concurrency remains two, independent of six installed
worker slots. No six-way extraction throughput claim is made.

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
non-replay. Root integration release `59adb6f` passed full CI run `41323811048`
and is deployed in the gateway. Its real configured facade advertised Oracle
and returned Python search results and Example Domain extraction. Gateway
local and public health checks passed. Connected clients may need to refresh
their tool catalog to see the newly enabled provider enum. A connector whose
cached schema still lists only Exa was not counted as an Oracle MCP call proof.

Gateway release/config backup:
`/home/jq/.config/rotoxy/backups/oracle-web-20261101T155937Z`.
The queue daemon and workforce monitor retain the previous release; their
source was unchanged by this web-facade integration.

## Runtime capacity verification

All six Ollama containers now explicitly limit parallel requests and loaded
models to one. ORA1's default context is 4096; the other five retain their
existing 32768 defaults, while these gateway/queue requests specify 4096.
The targeted ora1 change preserved its image and OpenWebUI container and
passed exact `ORA1_RUNTIME_CAP_OK` with thinking disabled. Its first bounded
check used default thinking and exhausted the small output budget without a
final response; it was not recorded as success. See the ora1 runtime report.

Fairness-fix source `1e62cc7` passed full CI run `41325081903` on Node 22/24
and the Oracle API job. No production provider purchase or paid cloud-model
launch was used for these Oracle checks.
