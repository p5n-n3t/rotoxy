# Integrated profile administration controls

Base: `origin/codex/unified-platform-20261010` at `a3725bac95a5131b0c0bff7dc39c015103f4df9d`. Branch: `codex/rotoxy-profile-controls-20261015`.

The Models & APIs page now links to `/admin/cloudflare` and offers CSRF-protected removal for an individual Ollama credential. The existing Codex rename/remove controls now receive the configured public base path and their `action=rename` / `action=remove` submissions call `CodexProfiles.renameProfile` and `CodexProfiles.removeProfile`. The existing router session middleware, body limits, CSRF validation, and generic failure responses remain in force. Removal keeps sibling records untouched; Codex `CODEX_HOME` remains on disk.

Focused regression coverage uses a temporary `HOME` and `TOKEN2OAUTH_CONFIG_DIR` before constructing `StateStore`, synthetic credentials, and synthetic profiles. It exercises unauthenticated redirects, missing-CSRF refusals, successful rename/removal, unknown-ID rejection, sibling preservation, private Ollama credentials, and the Cloudflare link.

Validation: `npm run build` and the focused `node --test test/control-plane-profile-controls.test.mjs` passed. The full suite was not run as requested. No real account state or credentials were mutated. No `html.ts`, `ui.ts`, or `server.ts` files were changed.
