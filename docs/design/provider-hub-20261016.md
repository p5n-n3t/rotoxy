# Provider hub

`createProviderHubRouter(store, sessions)` adds a read-only authenticated `/admin/providers` directory. It groups model APIs separately from agent execution, points each “add/manage” action at an existing route, and links the private fleet to `/admin/oracle`.

The page obtains only credential-free metadata through `InferenceProviderStore.listAccounts()`, `CloudflareCredentialStore.listCredentials()`, and `ModelCredentialStore.listCredentials()`. It shows stored labels and enabled counts; those describe local configuration, not a live health check. The page makes no provider request and never decrypts or renders a secret. The shared `page`, `adminNav`, and `withCsrf` helpers provide the app shell and logout CSRF token; the route adds no-store, nosniff, referrer, and restrictive CSP headers.

OpenCode and Hermes are presented as agent/client setup, never as inference vendors or imported model/login providers. Claude Code and the other external clients are labeled manual setup; the existing Codex profile page is configuration. Nothing here starts a worker or changes account configuration.

Focused coverage: `node --test test/provider-hub.test.mjs` after `npm run build`. The HTTP test uses a temporary `HOME` and `TOKEN2OAUTH_CONFIG_DIR`, synthetic encrypted-store entries, and verifies authentication, base-path links, HTML escaping, redaction, and destination routes. It does not contact providers or verify external client setup live.
