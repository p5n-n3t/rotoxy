# Decision routing and LiteLLM — 2026-10-12

## Advisory model, deterministic gate

Use a small router only for bounded labels (task type, urgency, context band, candidate profiles, uncertainty) or advisory cost/capability suggestions. Strictly validate its schema. Deterministic admission must reject disabled/unhealthy profiles, a model absent from the signed-in profile's actual `model/list`, reported exhausted windows, and operator-policy violations. Missing evidence stays unknown under explicit local policy; the model cannot grant entitlement, quota, or purchase authority.

Re-evaluate on meaningful events: task accepted, profile/model change, rate-limit update, failure/cooldown, or policy edit—not on an LLM timer. Preserve continuation affinity. Distribute independent work fairly by configured weights among healthy, eligible profiles; do not force equal shares across exhausted, unhealthy, disabled, or incompatible profiles. Availability is not a limit-evasion mechanism.

Before shipping learned routing, compare deterministic baselines and single-profile routing on a fixed, versioned set covering easy/hard coding, research, extraction, large context, unknown quota/model, and failed profiles. Blind-review outcome quality with a written rubric; separately measure latency, failure rate, and provider-reported usage. Require fail-closed behavior and quality gains worth added latency/cost. Oracle advice is not an architect or authority for destructive choices.

## LiteLLM: defer for subscription Codex

LiteLLM's [official routing docs](https://docs.litellm.ai/docs/routing), accessed 2026-10-12, describe a Python API-model gateway with weighted, rate-aware, least-busy, latency/cost routing, optional Redis coordination, and fallback/retry features. This can benefit a separately scoped API-key fleet needing a common API surface and distributed RPM/TPM controls. It does not establish support for ChatGPT subscription Codex identities or the official per-profile App Server lifecycle; OpenAI separates API pricing from subscription usage.

Installed Token2OAuth is TypeScript and already has encrypted bearer-account storage, health/cooldown eligibility, weights, sticky sessions, conservative retry rules, provider capability snapshots, telemetry, and a local scheduler. A Python proxy/Redis fleet would duplicate operations without supplying the missing Codex profile/auth contract. Keep native TS for subscription-profile orchestration. Revisit LiteLLM only for a proven, separately scoped API-key gateway need; never route subscription credentials through undocumented endpoints.
