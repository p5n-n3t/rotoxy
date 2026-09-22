# Client configuration

ROTOXY is easiest to use with clients that accept a custom OpenAI-compatible base URL.

## Base URL

For a single Tailscale endpoint:

```text
https://YOUR-NODE.YOUR-TAILNET.ts.net
```

Use the ROTOXY client token as the client's API key.

## OpenAI-compatible path

A client calling `/v1/chat/completions` can keep that path unchanged. ROTOXY forwards it to the selected provider.

## Select a provider

If your client can add custom headers:

```text
X-Rotoxy-Provider: ollama
```

If not, use a provider path:

```text
https://YOUR-ROTOXY/p/ollama/v1/chat/completions
```

## Select a pool

Header:

```text
X-Rotoxy-Pool: fast-code
```

Path:

```text
https://YOUR-ROTOXY/pool/fast-code/v1/chat/completions
```

## Smart routing

If the client controls the model name, use:

```text
rotoxy/auto
```

If it cannot, use:

```text
https://YOUR-ROTOXY/smart/auto/v1/chat/completions
```

## Dedicated Tailscale Services

Advanced installations can expose provider/pool/router aliases as named Tailnet Services. Use `rotoxy endpoints` to see the proposed logical endpoints.

## Important compatibility note

ROTOXY does not magically convert every provider's proprietary protocol into every other provider's protocol. Federated pools are restricted to compatible wire formats. OpenAI-compatible clients therefore work best with providers configured as OpenAI-wire targets.
