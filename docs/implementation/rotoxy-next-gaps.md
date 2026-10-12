# ROTOXY unification checkpoint — 2026-10-12

Base: fetched `origin main` at `a7b7a30545d2fdd90d845a3a2003eaa973926927`; `git ls-remote origin refs/heads/main` resolved to the same commit and confirmed it is an ancestor of this worktree. Origin is `https://github.com/p5n-n3t/token2oauth.git`. Research branch: `codex/rotoxy-codex-research-20261012`. Only research/checkpoint docs changed; no runtime behavior or operator enrollment was tested. The first documentation commit's successful push is recorded below; the checkpoint follow-up push is reported with the final HEAD.

Push evidence: pending initial commit.

## Five concrete shipping seams

1. Local Codex profile registry: distinct `CODEX_HOME`, private permissions, CLI/version/status checks, lifecycle cleanup, and profile-thread affinity. Existing encrypted upstream-token storage is not a Codex session store.
2. User-mediated official browser/device login with cancellation/completion; honor OpenAI's hosted/commercial App Server-auth restriction. Never copy token files.
3. App Server account, actual-model, and reported-rate-window snapshots. Keep plan, token activity, service health, and quota distinct; unknown stays unknown.
4. Profile/model-aware task admission and resume with deterministic eligibility, cooldown, operator caps, continuation affinity, and fair weights among eligible profiles—without limit evasion.
5. Fixed routing evaluation and schema-bounded Oracle advice before claims of smart routing; measure task quality and latency against baselines.

Preserve Token2OAuth OAuth/MCP and bearer-pool compatibility. Selectively reuse predecessor ROTOXY's MIT-licensed isolated-home and official CLI invocation patterns; do not restore its broader API-provider/federated pool by default. Preserve upstream notices for later source/asset reuse; the predecessor logo was not copied. Root follow-up: sequence profile/auth/model snapshots before dispatch, then evaluate routing. Operator-local enrollment and real account behavior remain unverified because this cloud workspace cannot access operator-local files. No runtime feature, live quota, or real-provider integration is claimed.
