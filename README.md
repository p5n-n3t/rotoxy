# ROTOXY

![ROTOXY](assets/brand/rotoxy-wordmark.svg)

One gateway for authorized AI workspaces, model accounts, search tools and local workers. ROTOXY combines Token2OAuth's OAuth/MCP gateway with Snooze's durable jobs and monitoring. Existing `token2oauth` commands, configuration paths and client URLs remain compatible.

- **Workspace providers:** pooled LightSprint access, pinned sessions, distributed job tools and a persistent supervisor.
- **Models & APIs:** an encrypted Ollama Cloud key pool, scoped model tokens, and explicitly permitted Exa, Firecrawl and Tavily search/extraction tools.
- **Private workers:** a durable Oracle queue with health, assignments, model names and reported throughput.
- **Codex profiles:** isolated official CLI sign-in, model discovery and reported AI quota windows. Automatic subscription pooling/dispatch is not enabled.

The dashboard distinguishes reported values, historical snapshots and unknown metrics. Monitoring survives a closed chat while the service host remains online. Automatic recovery capabilities and client limitations are described in the [consolidation checkpoint](docs/implementation/2026-10-12-rotoxy-release.md) and the [actionable supervision update](docs/implementation/2026-10-12-actionable-supervision.md).

## Connection modes

Use `/mcp` for the agent workspace and orchestration tools, or a provider-specific API path to use one inference pool directly in another application. The [direct provider paths](docs/implementation/provider-paths.md) document OpenAI-compatible pool endpoints. The opt-in [Claude on Bedrock endpoint](docs/implementation/bedrock-messages.md) uses Anthropic Messages; it is separate from running Claude Code as an agent. Both modes share one server and public host. See the [connection contract](docs/architecture/connection-modes.md) for session resource selection and protocol boundaries.

## Architecture

~~~text
                              OAuth authorization code + PKCE
┌─────────────┐             ┌──────────────────────────────┐
│ MCP client  │────────────▶│            ROTOXY            │
│             │◀────────────│  OAuth AS + MCP resource     │
└─────────────┘             │                              │
                            │  adaptive credential pool    │
                            │  A  healthy                  │
                            │  B  cooldown (429)           │
                            │  C  healthy                  │
                            │  D  exhausted                │
                            │  E  healthy                  │
                            └──────────────┬───────────────┘
                                           │ Bearer upstream-token
                                           ▼
                                ┌──────────────────────┐
                                │ Upstream MCP server  │
                                └──────────────────────┘
~~~

### Highlights

- **One MCP connection, many upstream credentials**
- OAuth authorization code flow with **PKCE S256**
- Protected-resource and authorization-server metadata
- Dynamic Client Registration (DCR)
- Resource-bound short-lived gateway access tokens
- Rotating refresh tokens
- AES-256-GCM encryption for upstream bearer credentials at rest
- No upstream bearer token is returned to downstream clients or rendered back into the admin UI
- Streamable HTTP/SSE-friendly MCP proxy
- MCP session affinity using <code>Mcp-Session-Id</code>
- Smart 401 / 402 / 429 / 5xx handling and <code>Retry-After</code> support
- Configurable quota/error body matching and cooldown recovery
- Six pool strategies
- Polished browser admin console
- Headless CLI
- Idempotent installer
- Tailscale detection and optional automatic installation
- Tailscale path mounting **without resetting existing routes**
- systemd user service, Docker, tests, and GitHub Actions

## Quick install

Install Node.js 22+, Git, npm and an authenticated Tailscale client first, then run:

~~~bash
curl -fsSL https://raw.githubusercontent.com/p5n-n3t/rotoxy/main/install-rotoxy.sh | bash
rotoxy up
~~~

The manual installer prepares the gateway and foreground Funnel units without enabling boot startup or publishing routes. `rotoxy up` starts the configured services and publishes one root route to port 2030. `rotoxy down` withdraws that route and stops the services. Existing conflicting routes cause a refusal and must be migrated explicitly; global resets are never used. Oracle and monitoring units are started when separately installed and configured.

| Item | Default |
|---|---|
| Local listener | `127.0.0.1:2030` |
| Public MCP path | `/token2oauth/mcp` (compatible root `/mcp` also works) |
| Dashboard | `/token2oauth/admin` |
| Lifecycle | `rotoxy up`, `rotoxy down`, `rotoxy status` |
| Configuration | `~/.config/token2oauth` |
| Runtime | `~/.local/share/token2oauth` |
| Boot startup | Off |

