# Ollama Cloud model pool checkpoint

## Scope and evidence

This change adds a native, opt-in Express router and separate encrypted credential store to Token2OAuth. It does not alter MCP accounts, OAuth scopes, existing MCP routes, or production configuration. Provider requests use the fixed `https://ollama.com` origin; caller input cannot select a host. Model keys are encrypted with the existing Token2OAuth master key and AES-GCM helper in `model-credentials.json` (directory mode 0700, file mode 0600). Model gateway tokens are independent random bearer tokens; only SHA-256 hashes, expiry, and the `model:read` / `model:invoke` scopes are stored. The administrator password is never accepted as a model token.

ROTOXY predecessor behavior was reviewed in the public MIT repository (`src/config.ts`, `src/router.ts`, `src/types.ts`): provider-specific endpoints and account selection are separate, and configured provider accounts can rotate. This implementation reuses those behavior boundaries, not source code. Attribution: ROTOXY, copyright 2026 p5n-n3t, MIT License, https://github.com/p5n-n3t/rotoxy/blob/main/LICENSE.

Official docs were checked 2026-10-12: Ollama Cloud at https://docs.ollama.com/cloud and OpenAI compatibility at https://docs.ollama.com/api/openai-compatibility. The latter documents `/v1/models` and `/v1/chat/completions`; the Cloud docs identify `ollama.com` as the hosted service. No model pricing/quota or account capacity is inferred.

## Contract

`createModelGateway(store, options?)` returns `{ router, credentials }`. Mount `router` at `/` inside `buildApp` before the app's final 404 handler; the module recognizes `/v1/models`, `/v1/chat/completions`, `/p/ollama/v1/*`, and `/pool/ollama/v1/*`. Only GET models and POST chat completions are currently accepted; other provider paths return 404. Each model request needs a gateway-issued scoped bearer token. Root admin wiring should instantiate the gateway once and expose `credentials` only behind the existing admin session + CSRF checks.

Admin integration surface: `credentials.addCredential(label, apiKey)`, `rotateCredential(id, apiKey)`, `setCredentialEnabled(id, enabled)`, `listCredentials()`, `issueToken({scopes, expiresInSeconds})`, and `revokeToken(id)`. Token lifetime is 60 seconds through 90 days; the plaintext is returned once by `issueToken`. Local migration code may call `migrateLegacyOllamaCredentials(credentials, suppliedConfig)`; the helper accepts caller-supplied keys and never reads operator files or prints keys. It returns only generated IDs and a count.

Selection is round-robin among enabled accounts that are not cooled down and below a local in-flight cap (default 2). That cap is software policy, not Ollama capacity. 402/429 cool down the responding account and are not replayed. 401/403 disable that configured key for admin review. 5xx, redirects, timeout, disconnect, and transport ambiguity are not retried. Streaming chat responses use backpressure and downstream cancellation; catalog responses are capped at 2 MiB, requests at 4 MiB. Provider error bodies are withheld to avoid reflecting credentials; authorization is never copied to clients. No cost/quota metrics are fabricated.

## Verification and remaining seams

`test/model-gateway.test.mjs` constructs `StateStore` only after setting unique temporary `TOKEN2OAUTH_CONFIG_DIR` and `HOME`. It checks key encryption/mode, key rotation, scoped-token isolation and revocation, native fixed-origin routes, round-robin account selection, rate-limit cooldown without retry, streaming, and ambiguous-call no-replay. Provider fetch is synthetic; no live account was used.

Root-owned follow-up: instantiate and mount the returned router in `src/server.ts` before its terminal 404; add an admin UI/API for encrypted key add/rotate/disable and one-time model-token issuance/revocation guarded by current admin + CSRF middleware. Do not issue these tokens from OAuth DCR or treat `mcp`, `jobs:read`, or `jobs:write` as model scopes. There is no live-provider, quota, cost, or account-capacity verification in this checkpoint.
