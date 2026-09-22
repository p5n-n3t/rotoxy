<p align="center">
  <img src="assets/rotoxy-logo.webp" alt="ROTOXY logo" width="220">
</p>

<h1 align="center">ROTOXY</h1>

<p align="center"><strong>One AI gateway. Many accounts. Many providers. Smart routing when you want it.</strong></p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-2.0.0-ff4b18?style=for-the-badge">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-3c873a?style=for-the-badge&logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178c6?style=for-the-badge&logo=typescript&logoColor=white">
  <img alt="Tailscale" src="https://img.shields.io/badge/Tailscale-Serve%20%7C%20Funnel-black?style=for-the-badge&logo=tailscale">
  <img alt="CI" src="https://github.com/p5n-n3t/rotoxy/actions/workflows/ci.yml/badge.svg">
  <img alt="Tests" src="https://img.shields.io/badge/tests-8%2F8%20passing-22c55e?style=for-the-badge">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-8b5cf6?style=for-the-badge">
</p>

ROTOXY is a local-first AI model gateway combining **API-key rotation**, **multi-provider routing**, **same-model cross-provider pools**, **smart task routing**, **usage telemetry**, **Tailscale exposure**, and **delegation to authenticated local AI CLIs**.

The default experience stays simple:

```text
client → one ROTOXY URL → one default provider → rotating accounts
```

Everything else is optional. Add providers, pools, smart routing, named Tailscale Services, or local agent workers only when you need them.

## Why ROTOXY?

- Rotate multiple accounts under the same provider.
- Switch the default provider without changing the client URL.
- Create federated pools for equivalent models across providers.
- Route by task category or easy / medium / hard difficulty.
- Keep one endpoint, or optionally create named Tailscale Service endpoints.
- Enforce OpenRouter free-only usage.
- Track requests and token usage by provider, account, model, and pool.
- Delegate work to Codex, Gemini CLI, Claude Code, Copilot CLI, AGY, and other local workers when they expose a safe headless interface.
- Keep provider secrets local.
- Keep terminal output compact and color-coded; raw JSON is explicit with `--json`.

## Mental model

```text
Provider
└── Accounts          rotate credentials for one provider

Pool
├── Provider pool     rotate accounts inside one provider
└── Federated pool    rotate equivalent model targets across providers

Router
├── explicit          provider / pool / virtual model / URL path
├── task              coding, research, vision, devops, etc.
└── difficulty        easy / medium / hard

Exposure
├── one URL           recommended
└── named Services    advanced: provider/pool/router URLs
```

## Quick start

```bash
git clone https://github.com/p5n-n3t/rotoxy.git ~/rotoxy
cd ~/rotoxy
./install.sh
```

The installer checks dependencies, offers Tailscale installation, lets you authenticate with an auth key or browser/device flow, generates the ROTOXY client token, and walks through first-run provider configuration.

API keys are entered as:

```text
Account 1 API key:
Account 2 API key:
Account 3 API key:
Account 4 API key:     ← blank = finished
```

Secrets live at `~/.config/rotoxy/secrets.env`, not in the repository.

## Everyday CLI

```bash
rotoxy status
rotoxy models
rotoxy usage
rotoxy routes
rotoxy endpoints
rotoxy configure
```

Machine-readable output is opt-in:

```bash
rotoxy models --json
rotoxy usage --json
rotoxy agents --json
```

## One URL, switch providers

Keep clients pointed at the same ROTOXY URL:

```bash
rotoxy provider use ollama
rotoxy provider use openrouter
```

The backend watches `config.json` and reloads valid routing changes.

Per-request routing can use headers:

```text
X-Rotoxy-Provider: ollama
X-Rotoxy-Pool: coding-pool
X-Rotoxy-Task: research
X-Rotoxy-Difficulty: hard
```

Virtual model selectors are also supported:

```text
rotoxy/auto
rotoxy/provider/ollama
rotoxy/pool/coding-pool
rotoxy/task/research
rotoxy/difficulty/hard
```

And URL routes:

```text
/p/PROVIDER/...
/pool/POOL/...
/smart/task/...
/smart/difficulty/...
/smart/auto/...
```