The canonical repository retains the `token2oauth` name during migration; product branding is ROTOXY. See [manual lifecycle and legacy migration](docs/implementation/rotoxy-lifecycle.md).

### Compatibility installer switches

~~~text
--prefix PATH
--port N
--path PATH
--mode funnel|serve|none
--public-base-url URL
--upstream-url URL
--branch NAME
--repo URL
--no-tailscale
--no-service
--force-root
--yes
--dry-run
~~~

Examples:

~~~bash
./install.sh --port 2030 --path /token2oauth

./install.sh --mode serve --path /token2oauth

./install.sh --mode none \
  --public-base-url https://mcp.example.com/token2oauth

./install.sh \
  --upstream-url https://provider.example.com/mcp
~~~

## First run

### 1. Open the admin console

The installer prints the Gateway, MCP, and Admin URLs. On first initialization it also generates an admin password. Only its scrypt hash is persisted.

### 2. Configure the real upstream MCP URL

Use the web Admin console, or:

~~~bash
token2oauth config set upstreamUrl https://provider.example.com/mcp
~~~

### 3. Add your authorized provider accounts

~~~bash
token2oauth account add --label "Pro account 1"
token2oauth account add --label "Pro account 2" --weight 1.5
token2oauth account add --label "Pro account 3" --priority 50
~~~

### 3a. Test every credential

New accounts begin as `unknown` until the proxy uses them. To verify every
token before attaching ChatGPT, run a direct authenticated MCP initialize
probe. It runs sequentially and records only the resulting status, never the
token itself:

~~~bash
token2oauth account probe
~~~

The admin console provides **Test credential** and **Test all enabled
credentials** controls with the same behavior.

The interactive CLI disables terminal echo while the token is entered.

For automation:

~~~bash
printf '%s' "$PROVIDER_TOKEN" |
  token2oauth account add --label "CI account" --token-stdin

token2oauth account add \
  --label "Environment account" \
  --token-env PROVIDER_TOKEN
~~~

### 4. Add one URL to ChatGPT

Add only:

~~~text
https://your-node.your-tailnet.ts.net/token2oauth/mcp
~~~

Token2OAuth advertises OAuth metadata. ChatGPT performs OAuth with Token2OAuth; upstream bearer tokens stay on your host.

See [ChatGPT OAuth](docs/CHATGPT-OAUTH.md).

## Smart pooling

The default strategy is **adaptive-sticky**.

For a new MCP session, Token2OAuth favors an enabled credential with low normalized usage, low error rate, no cooldown, and low current concurrency. Once the upstream establishes an MCP session, Token2OAuth pins that session to the same upstream credential.

This distributes load **without randomly switching accounts in the middle of a stateful MCP session**.

| Signal | Default action |
|---|---|
| 2xx | mark healthy and clear failure streak |
| 401 | mark credential auth-failed |
| 402 | mark exhausted and cool down |
| 429 | honor Retry-After, cool down, choose another |
| quota/credit exhaustion text | cool down even if provider uses another status |
| 5xx, timeout, network failure | short cooldown and failover |
| request already has Mcp-Session-Id | no cross-account failover by default |

There is intentionally no fake "remaining credits" counter. If a provider publishes a real usage endpoint, a provider adapter can add proactive checks. Otherwise provider responses are more reliable than guessing.

See [Pooling and failover](docs/POOLING.md).

## Pool strategies

~~~bash
token2oauth pool strategy adaptive-sticky
token2oauth pool strategy round-robin
token2oauth pool strategy least-used
token2oauth pool strategy weighted-random
token2oauth pool strategy random
token2oauth pool strategy priority
~~~

- **adaptive-sticky** — recommended; affinity + usage/error/concurrency score
- **round-robin** — deterministic rotation among eligible accounts
- **least-used** — request count normalized by weight
- **weighted-random** — probabilistic distribution using account weights
- **random** — uniform random eligible credential
- **priority** — lowest numeric priority first

## CLI

~~~text
token2oauth init
token2oauth serve

token2oauth account add
token2oauth account list
token2oauth account enable ID
token2oauth account disable ID
token2oauth account remove ID
token2oauth account reset-health [ID]

