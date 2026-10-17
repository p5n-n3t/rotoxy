# Oracle maintenance and config-apply core

This change supplies the durable SQLite contract for an explicit Oracle-pool
configuration apply. It does not restart the service or expose an HTTP/admin
route. The owning integration should call these APIs only after its existing
authenticated confirmation flow.

## Configuration identity and daemon ownership

`OraclePool.loaded_revision` is the URL-safe base64 encoding, without padding,
of the first 18 bytes of SHA-256 over the exact config bytes read and parsed at
construction. The config is read once, so the revision cannot describe a
second, different read. Constructing a pool, opening a maintenance controller,
or running a read/status command does not register a daemon. The `serve` CLI
path calls `register_daemon()` immediately before its polling loop.

A single SQLite daemon row identifies the serving process with a UUID, PID,
boot ID, process start identity, loaded revision, heartbeat time, and observed
fence epoch. A second live instance cannot overwrite it. Every `_claim()` by a
registered daemon checks that it still owns the row and refreshes its heartbeat
and observed epoch in the claim transaction. A replaced process fails with
`daemon_replaced`; an unregistered one-shot worker cannot claim while the global
maintenance fence is paused.

`read_daemon_status(db_path)` is read-only and returns exactly
`available`, `instanceId`, `loadedRevision`, `heartbeatAt`, `observedEpoch`,
and `alive`. On an unavailable or corrupt schema it returns `available: false`
and null/false values; it never creates the database or acknowledges a fence.

## Maintenance and apply API

`OraclePool.open_maintenance(db_path)` opens only an already-existing private,
valid DB (`mode=rw`). It does not construct runtime config, initialize schema,
or recover claims. Maintenance reads do not acknowledge a drain; only a
registered daemon's `_claim()` can acknowledge after observing no running,
ambiguous, dispatching, or unknown-status blockers.

The apply API is:

- `begin_config_apply(*, expected_epoch, target_revision)` reserves one durable
  operation only while the fence is paused, acknowledged, drained, at the exact
  epoch, and observed by a live daemon. The fence's `configRevision` remains
  the old loaded revision used to request/pin the pause; `target_revision` is
  the separately checked current-file revision supplied by the coordinator.
  Repeating the same epoch and target returns the existing operation. A
  different target conflicts. The transaction commits before this method
  returns, so the coordinator can then wait for service restart without
  holding a SQLite write lock.
- `complete_config_apply(*, apply_id, expected_epoch, target_revision)` requires
  the exact reservation and a fresh replacement daemon (new instance) that
  loaded the reserved target revision and observed the paused epoch. It can
  reconcile either a prepared or failed reservation when those exact checks
  now pass; wrong targets and the old daemon still fail. In one transaction it
  completes the operation, records an audit event, and releases the fence at
  the next epoch.
- `fail_config_apply(*, apply_id, expected_epoch, error)` records a bounded
  error code and leaves the reservation and fence paused. It cannot be retried
  as a new reservation, but a later healthy replacement can reconcile that
  same operation through `complete_config_apply()`.
- `read_config_apply_status(db_path)` reads the latest operation or returns
  `None`; malformed or unavailable state raises `ValueError` with the stable
  code `config_apply_unavailable`.

Operation dictionaries have exactly `applyId`, `epoch`, `targetRevision`,
`previousInstance`, `status`, and `error`. Status is `prepared`, `complete`, or
`failed`. `release_maintenance(*, expected_epoch, config_revision)` is only an
abort path before any apply reservation exists; prepared or failed reservations
block release. It never clears an ambiguous task or automatically resumes a
failed restart. Epoch and revision mismatches fail with stable
`maintenance_epoch_conflict` / `maintenance_revision_conflict` errors.

The tables and schema marker are migrated transactionally. A true legacy DB
gets the initial fence and apply schema once. Missing/corrupt existing fence or
apply state fails closed rather than being recreated; all queue rows remain
untouched. This core intentionally does not implement the `snooze.oracle_apply`
service runner/controller or its HTTP/UI wiring; the integrating change should
compose the read helpers and `open_maintenance()` APIs, keep status GETs
read-only, and invoke apply only on an explicit authorized POST.
