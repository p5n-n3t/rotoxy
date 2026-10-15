# Unified resource routing rules

Base: `origin/codex/unified-platform-20261010` at `265dbca381b404691c6e14210c6530bf0db9c96e`. Branch: `codex/rotoxy-unified-rules-20261016`.

`ResourceRoutingRulesStore` reads and atomically replaces a version-1 JSON policy at `resource-routing-rules.json`. Replacement runs under `StateStore.update`'s cross-process lock. The closed schema contains `unknownCapacity`, per-family `providerCaps`, and per-resource `enabled`, `weight`, and optional `capacity`; unknown fields and out-of-range values are rejected. Rules have no credential fields, so the file stores policy only and does not duplicate secrets or encrypt nonsecret metadata. `template()` returns a starter JSON document.

`planResourceRouting` is pure. It requires enabled, authenticated, healthy resources with matching model/capability/context metadata; rejects depleted quota; represents missing or expired quota as unknown; and treats unreported account/provider capacity conservatively using `unknownCapacity` (default 1). It uses weighted normalized task load with a cursor tie-break, preserves sticky ownership without fallback, and assigns only unique non-running work up to the fanout and idle capacity caps. The result includes bounded explanations and eligible/rejected resource evaluations. Oracle advice is omitted; the planner cannot infer authorization from advisory data.

Focused validation: `npm run build` and `node --test test/resource-routing.test.mjs`. No server, UI, account data, credentials, or production configuration was changed. Root integration remains responsible for supplying trustworthy resource metadata and wiring this planner into a dispatch path; this module does not itself dispatch work.
