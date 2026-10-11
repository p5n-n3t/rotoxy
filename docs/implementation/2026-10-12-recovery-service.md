# Recovery service integration (2026-10-12)

This integration adds a bounded consumer for the existing `GuidanceInbox` event table and the already-integrated `RecoveryEngine`. It uses the inbox's durable registrations as the authoritative worker/project/owner/account/session binding; incoming event fields never supply account or session identity. A private per-service SQLite ledger stores the source cursor and receipt before the source event is acknowledged. If the process dies between those writes, the stable `guidance-<inbox-id>` engine event and source ledger make the next pass idempotent. Unbound events are recorded as service handoffs and acknowledged only after that receipt is durable.

## Private configuration

Create a new owner-only JSON config (`chmod 600`, owned by the service account); do not point it at a public/shared config. Its parent and all database directories must be private to the same OS account.

```json
{
  "version": 1,
  "inboxDb": "/home/agent/.local/state/token2oauth/guidance.sqlite3",
  "stateDb": "/home/agent/.local/state/token2oauth/recovery-service.sqlite3",
  "intervalSeconds": 300,
  "maxEventsPerCycle": 20,
  "projects": [
    {
      "project": "project-identifier",
      "scope": "recovery-scope",
      "owners": ["task-owner-identifier"],
      "policy": {
        "level": "observe",
        "permissions": [],
        "rules": {},
        "max_attempts": 1,
        "max_runtime_seconds": 30,
        "action_budget_usd": 0,
        "budget_ceiling_usd": 0,
        "oracle_advice": false,
        "oracle_hourly_limit": 0,
        "headless_adapter_verified": false
      }
    }
  ]
}
```

Projects and owners are explicit allowlists. `scope` must be unique per project entry. Bindings are read from `GuidanceInbox.monitor_registrations` via `GuidanceInbox.register`/`sync_project`; the configured owner list further limits which registrations can be used. Configure registrations before enabling the service. Policy fields and limits are validated by `RecoveryEngine`. The recommended initial level is `observe`. `notify` writes a durable local notification/audit receipt only; it does not send a message. A rule can use the only built-in actions `ack-inbox` (idempotently acknowledge the source event) or `notify`; it must be explicitly named in both `rules` and `permissions`, e.g. `"rules":{"failed":"ack-inbox"}`, `"permissions":["rule:ack-inbox"]`. No event text chooses an action.

For local Oracle advice, set `oracle_advice: true`, a limit from 1 to 10, and add these absolute paths at the config top level:

```json
"poolConfig": "/home/agent/.local/state/token2oauth/oracle-pool/config.json",
"poolDb": "/home/agent/.local/state/token2oauth/oracle-pool/queue.sqlite3"
```

The config file must already exist, be owned by the same user, and have mode 0600; this service will not create or rewrite Oracle configuration. The actual `OraclePool` is lazily initialized only when enabled. The engine submits sanitized advice only for its significant incident classes and persists stable job IDs. Advice remains advisory; it never runs a command. Do not enable this without an intentional local Oracle setup.

## Run and monitor integration

Run once with `PYTHONPATH=<package-root>/supervisor python3 -m snooze.recovery_service --config /absolute/private/recovery.json --once`. Run a persistent loop with the same command ending in `serve`; supervise it with the host's normal service manager and run it under the private-config owner. Choose one: do not run `serve` and the monitor hook concurrently against the same state DB (the service lock fails closed).

The existing `scripts/monitor-workforce.mjs` config is backward-compatible. Optionally add `"recoveryServiceConfig":"/absolute/private/recovery.json"`; each monitor pass invokes the Python service once after normal observation and local guidance. It reports processed events, not provider-action success. The monitor now performs one read-only status request per `(accountId, sessionId)` and fans that observation back to each scoped inbox worker/owner.

## Safety boundaries and gaps

The package service exposes no cloud-supervisor, headless, or paid action adapter and no resource-cap verifier. If those RecoveryEngine levels are configured, the engine cannot find an adapter and/or verified quota/budget, so it produces a durable handoff. `headless_adapter_verified` alone does not enable dispatch. No installed Codex/Claude fixed-command adapter is implemented here. There is no wake-up mechanism for a dormant ChatGPT conversation; pending handoffs remain durable in `RecoveryEngine.pending_handoffs()` and the service DB. Root integration still needs to install/supervise this daemon, arrange private registrations/config, and validate the configured synthetic incident path. Tests use temporary databases and a fake Oracle pool; they do not contact a provider or verify live wake behavior.
