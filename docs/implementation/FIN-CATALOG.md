# FIN-CATALOG checkpoint

Branch `codex/rotoxy-catalog-policy-20261016` starts from fetched `origin/main` at `3389fde1e1dc1160461ba28d4f5953cd6c4f6206`.

The unified model catalog now applies each Ollama account's routing-rule `allowedModels` to the provider's returned IDs before adding either the namespaced or raw catalog entry. An absent list retains the provider catalog; an empty list contributes no models. Routing rules were already part of the cache version digest, so edits invalidate cached catalog results. OpenAI and OpenRouter model lists continue to come from their configured exact account allowlists; changes to those accounts already participate in the catalog digest.

Focused injected-fetch regressions cover account-specific Ollama filtering, absent/empty rule behavior, external allowlist cache invalidation, provider-specific output-cap defaults and clamps, and rejection of simultaneous cap parameters before a provider call. Existing scoped-auth/no-replay coverage remains in the same focused files.

Validation: `npm run build` passed; `node --test test/unified-model-api.test.mjs test/inference-providers.test.mjs` passed (11 tests). No paid/provider request was made. The full repository suite was intentionally not run for this bounded assignment.
