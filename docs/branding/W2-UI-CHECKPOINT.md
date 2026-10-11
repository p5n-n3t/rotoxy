# Checkpoint T2O-W2-UI (2026-10-12)

Branch `codex/t2o-w2-ui-opus-20261012`, based on `origin/main` at `00e6e8f`.

## Done

- `src/ui.ts`: the admin console now uses the shared light/dark relay-gate theme. Gradients and frosted glass are removed, there is an SVG mark and favicon, a focus ring, reduced-motion support and responsive rules down to 390px. Routes, forms and CSRF are unchanged.
- `test/admin-ui-design.test.mjs`: tests for the theme, mark, CSRF and mobile layout.
- `DESIGN.md`: new section on the admin console.

## Not done

- No headless browser is available in the sandbox, so no screenshots exist.
- `src/admin.ts` and `src/supervisor-ui.ts` are untouched; the supervisor page already used this theme.

## Integration patches for files I don't own

- `src/html.ts#adminNav`: add a Supervisor link, `link("/admin/supervisor", "Supervisor", "supervisor")`, once a route without a project ID exists.
- `src/oauth.ts` consent page: reuse `page()` or `brandMarkup()` and drop its gradient CSS.
- `src/supervisor-api.ts` CSP: add `img-src data:` so the supervisor favicon loads.

## Overview composition (follow-up to dde6920)

`/admin` now opens with an operational overview rendered by `renderOverview()` in `src/ui.ts`:

1. **Heading and verdict.** The first line states how many credentials can route and how many need attention, all counted from `pool.snapshot`. Next to it are links to `/admin/supervisor`, Accounts and Routing settings.
2. **Status row.** Routable, needs attention, requests seen, success rate, latency p50/p95, and quota/capacity.
   - The request, success and latency figures come from `telemetry.summary()`. Until a request is observed they show "Not observed".
   - Quota/capacity always shows **Unknown**, because no provider reports remaining quota.
3. **Routing narrative and account bar.** The narrative is built from the configured upstream host, strategy and failover limit plus the live account buckets. The bar shows healthy, untested, depleted, auth-failed and disabled accounts.
4. **Recent requests.** Up to 8 request/attempt events from `telemetry.recent()`, each with tool, account label, status, retries and latency. If none are observed it shows an explicit empty state.
5. **Endpoint and accounts.** The endpoint card now describes one MCP connection for any compatible client, not only ChatGPT. The accounts table is unchanged and has the anchor `#accounts`.
6. **Disclosures.** Routing and upstream settings sit in a `<details>` disclosure (`#settings`). Add credential is in a second disclosure (`#add-credential`), which opens by default when the pool is empty.
   - Every form action, field name and ID (including `pool-strategy`) and the strategy script are unchanged.
   - CSRF is still injected by `withCsrf`; the existing integration and admin-security tests pass.

Not done: there are still no rendered screenshots, because no browser is available in this sandbox.
