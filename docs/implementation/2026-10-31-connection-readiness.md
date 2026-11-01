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

## LightSprint retired — superseded on 2026-11-01

The operator reported that every LightSprint account was disabled and explicitly
removed LightSprint from ROTOXY's workforce. All 13 active legacy credentials,
launch bindings and session registrations have been removed. Its routing pool
is disabled. Do not request reauthentication or attempt to resume its jobs.

Historical jobs, artifacts and event records are preserved for audit only.
The old instruction to reconcile an ambiguous task after reauthentication is
superseded by this retirement. Archived records are not eligible worker capacity.

The active direction is the Oracle model pool and isolated, officially
authenticated Codex workers. See the November 1 retirement and pool transition
checkpoint for current implementation boundaries.
