# Account routing controls checkpoint

Base: `origin/codex/unified-platform-20261010` at `9b3a1ac022ff082a36d3b9b34c503b80f053b0a2`. Work is isolated on `codex/rotoxy-routing-controls-20261016`.

`ResourceRoutingRulesStore` persists a strictly validated, secret-free JSON document through the existing `StateStore` lock and atomic file replacement. The new `/admin/routing` router requires the existing admin session and CSRF token, provides an editable JSON document and read-only empty template, and lists the current Ollama/Cloudflare account IDs. Cloudflare and Ollama request selection now excludes per-account disabled rules and applies weighted sequential selection; configured capacity is clamped to the existing per-account adapter limit (Cloudflare default 1, Ollama default 2). No-rule selection keeps the existing round-robin/least-inflight behavior. Session affinity and provider retry behavior are unchanged.

`providerCaps` remains planner-only: live adapters have no cross-process shared reservation, so the page explicitly says these caps are not enforced for live requests. Runtime configuration was not changed.

Integration seam for root: mount `createResourceRoutingAdminRouter(store, sessions).router` in `src/server.ts` and add `/admin/routing` to shared navigation; those files are outside this assignment. Router export is `src/resource-routing-admin.ts`.

Checks: `npm run build`; focused `node --test` for `resource-routing-controls`, Cloudflare AI, model gateway, and resource-routing tests. The first focused pass exposed test harness redirect-following behavior; the test now inspects redirects directly. No full suite, deployment, or real provider calls were run.
