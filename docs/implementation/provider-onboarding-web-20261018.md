# Provider onboarding implementation — 2026-10-18

Branch: codex/provider-onboarding-web-20261018
Base: 813c66fe3fcd1d1805396ba128e85ce5046bab07 (fetched origin/main on 2026-10-18)
Local isolated worktree: /home/jq/Desktop/ROTOXY/.worktrees/provider-onboarding-web-20261018

## Initial inventory

ROTOXY already had an encrypted account store for OpenAI, OpenRouter and custom HTTPS OpenAI-compatible providers, plus enabled states, origin-bound credentials, edit/remove, persistent model allowlists and routing checks. Metadata-only /models discovery was already implemented with bounded parsing and pinned HTTPS public transport. Cloudflare already had encrypted accounts, a fixed-host Workers AI adapter, paginated catalog discovery, and a selectable-model admin UI. Admin session authentication, CSRF and scoped model tokens were already present. No parallel provider registry or credentials store is needed.

## What changed

Inference onboarding adds a saved-account Test connection action using only GET /models. It tests the saved credential and model-list endpoint, never invokes a paid completion, and reports the timestamp, number of parseable model IDs, and an explicit inferenceVerified=false flag. Disabled accounts can be tested without enabling routing. It distinguishes missing accounts, endpoint-change credential rotation requirements, 401/403, 404, unexpected rejection, invalid or oversized model JSON, and unavailable DNS/TLS/transport. No upstream body, secret or resolved IP is included in browser-facing errors. A successful model-list request does not establish chat-completion execution compatibility.

The existing provider picker adds Clear entire allowlist alongside select/clear shown, preserves saved IDs during refresh failures and empty catalogs, and labels manually entered or catalog-absent IDs unverified. Custom-provider URL form guidance now permits the existing supported HTTPS base path, such as /v1. The form explicitly differentiates inference endpoints from agent/workspace providers, local and remote agent clients and search/extraction tools. Only bearer-token chat-completion endpoints with model-list metadata are supported by these controls; arbitrary saved URLs are not promised compatibility.

Cloudflare Workers AI now offers account-specific catalog refresh (including disabled accounts), keeps each account's current-process catalog and capture timestamp distinct, and preserves the global catalog refresh for compatibility. The picker adds Select shown, Clear selection and explicitly unverified manual model IDs. Saved selections continue to be enforced by the existing credential and routing-rule stores. Catalog errors distinguish authorization failure (401/403), missing account and network/other problems while preserving previous selections. The list no longer uses nested scroll containers. Catalog GET is nonbillable metadata; no inference was launched.

## Operator setup

1. Open authenticated /admin/inference, add a fixed preset account or create a custom provider with its public HTTPS base URL and then add an encrypted bearer-token account.
2. Test connection. Successful model listing does not verify inference. Refresh catalog, search and select IDs, optionally add unverified manual IDs, and save. Empty model selections block inference.
3. For Cloudflare, open /admin/cloudflare, add the account ID and API token with Workers AI permissions. Refresh that account catalog, search/select or manually enter IDs, save. Selected models are allowed to route, not guaranteed available or free. Clearing selection blocks inference.

Existing preset URLs, credential encryption, origin pinning, TLS verification, SSRF checks, no-redirect policy, bounded request sizes and admin CSRF/auth are preserved. This change does not support private/tailnet endpoints that the existing policy forbids; no new special bypass is added.

## Verification

Synthetic-only tests: focused Node set 17/17 passing after a fresh TypeScript build. These cover model selection persistence and clearing, disabled model rejection before upstream calls, edit/remove references, catalog filtering and price metadata, invalid endpoints, secret redaction, status codes, disabled-account discovery and Cloudflare per-account selection. Evidence: /tmp/rotoxy-provider-onboarding-tests-20261018.log; build log /tmp/rotoxy-provider-onboarding-build-20261018.log. Full-suite and headless browser result will be appended separately.

No live provider credentials, billing APIs, paid inference, deployment, worker restarts, migrations or service changes were used.

## Source and documentation verification (2026-10-18)

OpenAI List models: https://developers.openai.com/api/reference/resources/models/methods/list
OpenRouter List models: https://openrouter.ai/docs/api/api-reference/models/get-models
Cloudflare Workers AI Model Search: https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/
Cloudflare Workers AI REST API: https://developers.cloudflare.com/workers-ai/get-started/rest-api/
Cloudflare AI Gateway REST API and protocol distinctions: https://developers.cloudflare.com/ai-gateway/usage/rest-api/

## Compatibility, ownership, limitations

No migration and no existing account values changed. Stored allowlists remain authoritative after catalog refresh failure or restart; catalog cache is process-local and is not entitlement evidence. Editing a custom provider's origin intentionally invalidates the origin-bound credential until the key is replaced.

Onboarding-specific: src/inference-provider-admin.ts and src/cloudflare-admin.ts.
Shared backend model metadata: src/provider-model-catalog.ts.
Shared Cloudflare adapter (metadata-only optional account argument): src/cloudflare-ai.ts.
Focused tests: test/provider-onboarding-web.test.mjs and test/cloudflare-onboarding-web.test.mjs.
Documentation: docs/implementation/provider-onboarding-web-20261018.md.

No supervisor, startup, Oracle, LightSprint, workspace, shared navigation or credential-infrastructure files were changed.

Remaining: live provider-specific chat compatibility and entitlement checks require deliberate operator consent and are not inferred from model-list success. More protocols or auth methods require an explicitly scoped follow-on task; a provider URL alone is not enough.

## Final verification appendix — 2026-10-18

- Fresh TypeScript build: PASS, using the same existing dependencies from the integration checkout (read-only temporary node_modules symlink). No dependency/lockfile changes. Build log: /tmp/rotoxy-provider-onboarding-build-20261018.log.
- Focused seven-file Node tests: 17 passed, 0 failed. Log: /tmp/rotoxy-provider-onboarding-tests-20261018.log.
- Full bounded Node test suite (node --test --test-concurrency=3 test/*.test.mjs): 487 passed, 0 failed, 0 cancelled, 0 skipped, runtime 91.7 seconds. Log: /tmp/rotoxy-provider-onboarding-fulltests-bounded-20261018.log. An earlier default-unbounded attempt exhausted local concurrent runner capacity and was not used as acceptance evidence.
- Real Google Chrome headless rendered the synthetic inference and Cloudflare admin pages at 1280x920 with isolated browser profiles and local temporary state. DOM assertions passed for account labels, model controls and the absence of synthetic secrets. Screenshots: /tmp/rotoxy-provider-inference-20261018.png and /tmp/rotoxy-provider-cloudflare-20261018.png. Manual pixel-level visual inspection was not performed; this is browser rendering/DOM smoke evidence, not a full interactive accessibility audit.
- Git diff whitespace check: passed before commit. No live provider connections, real tokens or billable inference were used.
