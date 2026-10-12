# ADR: ROTOXY unification on the Token2OAuth codebase

**Status:** proposed (design only, 2026-10-12).
**Base:** `a7b7a30545d2fdd90d845a3a2003eaa973926927`.

## Decision

ROTOXY is the product name. The code, package, CLI, config directory (`TOKEN2OAUTH_CONFIG_DIR`), state files, `/token2oauth` mount and every `/admin/*` and `/mcp` URL stay Token2OAuth-compatible. Nothing is renamed on disk. The predecessor `p5n-n3t/rotoxy` (MIT) contributes only its name and visual inspiration; legacy features are reused selectively, only after review.

1. **One public gateway.** A single listener, port 2030 by default, serves OAuth, `/mcp`, the OpenAI/Ollama-compatible model APIs and `/admin`. Per-route auth stays as it is: OAuth for MCP, API keys for model APIs, session plus CSRF for admin. There are no unauthenticated proxy paths and no second public port.
2. **Native Ollama key pool.** Ollama-compatible upstream keys are pool accounts of provider `ollama`. They use the same encrypted store, health states and per-session affinity as MCP credentials. Quota stays **Unknown** unless the provider reports it.
3. **Codex accounts through the official CLI only.** An adapter runs the official Codex CLI under its own login per account directory. Browser cookies and web-session tokens are never extracted or replayed. A failed login surfaces as `auth-failed`, with no workaround.
4. **Deterministic scheduler, advisory Oracle.** The scheduler makes every admission and routing decision from explicit rules: health, capacity, budget ceilings and ownership. The Oracle model may propose bounded actions such as retry, reassign or pause. A proposal is a durable event, validated against the same rules, and is applied only by the scheduler or an approving operator. The Oracle never holds credentials and never executes actions.
5. **Durable events and actions.** Every job, assignment, proposal, acknowledgment and action is appended to the durable inbox/event log before it takes effect. Restart reconciles from the log. Mutations are never replayed after an ambiguous failure.
6. **Supervisors.** "Laptop off" means the **local** supervisor is off: no local proposals and no local wake-ups. An external supervisor, such as a hosted Oracle host, is a distinct identity with its own credentials, scope and events. It is never treated as a resumed local session.

## Admin information architecture

| Group | Pages today | Added by root later |
| --- | --- | --- |
| Workspace | Pool overview | — |
| Providers | Accounts | Ollama keys, Codex accounts |
| Models & APIs | Tools | Model APIs, Search |
| Operations | Supervisor | Jobs, Oracle |
| Platform | Security, Diagnostics | OAuth clients |

To add a page, append an item to `NAV_GROUPS` in `src/html.ts`, or pass extended groups as the third argument of `adminNav()`. Existing routes never change.

## Integration plan for root

1. Merge this branch. It changes only the shell in `src/html.ts`, the CSS and favicon in `src/ui.ts`, brand assets, and docs/tests. The `adminNav(base, active)` signature is unchanged, so every caller works as before.
2. Add the new routes (`/admin/jobs`, `/admin/oracle`, `/admin/search`, `/admin/clients`) and their `NAV_GROUPS` entries in the same change, so no link ever 404s.
3. `supervisor-ui.ts` (owned by another worker) still shows "Token2OAuth" in its own rail, which the supervisor UI test asserts. Switch it to `ROTOXY_MARK_SVG` there, together with that test.
4. Page `<title>` stays `· Token2OAuth` for compatibility. Change it to `· ROTOXY` only together with `test/admin-ui-design.test.mjs`.
5. Implement items 2–4 of the decision in their own modules (`providers/ollama`, `providers/codex-cli`, scheduler). Each needs tests that isolate `HOME` and `TOKEN2OAUTH_CONFIG_DIR`.

## Not done here

- No rendered screenshots; no browser is available in the sandbox.
- Ollama, Codex and the scheduler are design only.
