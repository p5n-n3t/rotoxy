# Oracle model inventory

Branch `codex/rotoxy-oracle-models-20261017`, based on `origin/main` at `564b99fe5ceaae55af712013c18b7e0bd24ea9f3`.

`createOracleModelAdminRouter(store, sessions, options)` provides the authenticated `/admin/oracle/models` inventory; root owns mounting and navigation. The trusted default paths are the existing Oracle fleet config and queue database from `runtimeStatePath`, plus a private inventory cache below the local gateway state directory. Host rows come from the fleet config at read time. Cache entries bind to the host's configured IP/SSH alias and are dropped when that endpoint changes or disappears. The cache uses owner-only permissions, revision checks, an exclusive lock, pre-write backups, and atomic replacement.

The page reads cached inventory and queue counts only. “Refresh catalog” is the only operation that contacts a host. It reuses the existing fixed-host SSH transport with a constant remote Python script that performs a bounded GET to `http://127.0.0.1:11434/api/tags`, refuses redirects, and returns only bounded model name, size, and modified time. Test probes are injected; no host was contacted during implementation.

Apply is deliberately **preview-only**. Although the queue is read-only checked for running, ambiguous, dispatching, and unknown statuses, the pool has no shared maintenance fence that prevents a new task from being claimed between the check and a local service restart. The UI reports this exact limitation and never invokes `systemctl`; adding a durable dispatch fence is required before a safe restart can be offered. Model install/delete and disk-budget controls are also out of scope.

Focused Python tests cover fake host catalogs, bounded parsing, cache revision/backups, dynamic fleet membership, queue snapshots, missing/active queue fail-closed behavior, and preview-only apply. The Node HTTP test covers auth, CSRF, explicit refresh, and rejection of arbitrary actions/commands. It requires the repository's built output and dependencies to run.
