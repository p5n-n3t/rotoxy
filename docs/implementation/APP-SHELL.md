# ROTOXY app-shell checkpoint

Built on `origin/main` at `15767e1c31410bc9125f543c53d372fe8e865efb` on isolated branch `codex/rotoxy-app-shell-20261015`. The new `src/ui-shared.ts` exports a server-rendered shell wrapper, compact persistent rail, existing ROTOXY mark, workspace/current-page labels, grouped navigation, active-route semantics, keyboard-operable native mobile drawer, skip link, dark palette, and reduced-motion/focus styling. Route entries are limited to confirmed HTML pages; Jobs and Analytics are inert because only jobs-through-project and analytics JSON surfaces exist. Clients reuses the actual Models & APIs page where client tokens live.

The route audit and two ASCII layout alternatives are in `docs/design/app-shell-20261015.md`; the fixed rail was selected to keep group context without consuming a second horizontal nav row.

`test/app-shell.test.mjs` checks the route allowlist, current-page accessibility, responsive drawer, reduced motion, logo, and safe label/base handling. Tests construct no `StateStore`; existing API, auth, and state code is untouched.

## Integration seam

`src/html.ts` remains outside this assignment's owned-file list, so existing routes still call the prior `adminNav` helper. To activate the shell, the root owner should import `renderAppShell` into the shared admin page renderer, remove the prior navigation header from each page body, and wrap each existing server-rendered page body with its established base, route key, page label, and workspace label. Keep `withCsrf`, page authentication, CSP/security headers, form handlers, and persisted StateStore semantics unchanged. No route or endpoint was added here.

Validation: `npm run build`, `node --test test/app-shell.test.mjs`, and `git diff --check`.
