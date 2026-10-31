# Connection readiness — 2026-10-31

Use these verified entry points from another project. Project folders do not
require separate provider pools. Permissions and job ownership still apply.

| Interface | Endpoint | Authentication | Verified behavior |
| --- | --- | --- | --- |
| Shared agent workspace | `https://jq-xubuntu1.bigeye-escalator.ts.net/mcp` | MCP OAuth | Existing client discovers ROTOXY Fleet; Oracle durable task execution has returned a real result |
| Oracle model API | `https://jq-xubuntu1.bigeye-escalator.ts.net/providers/oracle/v1` | Scoped ROTOXY model token | Catalog and actual chat completion through public Funnel, with model and VM attribution |
| Oracle search | `https://search.ziopsyop.tech/search` | Separate Oracle API Bearer token | Real search results through authenticated Cloudflare Tunnel |
| Oracle extraction | `https://search.ziopsyop.tech/extract` | Separate Oracle API Bearer token | Public page extraction; private-address requests rejected |

Issue a scoped model token in **Models & APIs** (`/admin/models`). Choose read
and invoke permissions for chat clients, or read-only for catalog access. Use
`oracle/qwen3.5:2b` for the tested small-worker model. This adapter currently
supports non-streaming text requests only. The admin password and MCP OAuth
token are not model API keys.

The separate Oracle search token is kept in an owner-only file on this machine,
`/home/jq/.config/rotoxy/oracle-api-token`. It is not a scoped ROTOXY model token.
Do not paste either credential into logs, source code, or shared prompts.

Search accepts JSON such as `{"query":"python official documentation","limit":5}`.
Extraction accepts `{"url":"https://example.com/"}`. The service applies one
shared authenticated rate limit of ten requests per minute. Extraction is a
bounded single-page HTTP fetch; it does not execute JavaScript or follow redirects.
Cloudflare rejected Python urllib's default user agent in one test; ordinary
curl and Node fetch clients succeeded without a Cloudflare rule change.

## LightSprint execution is currently blocked

LightSprint authentication changed during the verification run. The monitor
successfully read its nine registered sessions early in the run, then reported
HTTP 401 for every one in later cycles. Independent read-only initialization
checks also failed across the tested account credentials. No published official
incident or authentication migration was found. This is not evidence that the
accounts ran out of credits.

The approved review job has a verified provider task but an ambiguous launch
receipt. Preserve its original identity and reservation. Reconcile that task;
never launch a replacement just to get past the missing session identity.
LightSprint fan-out is not ready to be advertised as verified working until
authentication and original-task observation are restored.

The Oracle model pool and authenticated search service do not depend on these
LightSprint credentials. Their successful live results are recorded separately
in the Oracle implementation and bridge proof reports.
