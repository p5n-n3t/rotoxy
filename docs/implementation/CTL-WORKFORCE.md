# Command workspace: Oracle and Codex workforce map

The existing authenticated `/admin/workspace` view now adds two real resource groups to its map and ledger. Oracle values come from `loadOracleOpsSnapshot` with server-constructed absolute paths to the installed `supervisor/` directory and the operator's fixed `~/.local/state/token2oauth/oracle-pool/{config.json,queue.sqlite3}` files. It reads persisted state only; this page does not invoke SSH, model inference, or Codex.

Codex rows come from the existing `codex-profiles.json` registry under `StateStore.dir`. The reader requires a private owner-only configuration directory and regular owner-only registry file, validates the version, size, count, IDs, labels, and timestamps, then exposes only profile ID, label, and registration time. Registry update time is not presented as activity. Models, sign-in, worker state, and last seen stay explicitly unknown because this registry does not contain those facts and this view does not start the Codex client.

## Integration and verification

No root route or navigation change is needed: the workspace router is already mounted in `src/server.ts`, and the existing navigation already links to `/admin/oracle` and `/admin/codex`. The Oracle and Codex SVG nodes link to those dedicated detail pages. Snapshot refresh retains the existing five-second coalescing and three-at-a-time supervisor project reads.

Focused tests use temporary `HOME` and `TOKEN2OAUTH_CONFIG_DIR`, inject the Oracle loader to avoid subprocess/network access, and cover sanitized real host IDs/counts, malicious/unrecognized fields, profile metadata redaction, missing/invalid local state, authenticated rendering, and the detail links. No live Oracle or Codex provider/account state was queried. In particular, `registeredAt` is registry metadata, not last-seen time; Oracle task counts are not worker counts; profile counts are not active workers.
