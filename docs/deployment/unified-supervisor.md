# Unified supervisor deployment

Token2OAuth packages Snooze's Python supervisor source, dashboard assets, and notices with its Node gateway. Supervisor execution is opt-in: only `token2oauth serve --supervisor-config /absolute/path/to/supervisor.json` starts the Python bridge and Node job worker. A normal `serve` does not start either. This describes the implementation at the current integration revision; it is not a production rollout record.

## Runtime behavior and limits

The config must be an owner-owned, non-symlink regular file with mode `0600` (or stricter), no group/world permissions, and at most 64 KiB. Its version is `1`; unknown root, project, session, and limit fields are rejected. Keep it out of source control. It contains identifiers and policy, not provider credentials; credentials remain in Token2OAuth's encrypted account store.

Each `registeredSessions` entry requires `sessionId`, `accountId`, `model: "gpt-6-luna"`, and `workspaceId`. Sessions must be unique and bound to a listed account. The project binds `projectId`, OAuth `clientIds`, `accountIds`, and those registered sessions. The root requires `allowUnknownQuota: true`, `maxWorkers` from 1 to 8, and `localLimits`: `maxTasks` 1–100, `maxJobBytes` 1,024–1,048,576, and `maxOutputBytes` 1–32,768. The runtime uses the lower of `maxWorkers` and the number of distinct configured accounts as its worker concurrency ceiling; local account capacity is one. These are local limits, not provider capacity claims.

Only enabled, authorized, healthy eligible accounts with a registered session are used. The adapter is restricted to the LightSprint provider, or a generic bearer account whose upstream URL exactly matches the configured native LightSprint endpoint. Unknown quota is accepted only because this format requires explicit acknowledgement; it does not establish available balance, remaining credits, or a spending ceiling. Fresh operations are disabled. Existing registered sessions are used for bounded text jobs. A `429` is treated as an unknown quota signal, not proof that credits are depleted.

The runtime is implemented and the opt-in dispatcher reports `dispatchEnabled: true` when available. Prior deployment text claiming fanout was disabled is stale. This does not establish production readiness: the strongest current direct overlap evidence is two observed running sessions. There is no verified 24- or 35-worker run, provider slot maximum, remaining-credit value, or provider-wide concurrency guarantee. See [release verification](../RELEASE-VERIFICATION.md) and the dated evidence it cites.

The package contains the `scripts/monitor-workforce.mjs` observer and the compiled Node modules it imports. That separate monitor requires a private owner-only config and makes read-only status requests to its explicitly configured LightSprint sessions; it is not started by the supervisor flag. Its local guidance mode uses the packaged Python module. Packaging the program does not configure, enable, or start an OS service.

## Backup and rollback

No live deployment, upgrade, backup, or rollback was performed for this release audit. For a future controlled rollout, record the exact tested `.tgz` and service command, stop the service cleanly, then save the artifact, supervisor config, and complete Token2OAuth config directory. The directory includes the encryption key/account state and `supervisor-state/`; protect the backup as credential material. Stopping before copying preserves SQLite WAL state.

For an installation managed by global npm, the following sequence is reproducible after setting the paths and adapting the two service-manager commands to the actual host. Do not run the copy while the service is active.

```sh
set -eu
umask 077
CONFIG_DIR="${TOKEN2OAUTH_CONFIG_DIR:-$HOME/.config/token2oauth}"
SUPERVISOR_CONFIG="/absolute/path/to/supervisor.json"
RELEASE_TGZ="/absolute/path/to/token2oauth-0.2.0.tgz"
BACKUP_DIR="$HOME/.local/state/token2oauth-backups/0.2.0"

# Stop using the service manager that actually owns this installation.
mkdir -p "$(dirname "$BACKUP_DIR")"
mkdir "$BACKUP_DIR"  # Fails if this release backup already exists.
cp -a "$RELEASE_TGZ" "$BACKUP_DIR/"
cp -a "$SUPERVISOR_CONFIG" "$BACKUP_DIR/supervisor.json"
cp -a "$CONFIG_DIR" "$BACKUP_DIR/config"

# Install the saved release only after the backup is complete.
npm install --global "$RELEASE_TGZ"
# Start the service with its recorded command, including --supervisor-config.
```

Rollback restores the saved artifact and full state after a clean stop. Preserve the current failed state separately before replacing anything; do not combine SQLite files from different runs.

```sh
set -eu
umask 077
CONFIG_DIR="${TOKEN2OAUTH_CONFIG_DIR:-$HOME/.config/token2oauth}"
BACKUP_DIR="$HOME/.local/state/token2oauth-backups/0.2.0"
test ! -e "${CONFIG_DIR}.pre-rollback"

# Stop the service cleanly with its actual service manager.
npm install --global "$BACKUP_DIR/token2oauth-0.2.0.tgz"
mv "$CONFIG_DIR" "${CONFIG_DIR}.pre-rollback"
cp -a "$BACKUP_DIR/config" "$CONFIG_DIR"
# Restart with the recorded prior command and verify locally before reopening traffic.
```

To disable the supervisor, restart the gateway without `--supervisor-config`; retain its state directory for investigation. This flag does not manage the separately installed workforce monitor service. Do not use these examples as an unreviewed production change: service names, exact prior artifact, paths, and health checks must first be recorded for the target host.
