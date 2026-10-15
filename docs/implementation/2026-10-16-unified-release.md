# ROTOXY unified application release — 2026-10-16

Deployed source: `9b3a1ac022ff082a36d3b9b34c503b80f053b0a2`. Primary repository remains `p5n-n3t/token2oauth`; the distinct predecessor repository has not been overwritten.

## Verified functionality
- Public root MCP: `https://jq-xubuntu1.bigeye-escalator.ts.net/mcp`. Existing mounted OAuth metadata and legacy `/token2oauth` paths remain compatible. Unauthenticated requests receive the correct challenge.
- Public inference base: `https://jq-xubuntu1.bigeye-escalator.ts.net/v1`. Scoped model tokens, independent of admin password. Live catalog returned41 entries including provider-prefixed IDs and legacy Ollama aliases, not41 unique models. Actual Cloudflare OpenAI-format completion passed through the public Funnel with a47-token provider report.
- Eight supplied Cloudflare accounts independently passed catalog and minimal execution tests. Encrypted credentials imported, small verified model initially allowed. Account CRUD and model allowlists are available under `/admin/cloudflare`. Remaining allowance unknown; reported neurons are request usage.
- Application sidebar with responsive mobile menu; `/admin/workspace` provides a live authenticated resource snapshot/map. Resource map describes configured pools, not inference traffic. Current snapshot excludes Oracle/Codex-specific groups pending the next worker contribution.
- Web delegation-reliability handoff integrated. Provider errors outrank idle state, typed transcript association avoids stale completion, incidents persist and approvals remain handoffs. Compact owner-scoped summary at `/admin/api/v1/supervisor/:projectId/summary`.
- Codex/Ollama profile edit/removal controls integrated. Exact duplicate `2_Plus_ecummings6969@hotmail.com` removed from registry with private backup; auth directory retained and two other profiles preserved.
- Tools page distinguishes upstream tool counts from gateway definitions and client-specific scope filtering.

## Verification
Full serial Node suite368/368 pass. New module integration focused24 tests initially23passed with one outdated CSRF form-count assertion; corrected assertion checks every POST form and its8-test module passed. Browser tests authenticated1280/390: Models, Cloudflare and Workspace200, no horizontal overflow, desktop Private workers link visible and mobile menu opens. Screenshot review caught and fixed native-details desktop navigation issue. No supplied Cloudflare token found in tracked source.

Python full321: first concurrent run had two subprocess deadline errors; affected28tests passed separately. Later full run320passed with one timing-sensitive headless exit-code assertion; isolated headless5tests passed. Do not describe this as a green full Python run. Headless paid recovery remains disabled.

Installed public doctor: process/config/credentials/upstream initialization/OAuth/tools/Funnel all pass. Gateway, Oracle pool, monitor and foreground Funnel active. Manual lifecycle and boot-off policy retained. Packaging helper corrected npm JSON shape, omitted ephemeral sockets from backup and set CLI executable bits. No credential/data migration was required.

## Recovery
Runtime backup: `~/.local/share/token2oauth-pre-unified-20261015T221637Z`.
Private stopped-state backup: `~/.local/state/token2oauth/backups/pre-unified-20261015T221637Z`.
Use `rotoxy down`, preserve current runtime, restore the prior runtime, then `rotoxy up`. Do not overwrite newer databases or blindly restore temporary tool-policy snapshots. Backup timestamps are UTC; verification date above uses operator timezone.
Private detailed evidence and build/deployment receipts: `~/.local/state/token2oauth/batches/20261016/unified/`.

## Remaining work
Routing policy is a validated durable planner; cross-provider dispatch wiring is not complete. Cloudflare OpenAI streaming unsupported in this deployed revision; buffered SSE compatibility is assigned to a cloud worker. Other active workers own actual account-weight controls and Oracle/Codex workspace visibility. No native approval API, failed-frontier relaunch, exact live LightSprint balance,24/35 concurrency, arbitrary web-chat wake-up, paid automatic recovery, Codex subscription dispatch or arbitrary-provider inference compatibility is claimed. Root URL consolidation does not make workspace sessions into stateless model APIs. Cloud dispatch uses temporary narrowly scoped permissions during controlled batches, restored afterward.

## Routing and streaming update
Deployed source `d03dea1a1cbc50596c2c9e580f5a1b4ecad48fba`. Full Node374/374 passed. Full Python321/321 passed in22seconds on Oracle ora5 from a public-source archive; the earlier local timing failures remain recorded above. Focused controls20/20 passed. Browser desktop/mobile checks still pass with Oracle/Codex resource groups. Codex metadata is registration information, not active-session telemetry; Oracle values are persisted observations, not a new SSH/inference probe.

Saved account enable/weight/capacity rules now affect actual Ollama and Cloudflare dispatch. Configured caps cannot raise adapter hard limits. Group caps are still planner-only, explicitly labelled. `/admin/routing` exposes the validated policy editor. Disabled routing accounts are omitted from unified catalogs, and catalog cache invalidates on credential or routing changes.

Cloudflare `stream:true` now returns OpenAI-compatible SSE after a bounded nonstreaming provider completion. Public verification returned200 text/event-stream, expected marker, usage and `[DONE]`. This does not claim upstream token streaming or provider cancellation on client disconnect. Unsupported tools/multimodal parameters fail explicitly. Uniform model-token authentication runs before provider delegation; the legacy gateway also retains its own checks. Bedrock Opus4.6 review completed with USD0.07959 list-based estimated usage; findings were checked against the composed gateway, not accepted without verification.

Updated rollback runtime `~/.local/share/token2oauth-pre-unified-20261015T222916Z`; private stopped-state backup `~/.local/state/token2oauth/backups/pre-unified-20261015T222916Z`. Deployed files have a SHA256 build receipt. Current extension workers own reusable inference-provider presets, per-account model policies and official client compatibility research. Those changes are not part of this deployed source.