## Same-model rotation across providers

A federated pool maps one logical job to provider-specific model IDs:

```text
federated pool: fast-code
├── ollama      → qwen3.5:397b
├── provider-b  → provider-b/model-slug
└── openrouter  → some-model:free
```

ROTOXY rotates or selects among those targets. Federated pools reject incompatible wire protocols instead of blindly alternating unlike APIs.

Configure one through:

```bash
rotoxy configure
```

## Smart routing

Task routing covers:

`general`, `coding`, `debugging`, `reasoning`, `research`, `data`, `math-science`, `extraction`, `summarization`, `writing`, `creative`, `translation`, `vision`, `long-context`, `agentic`, `security`, `devops`, and `documents`.

Difficulty routing uses `easy`, `medium`, and `hard`.

Preview the classifier:

```bash
rotoxy classify "debug this distributed TypeScript service and redesign the retry architecture"
```

Then map categories to pools/models with `rotoxy configure`.

See [Smart routing](docs/ROUTING.md).

## OpenRouter: free-only

The OpenRouter preset enforces free usage. It accepts `openrouter/free`, `:free` model variants, or catalog entries reporting zero prompt and completion cost. Paid/non-free model IDs are rejected.

OpenRouter's free router documentation:
https://openrouter.ai/openrouter/free/

## Tailscale exposure

- **Serve**: private Tailnet HTTPS, recommended.
- **Funnel**: public HTTPS, still protected by the independent ROTOXY token.
- **Local**: loopback only.

The recommended layout is one URL. Advanced users can enable named Tailscale Services for provider, pool, or smart-router endpoints.

```bash
rotoxy endpoints
```

Tailscale Services can require Tailnet definition/approval:
https://tailscale.com/docs/features/tailscale-services

## OAuth / subscription-backed agent workers

ROTOXY does not scrape OAuth credential stores. It invokes official local CLIs that already own their authentication state.

```text
main agent
   │
   └─ rotoxy delegate / fanout
        ├── Codex CLI
        ├── Gemini CLI
        ├── Claude Code
        ├── Copilot CLI
        └── AGY
```

Detect installed agents:

```bash
rotoxy agents
```

Delegate:

```bash
rotoxy delegate --worker codex --prompt "Review this repository architecture"
rotoxy delegate --pool subscriptions --prompt "Investigate this failure and write a remediation plan"
```

Fan out:

```bash
rotoxy fanout --pool subscriptions --prompt "Independently audit this design"
```

Desktop apps such as ChatGPT Desktop, Claude Desktop, Antigravity IDE, and Cursor can be detected, but ROTOXY does not pretend a GUI is a safe automation API when no documented headless interface exists.

See [Agent workers](docs/AGENT-WORKERS.md).

## OAuth profiles

Where a CLI officially supports an alternate state directory, ROTOXY can keep independent signed-in profiles without copying tokens.

```bash
rotoxy oauth list
rotoxy oauth add codex work
rotoxy oauth add codex personal
rotoxy oauth add copilot work
```

Codex documents `CODEX_HOME`; Copilot documents `COPILOT_HOME`. Other CLIs are handled conservatively unless stable profile isolation is available.

## Client token

The ROTOXY token is the gateway's own front-door credential. It is not an upstream provider key.

```bash
rotoxy token
rotoxy rotate-token
```

Rotating it revokes clients using the previous ROTOXY token while leaving provider accounts untouched.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Configuration walkthrough](docs/CONFIGURATION.md)
- [Routing and smart routers](docs/ROUTING.md)
- [Agent workers and OAuth profiles](docs/AGENT-WORKERS.md)
- [Client configuration](docs/CLIENTS.md)
- [Use cases](docs/USE-CASES.md)
- [Changelog](CHANGELOG.md)
- [Security model](SECURITY.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Contributing](CONTRIBUTING.md)

## Development

```bash
pnpm install
pnpm build
pnpm test
```

The automated suite covers account rotation, federated provider pools, task/difficulty routing, OpenRouter free-only enforcement, client-token authentication, and worker fan-out.

## License

MIT. See [LICENSE](LICENSE).
