# ROTOXY resource connections checkpoint

Assignment: `RX-CONNECTIONS`; branch `codex/rotoxy-connections-20261012`, based on full commit `a7b7a30545d2fdd90d845a3a2003eaa973926927`.

## Deliverable

`createResourceConnectionsRouter(store, sessions)` provides a private admin page and authenticated API for Exa, Firecrawl, and Tavily credentials. Credentials are created as correctly provider-tagged `StateStore` accounts (encrypted by the existing store) and are never returned. The owner-private `web-tools.json` mapping uses atomic replacement, records only selected provider/account/feature bindings, and stores per-client permissions only for currently registered OAuth clients. All tool access starts denied. The UI separates provider account entry from Models & APIs feature/client selection and labels stored credentials as not provider-tested; Exa usage/credit figures are not credentials.

`CredentialPool.pick` retains generic bearer compatibility but filters Exa, Firecrawl, and Tavily accounts unless the configured HTTPS MCP upstream matches that provider's canonical MCP profile. Tavily has no canonical MCP profile in the current catalog, so Tavily API keys are never eligible for MCP proxy traffic.

## Required integration seam (outside assigned files)

Before exposing the page, `server.ts` must add `router.use(createResourceConnectionsRouter(store, sessions))` before `ui.router` and choose `options.webToolsConfigPath ?? join(store.dir, "web-tools.json")` when initially loading web tools. The parent/root must reload `loadWebToolsConfig` on each web-tool call (or provide equivalent request-time reload), since this router intentionally does not own the proxy's runtime instance. The proxy's existing pinned-session branch selects the owner directly rather than calling `CredentialPool.pick`; add `pool.isCompatibleAccount(owner, state)` there and return its established owner-unavailable response if false. These source edits are outside the authorized ownership list and were not made here.

## Validation

The new tests set both `HOME` and `TOKEN2OAUTH_CONFIG_DIR` before constructing `StateStore`. They cover auth/CSRF/epoch checks, encrypted key storage, private file mode, known-client-only permissions, redaction, status labeling, loading the saved mapping through `loadWebToolsConfig`, generic account compatibility, provider-specific pool isolation, and rejection before mismatched health-probe network I/O. `npm test` passed: 296 tests, 0 failures (includes TypeScript build). Credentials were mock values only; no provider calls, production config edits, or deployment occurred.

The connected label means an enabled matching account has an encrypted credential stored; it does not claim that the provider accepted the key. The checkpoint-only feature remains unwired into the running app until the integration seams above are applied.
