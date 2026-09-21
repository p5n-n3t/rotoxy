# ROTOXY

ROTOXY is a local API-key rotation proxy with Tailscale exposure, per-account/model usage telemetry, and an interactive installer.

It replaces the old `oproxy` + `private-api-proxy-key-rotator` combination.

## What it does

- Runs the proxy on loopback by default: `127.0.0.1:2025`.
- Rotates requests across multiple upstream API keys.
- Temporarily cools down keys that return HTTP 429, 401, or 403.
- Protects the proxy with its own ROTOXY client token. Upstream provider keys are never exposed to clients.
- Tracks request count plus input/output/total tokens by account and by model when the provider response exposes token usage.
- Dynamically queries models accessible to each configured account.
- Supports Tailscale Serve for tailnet-only HTTPS, Funnel for public HTTPS, or local-only mode.
- Can run at boot/login with a systemd user service.

## Quick install

```bash
git clone https://github.com/p5n-n3t/rotoxy.git ~/rotoxy
cd ~/rotoxy
./install.sh
```

The installer checks dependencies, offers Tailscale installation, lets you authenticate using either a Tailscale auth key or browser login, asks for a provider, and then accepts API keys as:

```text
Account 1 API key:
Account 2 API key:
Account 3 API key:
...
```

Leave the next API-key prompt blank to finish the stack.

## Providers

Built-in presets include Ollama Cloud, OpenAI-compatible APIs, Anthropic, OpenRouter, Groq, Together, DeepSeek, Mistral, and a generic/custom destination.

Provider support means ROTOXY can rotate credentials and forward traffic using the configured authentication header. Individual providers still have their own URL paths, headers, API semantics, quotas, and terms.

## Tailscale modes

### Serve: recommended default

`Serve` exposes ROTOXY only to devices/users allowed by the tailnet policy. Use this when all clients can join the tailnet.

### Funnel: public HTTPS

`Funnel` publishes the ROTOXY HTTPS endpoint to the public internet. ROTOXY still requires its independent client token, but the endpoint itself is internet-reachable.

### Tailscale Services

Tailscale Services are useful when you want a stable service identity that is not tied to one node, especially for multiple ROTOXY hosts, failover, or traffic steering. ROTOXY's installer currently configures node-level Serve/Funnel because it is simpler for a single-machine install. A Tailscale Service can be layered on later without changing the local ROTOXY backend.

## CLI

```text
rotoxy up
rotoxy down
rotoxy restart
rotoxy status
rotoxy doctor
rotoxy health
rotoxy usage
rotoxy models
rotoxy url
rotoxy token
rotoxy rotate-token
rotoxy configure
rotoxy autostart on|off|status
rotoxy logs [N]
```

## Usage meter

`rotoxy usage` records actual token counts reported in provider responses. It understands common Ollama, OpenAI-style, Anthropic-style, and Gemini-style usage fields.

The displayed `meterRemainingPercent` is deliberately a local normalized 100-to-0 meter. It is not claimed to be the provider's billing/quota balance unless a future provider adapter can retrieve an authoritative quota denominator.

The default local denominator is `1,000,000` tokens per account and can be changed with `ROTOXY_METER_BUDGET_TOKENS`.

This avoids inventing a fixed Ollama Cloud free-token allowance when Ollama does not expose one through the proxy response.

## Model discovery

`rotoxy models` queries each configured account independently. This is preferable to shipping a hard-coded free-model list because availability can vary by account/plan and change over time.

## Security

- `.env` is mode 600 and ignored by Git.
- The ROTOXY client token lives at `~/.config/rotoxy/token` and is mode 600.
- API keys are never printed in normal logs or status output.
- Status surfaces only a short SHA-256 fingerprint for each key.
- The backend listens on loopback unless explicitly reconfigured.
- Public Funnel requests must still present the ROTOXY client token.

## Development

```bash
pnpm install
pnpm build
pnpm start
```

Node.js 20+ is required.
