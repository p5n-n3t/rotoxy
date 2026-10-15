# ROTOXY app-shell checkpoint

The responsive workspace shell is integrated in the real shared renderer: `src/html.ts` renders the four navigation groups and `src/ui.ts` supplies the page-shell layout styles. Existing callers retain the `adminNav(base, active)` API, route paths, CSRF form injection, handlers, authentication, and state behavior. The shell uses the existing ROTOXY mark, a fixed desktop navigation rail, a keyboard-operable mobile disclosure, workspace/current-page context, skip link, reduced-motion/focus styling, and wrapping labels.

Navigation targets were checked against mounted HTML routes. Jobs has no standalone HTML route and Analytics is an authenticated JSON endpoint, so both are visibly unavailable rather than linked to invented pages. Activity uses the existing overview route; Clients shares the existing Models page. Existing account, credit, Codex, tools, model, private-worker, search, security, and diagnostics destinations remain reachable.

The earlier disconnected `src/ui-shared.ts` draft was removed. The focused shell test now exercises the integrated renderer and page CSS. Root should run the full repository suite and review responsive rendering before integration; this finalization did not run the full suite or a browser capture.
