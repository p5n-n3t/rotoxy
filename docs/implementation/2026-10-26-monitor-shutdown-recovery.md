# Monitor shutdown recovery — 2026-10-26

## Finding

The worker monitor emitted `monitor_check_failed` while its systemd unit was
being stopped. This was not a LightSprint execution failure. `SIGTERM` set the
monitor's stop flag while systemd also terminated an in-flight bounded Python
guidance child. The child exit was previously collapsed into the same generic
error used for a real observation failure.

## Change

`scripts/monitor-workforce.mjs` now treats a child exit after `SIGTERM` or
`SIGINT` as an orderly stop. It stops before starting guidance, recovery, or
desktop-alarm work, and it does not emit `monitor_check_failed` for that path.
Normal non-zero child exits still retain the existing failure behavior.

`scripts/monitor-lifecycle.mjs` holds the small, directly tested exit-state
classifier. It is included in the npm package alongside the monitor script.

## Verification

- TypeScript build passed.
- Focused monitor lifecycle and desktop-alarm tests passed (7 tests).
- Offline release and installed-package verification passed.
- The deployed monitor was restarted while active. It returned to `active`,
  the gateway health endpoint remained healthy, and the new journal segment
  contained no `monitor_check_failed` record.

The monitor's regular post-restart cycle completed with 252 registered
observation bindings, zero provider status errors, and completed recovery.
Those bindings currently represent nine distinct account/session pairs shared
by multiple authorized clients. Registration multiplicity is tracked
separately from physical session count; it does not prove nine active workers
or provider slot capacity.

## Deployment note

An immutable runtime must be built from the verified npm package or otherwise
include its generated `dist/` directory. A plain Git archive omits generated
build output and is not a runnable service release.
