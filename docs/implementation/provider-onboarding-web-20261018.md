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

## Independent PR review and final integration QA — 2026-10-18

Scope: reviewed existing draft PR #12 in the isolated worktree. Fetched origin/main remained at `813c66fe3fcd1d1805396ba128e85ce5046bab07`; the integration checkout was at that same commit with only its previously existing untracked output images/package artifact. No integration agent files were modified. A non-destructive `git merge-tree --write-tree origin/main HEAD` generated a merge tree without conflicts; the local feature branch still must be reviewed/reconciled against any *future* concurrent changes before merge.

### Findings, fixes and security review

- **High-impact UI regression fixed:** the inference page's inline browser script contained an escaped slash regular expression that became a JavaScript comment when rendered by its TypeScript template string, producing `Unexpected token 'const'`. Consequently, catalog actions were inert despite passing HTTP tests. Replaced that expression with a path-slice based on the known admin route, avoiding string-template escape ambiguity. Added a Node VM regression that compiles the actual rendered inline script. A real Chrome interaction run now passes end to end.
- **Model selection polish:** manually typed model IDs now redraw visible checkbox state; saved IDs absent from a refreshed Cloudflare catalog are explicitly marked unverified. Both pages have concise three-step mobile-friendly setup instructions and accessible expandable compatibility/billing details.
- **Security audit:** the new metadata-only OpenAI-compatible checks still require admin session and valid CSRF, use the saved encrypted and origin-bound credentials, send a single bounded GET /models through the existing pinned/public-only HTTPS transport with strict TLS and no redirect, and return only safe status codes/counts. Native Cloudflare catalog discovery remains at the fixed Cloudflare API host with saved encrypted bearer references and no inference POST. Enforced model allowlists and scoped inference credentials are unchanged; test suites include forbidden-host rejection, model gating, CSRF, redaction, and edit/remove tests. No private/tailnet exemption was introduced.
- **Integration boundaries:** changed files are provider-specific admin routes, the existing model metadata service, an additive optional Cloudflare adapter catalog selector, tests, and this document. No change to supervisor/Oracle/LightSprint/startup/agent workspace, shared navigation, global credentials or production configuration. No schema migration.

### Live browser and build evidence

Local synthetic-only QA used Chrome 155 in headless mode at **1360x900** and **390x844**, exercising:
- OpenRouter /models discovery, price-backed free filter, select shown, clear entire selection, persistence after submission, and metadata-only connection result. Tested keyboard typing and focus on the mobile search input.
- Cloudflare disabled-account catalog discovery, searchable model choices, select shown, manually typed model ID, enable/save persistence, and mobile keyboard search interaction.
- Both routes rendered with **zero browser JavaScript exceptions, no document-level horizontal overflow, no offscreen buttons in view, and no nested vertical scroll traps** at both viewports. Visual screenshots were captured and preview-inspected; this is not an exhaustive assistive technology audit.

Synthetic screenshot directory: `/tmp/rotoxy-provider-review-20261018/` (four full-page screenshots). Browser run details and geometry: `/tmp/rotoxy-provider-review-ui-20261018.json`.

Fresh TypeScript build: PASS, `/tmp/rotoxy-provider-review-build-20261018.log`. Focused post-review tests: 9/9 PASS, `/tmp/rotoxy-provider-review-focused-20261018.log`. Complete Node suite with bounded concurrency 3: **487 passed, 0 failed, 0 cancelled, 0 skipped**, `/tmp/rotoxy-provider-review-fulltests-20261018.log`. All tests/QA used temporary synthetic state and stubbed provider metadata; no live provider API, billable inference, account balance, worker restart or deployment.

Official documentation inspected on 2026-10-18: OpenAI list models, OpenRouter model list with pricing strings, and Cloudflare account-scoped Workers AI Model Search with Workers AI Read or Write bearer token permissions. Their URLs are listed above. Model metadata is not an entitlement or execution guarantee.

### Exact Codex acceptance and remaining actions

1. Fetch `origin/main` and `origin/codex/provider-onboarding-web-20261018` and review [draft PR #12](https://github.com/p5n-n3t/rotoxy/pull/12). Inspect the latest final head SHA on the PR rather than using the original `6747026` review baseline.
2. Check for newly created uncommitted changes in the integration agent checkout; **do not overwrite them**. Re-run non-destructive conflict analysis before any merge. The review found no conflict at the 2026-10-18 fetched main, but cannot predict future agent edits.
3. Integrate only after coordinated review. There is no data migration; model allowlists remain authoritative, catalog results remain process-local, and origin-bound credentials must be replaced when the URL changes.
4. Optional *separately authorized* live metadata/authentication verification can use an operator-approved provider credential. Real model availability and paid inference are **not verified** here. Do not run billable inference, change billing, or consume other accounts during this task.

This remains an isolated source change awaiting Codex merge coordination. Nothing was deployed, restarted, or merged to main.
