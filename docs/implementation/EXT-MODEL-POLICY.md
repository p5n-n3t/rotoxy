# Exact model policy checkpoint

Base: `origin/codex/unified-platform-20261010` at `d03dea1a1cbc50596c2c9e580f5a1b4ecad48fba`. Isolated branch: `codex/rotoxy-model-policy-20261016`.

Account routing entries now accept optional `allowedModels`, validated as at most 200 exact model IDs (no wildcard or unknown nested fields). Omission preserves the existing adapter behavior; `[]` denies inference for that account. Cloudflare policy is intersected with the credential's existing allowlist. Ollama checks the exact `model` from bounded request JSON before selecting/decrypting a credential or calling the provider. Model-list requests are unaffected. The routing page explains these rules and examples.

Focused regression coverage exercises the real authenticated/CSRF-protected editor and fake-fetch Cloudflare/Ollama requests, including no-policy behavior, empty-list denial, exact mismatch rejection before provider I/O, Cloudflare allowlist intersection, catalog access, and wildcard rejection. Root-owned catalog filtering and shared navigation remain integration work; this change does not modify server, unified API, or shared HTML files.
