# Compact supervisor summary integration

Branch `codex/rotoxy-summary-20261015` is based on fetched `origin/codex/unified-platform-20261010` at `a3725bac95a5131b0c0bff7dc39c015103f4df9d`.

Added authenticated `GET /admin/api/v1/supervisor/:projectId/summary?after=0&limit=20`. It follows the existing admin-session security headers and auth guard, accepts only bounded cursor/page values, redacts output, and caps serialized responses at 512 KiB. Owner IDs are never accepted from the request: `SupervisorRuntime.readCompactSummary` resolves the configured project, derives `oauth-client:<clientId>` owners from private runtime config, and invokes the existing `python -m snooze.guidance ... compact-summary` command with those owners. The runtime caps CLI output at 512 KiB; unknown projects and invalid query values are rejected. No UI, Python, bridge, or production files changed.

Focused evidence: `npm run build` passed. Three summary-specific tests passed with `node --test --test-name-pattern='compact project summary|compact summary derives|compact summary runs' test/supervisor-api.test.mjs test/supervisor-runtime.test.mjs`. They cover admin authentication, invalid query bounds, redacted/bounded output, per-project owner filtering, oversized runtime output, and a real Python CLI round trip using a temporary inbox database.

A broader run of the two API/runtime test files also encountered the existing Python IPC job-completion test failing in `awaiting_output` with `modelRequested: "unknown/unsupported"`; this summary change does not touch dispatch or job completion. The full suite was not run; root owns full regression.
