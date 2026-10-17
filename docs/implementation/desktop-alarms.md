# Desktop alarms from the workforce monitor

The workforce monitor can ask Snooze's recovery service to deliver one local desktop notification after each completed recovery pass. This is a human notification channel. A successful `notify-send` request means the desktop accepted the request; it does not mean the user saw it, and it never wakes or resumes an AI agent.

Add this optional object to the monitor's private configuration when `recoveryServiceConfig` is enabled:

```json
{
  "recoveryServiceConfig": "/home/jq/.config/rotoxy/recovery.json",
  "desktopAlarm": {
    "sourceDb": "/home/jq/.local/state/rotoxy/supervision/recovery.sqlite3",
    "receiptsDb": "/home/jq/.local/state/rotoxy/supervision/desktop-alarm-receipts.sqlite3"
  }
}
```

Both paths must be absolute. `sourceDb` must point to the same private `stateDb` used by the configured recovery service. `receiptsDb` stores private, durable deduplication receipts and should be a separate file. The monitor requires `desktopAlarm` to have exactly these two fields and requires `recoveryServiceConfig` whenever alarms are enabled.

After every monitor recovery attempt, the monitor invokes the fixed `/usr/bin/python3 -m snooze.desktop_alarm` module with the two paths. It also runs when the recovery service fails, so it can deliver alerts already present in the durable notification table. The monitor reports the recovery failure separately and still performs this alarm fallback. The child uses the monitor's Snooze `supervisor` directory as `PYTHONPATH`, runs without a shell, has a 60 second deadline, and may return at most 16 KiB on stdout. The alarm CLI itself only reads durable recovery notifications and records its own delivery receipts.

Each monitor cycle includes `recoveryStatus` and a `desktopAlarm` object in its JSON result. Alarm status is `not_configured`, `completed`, `attention_required`, or `failed`, with scanned, submitted, failed, and ambiguous counts. Failure details use a small sanitized code. Failed alarm delivery is written as a sanitized JSON line to stderr; it does not discard the recovery result. Recovery-service failure remains visible and preserves the monitor's nonzero exit status in `--once` mode, while the alarm attempt still runs. An ambiguous notification outcome is not retried automatically.

This integration only submits a desktop notification. Agent guidance remains in the durable Snooze inbox, native provider approvals remain explicit handoffs, and orchestrator resumption requires a separately verified adapter.
