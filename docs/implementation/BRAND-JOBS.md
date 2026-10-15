# Jobs page integration checkpoint

This change adds an authenticated, read-only `/admin/jobs` router/page and the optional authenticated JSON endpoint `/admin/api/v1/jobs`. It lists at most 50 valid project IDs and reads supervisor snapshots in batches of three. Jobs, task states, and error event identifiers come only from `normalizeSupervisorSnapshot`-compatible project snapshots. The response omits job/task labels, prompt bodies, event messages, credentials, and unrecognized project IDs. Missing job/task arrays and task-state counts remain `null` (shown as Unknown); queued is explicitly described as a reported queue state, not execution.

Root integration, required before the route appears in the application:

1. Import `createJobsAdminRouter` from `./jobs-admin.js` in `src/server.ts`.
2. Mount `router.use(createJobsAdminRouter(store, sessions, options.supervisorBackend));` before `router.use(ui.router)` (near the supervisor admin router is suitable).
3. In `src/html.ts`, change the existing Command/Jobs navigation item's `href` from `""` to `"/admin/jobs"`; the page factory already supplies an active Jobs navigation group while rendering its own page.

No provider calls, mutation controls, dispatch semantics, or worker execution claims are included. Project-page links target the existing `/admin/supervisor/:projectId` route. The page uses the shared `page`, `adminNav`, and `withCsrf` helpers; logout retains the shared CSRF form field.

Focused validation: `npm run build` and `node --test test/jobs-admin.test.mjs`. Tests construct `StateStore` only after isolating `HOME` and `TOKEN2OAUTH_CONFIG_DIR`, exercise unauthenticated access, bounded read concurrency, snapshot-only data, unknown values, project links, escaping/redaction, and CSRF output. The standalone module tests do not prove root route/nav wiring; those integration edits remain for the root owner.