token2oauth pool status
token2oauth pool strategy STRATEGY

token2oauth config list
token2oauth config get KEY
token2oauth config set KEY VALUE

token2oauth oauth clients
token2oauth oauth revoke-client CLIENT_ID

token2oauth admin reset-password [--generate] [--revoke-connections]

token2oauth tools refresh [ACCOUNT_ID]
token2oauth tools list
token2oauth tools deny NAME
token2oauth tools allow NAME
token2oauth tools policy show
token2oauth tools policy set FILE.json

token2oauth lifecycle status
token2oauth lifecycle up [--mode funnel|serve] [--execute]
token2oauth lifecycle down [--keep-service|--keep-route] [--execute]

token2oauth tailscale status
token2oauth tailscale expose [--execute]    # alias of lifecycle up; /token2oauth only

token2oauth doctor [--live] [--public] [--repairs] [--json]
token2oauth pools preview
~~~

For the unified foreground stack use `rotoxy up|down|status`. The older `lifecycle up|down` and `tailscale expose` commands refuse changes when a foreground stack exists; otherwise they are dry runs that print the exact
commands unless `--execute` is given. They only ever add or remove the
`/token2oauth` mount, re-read `tailscale serve status --json` before and after
each write, and stop if any other route changed.

### Admin console

- **Pool** — upstream URL, strategy (with live help for each choice),
  failover/cooldown/timeout settings and per-credential health probes.
- **Tools** — per-account tool inventory from `tools/list`, enable/disable
  toggles enforced by the gateway for every MCP client, and "replay-safe"
  marks for read-only tools.
- **Diagnostics** — doctor report, read-only service/Funnel check, request
  analytics by account and tool, recent events in plain language, and quota
  data only when a provider actually reports it.
- **Security** — regenerate the admin password (shown once) and optionally
  disconnect every MCP client.

Every admin form is CSRF-protected and the admin cookie is scoped to the
gateway path.

Every command supports <code>--help</code> through Commander.

## LightSprint

Token2OAuth is provider-agnostic. For LightSprint or another service, configure the **actual remote MCP endpoint that accepts the account's bearer credential**, then add each authorized account token to the pool.

Example labels:

~~~text
LightSprint Pro #1
LightSprint Pro #2
LightSprint Pro #3
LightSprint Pro #4
LightSprint Pro #5
~~~

The public LightSprint CLI/plugin demonstrates Bearer-token API calls, token refresh and explicit handling of HTTP 429. Token2OAuth therefore treats 429/Retry-After as a strong cooldown signal by default, while also supporting configurable credit/quota patterns. It does not assume an undocumented balance endpoint.

## Tailscale

Token2OAuth never calls <code>tailscale funnel reset</code> or <code>tailscale serve reset</code>.

The generated route is equivalent to:

~~~bash
tailscale funnel --bg \
  --https=443 \
  --set-path=/token2oauth \
  http://127.0.0.1:2030
~~~

See [Tailscale deployment](docs/TAILSCALE.md).

## Docker

Tailscale normally stays on the host:

~~~bash
docker compose up -d --build
tailscale funnel --bg --https=443 --set-path=/token2oauth http://127.0.0.1:2030
~~~

Persist the data volume. It contains encrypted account envelopes, OAuth client state, and the local master key.

## Security

Upstream tokens are encrypted with AES-256-GCM using a random 256-bit key stored separately in <code>~/.config/token2oauth/master.key</code>. The admin UI never reveals a stored bearer token. Gateway OAuth access tokens are short-lived and audience-bound; refresh tokens are stored as hashes and rotated.

Read [SECURITY.md](SECURITY.md) before putting the gateway on a public hostname.

## Development

~~~bash
git clone https://github.com/p5n-n3t/token2oauth.git
cd token2oauth
npm install
npm test
npm run dev
~~~

The test suite includes RFC 7636 PKCE verification, encryption round-trip, failure classification, a full DCR/authorization/token flow, live 429→healthy credential failover, and refresh-token rotation.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [ChatGPT / OpenAI OAuth](docs/CHATGPT-OAUTH.md)
- [Pooling and failover](docs/POOLING.md)
- [Configuration](docs/CONFIGURATION.md)
- [Tailscale deployment](docs/TAILSCALE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT
