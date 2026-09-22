# Contributing

Before submitting a change:

```bash
pnpm install
pnpm build
pnpm test
```

Design rules:

- Keep provider accounts separate from provider pools.
- Keep API-provider routing separate from OAuth agent workers.
- Do not add undocumented credential scraping.
- Do not silently route OpenRouter to paid models when free-only policy is enabled.
- Default CLI output should be human-readable; raw JSON belongs behind `--json`.
- Prefer one stable endpoint. Endpoint proliferation must remain optional.
- Add deterministic tests for routing behavior.

Provider adapters should document their wire format, authentication header, model-list endpoint, and policy constraints.
