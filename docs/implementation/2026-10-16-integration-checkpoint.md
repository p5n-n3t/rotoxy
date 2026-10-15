# Application and delegation integration checkpoint — 2026-10-16

Integrated Web delegation reliability (`ccd97d0` → `cdc58bd`), LightSprint Cloudflare adapter, profile edits/removal, fixed application shell, authenticated compact supervision summary and profile-control routes. Integration HEAD before this report: `265dbca`.

Verification: serial Node suite 361/361 passed in 185 seconds. Initial concurrent run had stale-build shell assertions and two failures; corrected shared status normalizer fallback for legacy status/state fields, reran real Python IPC and Oracle snapshot checks. Focused integration suite 28/28 and shell suite15/15 passed. Python full321 initially had two subprocess deadlines during contention; affected modules28/28 passed separately. Final Python full rerun pending.

Eight Cloudflare accounts passed authenticated catalogs and individual minimal inference; eight encrypted records imported with only `@cf/meta/llama-3.1-8b-instruct` initially allowed. Scoped authenticated ROTOXY `/pool/cloudflare/run` returned verified marker and usage (49 tokens,0.38630515336990356 reported neurons). Remaining allowance unknown. Temporary verification token revoked. No secrets in repository.

Exact operator-identified duplicate Codex profile removed from registry, with mode600 registry backup and isolated auth directory retained. Two other profiles preserved. Root public `/mcp` returns correct OAuth401 challenge; legacy `/token2oauth` compatibility remains.

Browser390/1280 authenticated preview loads Models and Cloudflare without overflow, mobile menu opens. Visual image inspection found desktop menu closed by native details container; desktop `::details-content` fix added and explicit link visibility check required. Preview evidence private in `~/.local/state/token2oauth/batches/20261015/app-wave/`.

Cloud worker integration artifacts are reviewed commits; no source changes from this release deployed yet. Runtime still prior e6c9b86, active and healthy. Deploy after final browser/security/package validation, backing up runtime and SQLite first. No automatic paid recovery, frontier relaunch or Oracle ambiguous retry enabled. Broader requirements remain in 2026-10-15-app-requirements.md.

Current cloud assignments: UNI-API (unified OpenAI-compatible inference catalog), UNI-RULES (durable resource routing policy), UNI-WORKSPACE (real-data visual command centre), all isolated branches based265dbca, bounded540seconds and observedUSD0.40 per assignment. Ledger `~/.local/state/token2oauth/batches/20261016/unified/`; runner restores strict policy in finally. One root MCP URL and separate inference API are intentional protocol surfaces; workspace-only providers are excluded from chat-completion catalogs.
