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
