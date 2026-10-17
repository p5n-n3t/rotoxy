# Runner profiles and Oracle model inventory — 2026-10-17

This checkpoint extends the deployed operator controls. It adds local runner profile management, explicitly refreshed Oracle model inventory, and a dynamic worker operations view. These are control-plane additions, not a claim of a unified execution scheduler.

## Runner profiles

The authenticated `/admin/runners` page adds, edits, enables/disables, and removes local Claude Code, OpenCode, and Hermes profiles. Each profile records its working directory, trusted executable and explicit model allowlist. Executables come from trusted server-side installation paths, not arbitrary HTTP input. Symlinks are resolved consistently before registration. Optional `ROTOXY_CLAUDE_BINARY`, `ROTOXY_HERMES_BINARY`, and `ROTOXY_OPENCODE_BINARY` settings are trusted local configuration, not client parameters.

Version/help probes are explicit, use fixed arguments, an isolated HOME and a minimal environment, and impose time/output limits. They do not log in, invoke a model, import credentials, or launch an agent. A responding binary is separate from account entitlement and quota. Removed installations stay visible as unavailable and removable; reading their metadata cannot execute them. Registry writes use private permissions, locking, opaque revisions, backups and atomic replacement.

## Oracle inventory and operations

`/admin/oracle/models` explicitly refreshes cached model catalogs through the existing approved-host SSH transport, using fixed localhost Ollama read endpoints with redirects and inherited proxies disabled. Installed models, allowed models, reported sizes, observation times, and cached queue load are separate fields. A successful catalog fetch does not prove inference on every returned model. New hosts and model IDs appear without a compiled enum change.

The operations page now uses a wide fleet table, separates requested and reported models, retains historical host references, and labels page-sample counts. Capacity utilization remains unknown when the source provides no meaningful slot denominator. It does not invent SSH health from a persisted task record.

Configuration apply remains preview-only. A database count followed by a service restart is not safe against concurrent dispatch. The UI reports why apply is blocked and performs no restart or model installation/removal. A bounded Opus 4.6 architecture review informed future maintenance-fence work. Its generic per-host-worker and TTL auto-cancel suggestions were not adopted: the current pool is a single local daemon, and an expired administrative request must not silently resume previously paused work. Killing SSH cannot be treated as cancellation of remote Ollama inference.

## Evidence and boundaries

Three independent LightSprint Luna assignments delivered reviewed Git artifacts. Three Oracle advisory jobs completed across ora1, ora3 and ora5. Live read-only catalogs responded on all three; ora1 additionally reported `qwen2.5-coder:7b` and `gemma4:e4b`. The local Hermes CLI responded with version 0.18.2 under the user environment, while its stricter isolated-HOME five-second in-app probe timed out. That difference remains visible; no successful Hermes execution is claimed. The default Claude path resolved to 2.1.286; the previously verified pinned 2.1.300 installation is kept distinct.

The TypeScript build and all 442 Node tests pass on ora5; all 372 Python tests pass, including missing-installation profile recovery. A subsequent layout change passes ten targeted HTTP/rendering checks. The initial runner test incorrectly checked a configured-model empty state before creating a profile; it now checks both states in order. Built-in browser review replaced the overflowing runner table with responsive profile sections and verified the model-cache location. Package and deployment receipts are retained privately. No new provider permissions, credential imports, purchases or model downloads were performed. Existing Claude text-worker execution and LightSprint durable dispatch remain separate verified execution paths; generic OpenCode/Hermes task execution is not implemented by a profile editor.
