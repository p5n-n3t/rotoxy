# Project-scoped scheduler controls

This checkpoint adds durable project pause, resume, emergency stop, and local concurrency policy to the SQLite job registry. Controls have independent project revisions and persist across restart. The scheduler checks them in the same write transaction used to reserve work and again before an operation claim. Pausing/stopping blocks new dispatch; already claimed provider operations continue because an in-flight remote mutation cannot be safely recalled. Project limits compose with global controls, job profiles, and registered-account local capacity; they do not assert or increase provider slot limits. Existing credit reservation and ambiguous-operation holds are unchanged. Runtime submission now forwards the optional scheduling policy; task priority already survives task mapping.

`SupervisorRuntime.readAdmin(projectId)` includes `projectControl` with `projectId`, `state` (`running`, `paused`, `emergency_stopped`), booleans, `maxConcurrency`, `activeTaskCount`, `revision`, and optional `updatedAt`. An unknown/malformed response fails the snapshot instead of displaying fabricated state. Runtime controls accept only configured project IDs and use a revision fence.

## Required root integration patch (bridge files are owned elsewhere)

Add only these exact internal routes to `src/supervisor-bridge.ts` and `supervisor/snooze/bridge.py`:

- `GET /admin/api/v1/projects/{projectId}/control` → `registry.get_project_control(projectId)`.
- `POST /admin/api/v1/projects/{projectId}/control` with strict JSON `{action, expectedRevision}` for `pause_dispatch`, `resume_dispatch`, or `emergency_stop`; or `{action:"set_concurrency", value:1..32, expectedRevision}` → `registry.set_project_control(projectId, action, value, expectedRevision)`. Return 409 for stale revisions and 400 for malformed input. Reject extra keys and invalid project IDs; do not route through global `set_control`.

The existing admin router provides session authentication and CSRF protection. UI integration should read `projectControl` from the project snapshot, render the persisted state and revision (missing data means unavailable), and POST to `/admin/api/v1/supervisor/control` with `{projectId, action, expectedRevision}`; concurrency adds `value`. Send `x-csrf-token`, refresh the snapshot after success or 409, and explain that dispatch controls do not cancel in-flight work. Do not optimistically show a confirmed state or infer remote provider capacity. No UI files were changed here.

## Verification and limits

Python registry tests cover project isolation, durable revision conflicts, pause and concurrency gates during active work, plus existing priority/profile and strict-credit behavior (33 passed). Runtime tests cover policy/priority round-trip, control-route composition, configured-project rejection, and truthful snapshot control projection; both Node test files and changed TypeScript files pass Node 22 syntax checks. No provider was called. `npm test` and `npm run build` stop before compilation because this worktree has no installed TypeScript compiler (`tsc: not found`). The bridge handlers/allowlist and dashboard controls remain root integration work; Python/runtime route behavior is not end-to-end through the bridge until that patch lands.
