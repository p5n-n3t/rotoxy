# Continuity and alarm live evidence — 2026-10-17

This checkpoint records the tested boundary for the persistent worker-monitoring and desktop-alert path. It distinguishes source state, installed runtime state, and live behavior; it does not treat a successful notification as proof that an AI conversation resumed.

## Source and verification

- The current source head `a43c5e2` was pushed to `main`.
- The installed runtime is based on `4b2d10d` plus the targeted monitor and desktop alarm patch. The grant coordinator is not installed as an automatic production invocation hook. This is **not** a full installation of source commit `a43c5e2`.
- The remote ARM verification completed with 447 Node tests and 452 Python tests. The final 44-test Python delta also passed after the last source changes.
- The monitor changes were backed up before the live patch at `/home/jq/.local/state/rotoxy/backups/desktop-alarm-20261017`.

## Desktop notification evidence

The actual desktop accepted one notification from a temporary isolated fixture at `/tmp/rotoxy-live-alarm-proof-jx4qsgja`. The first pass reported one submitted notification; reopening the dispatcher reported zero new submissions. This verifies the local `notify-send` path and restart deduplication for that fixture.

The production desktop-alarm receipt database was initialized at `/home/jq/.local/state/rotoxy/supervision/desktop-alarms.sqlite3` with the current 2,858 historical notification rows recorded as the initial scan baseline. No historical notification was replayed. Future passes page new source rows from the durable cursor and aggregate each batch into one desktop notification.

`submitted` means the local notification service accepted the request. It does not prove that the operator saw it or that an AI agent or chat resumed.

## Live monitor cycle

At `2026-10-17T17:33:51.553Z`, one live cycle checked 63 registered worker bindings, reported zero status errors, completed the recovery scan, and had zero new alarm events to deliver. This verifies that the monitor completed a cycle with the installed targeted patch. It does not establish that every provider session has reliable event semantics or that notifications always result in supervisor action.

## Headless supervisor boundary

A fresh Codex headless invocation completed in a controlled proof. The first grant-authorized resume attempt ended ambiguously and its grant remains consumed. A separate, fresh grant and event then completed successfully using the repository as the trusted working directory. Evidence is retained privately at `/tmp/rotoxy-granted-live-gitrepo-rHoET9`: the resume exited successfully in 23.720 seconds, retained an advisory result, acknowledged the source event after persistence, and deduplicated a second identical invocation without another process launch. No provider call was made by the synthetic event fixture.

This verifies a bounded local Codex resume through the coordinator. It does not verify an automatically scheduled production invocation, multiple-account dispatch, guidance delivery to LightSprint, or waking a dormant ChatGPT conversation. Do not retry the earlier ambiguous grant.

## Remaining acceptance tests

1. Keep a long-running provider worker active while the interactive orchestrator is closed; verify the monitor continues and records a completion, failure, idle, blocker, or approval event.
2. Trigger a new production-safe recovery notification after the baseline and verify exactly one desktop summary appears, with event-level receipts tied to the source rows.
3. Interrupt delivery between durable capture and notification submission; verify rows remain visibly `dispatching` and are not resent automatically.
4. Stop and restart the installed monitor and alarm schedule; verify the source cursor and receipts survive without duplicate notification.
5. Connect the separately verified grant-authorized resume to persistent event scheduling, then verify bounded invocation, result collection, and acknowledgement with a real monitored event. Preserve the earlier consumed ambiguous grant and never replay it.
6. Verify escalation when the local desktop session is unavailable and ensure the failure remains visible in the operator inbox.

Until those checks pass, the verified deliverable is persistent polling plus durable handoff and desktop notification. Automatic event-to-agent resumption remains incomplete.

## Non-destructive rollback

The monitor patch backup is `/home/jq/.local/state/rotoxy/backups/desktop-alarm-20261017`. To roll back the targeted monitor change, stop only the workforce-monitor unit, restore the backed-up monitor file and its recorded metadata, then start the unit and verify its status. Preserve the alarm receipt database, recovery database, provider sessions, and existing monitor registrations; do not restore an older database or reset the alarm cursor as part of rollback. No rollback command is embedded here because the exact backup manifest and installed unit paths must be checked on the host immediately before any rollback.
