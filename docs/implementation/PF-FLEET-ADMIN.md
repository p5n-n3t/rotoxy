# Oracle fleet admin

Assignment checkpoint, 2026-10-16. Based on `codex/unified-platform-20261010` at `641f51e87d0192b5919a7fe0e369a23fa961e55e`.

This branch adds an authenticated `/admin/oracle/fleet` router factory plus a fixed Python module for owner-only registry reads and updates. Root integration must mount `createOracleFleetAdminRouter(store, sessions, options).router` and add its navigation entry. The default config path uses `runtimeStatePath("oracle-pool", "config.json")`; root may supply the trusted resolved path and packaged supervisor directory in options. Requests cannot select either path.

The page edits host ID, Tailnet IPv4, SSH host alias, enabled state, and exact configured model IDs. It distinguishes configured models from installed models and explains that changes apply after a pool restart. It does not restart a service, contact a host, install a model, or touch queue history. Existing v1 settings/defaults display as the legacy fleet; an explicit first save converts the unchanged settings plus edited host list to validated v2.

The Python helper uses `oracle_pool.validate_config`, an owner-only config file and directory, an opaque SHA-256 revision token, an exclusive lock, exact preimage backups, and atomic mode-0600 writes. A stale revision or existing lock refuses the write. Removing the last host or the only enabled host allowing the default model is rejected by the shared validator. No database or master-key path is opened by the helper.

Validation: `npm ci` installed declared development dependencies (no audit findings); `npm run build` passed; `node --test test/oracle-fleet-admin.test.mjs` passed; focused Python fleet and pool tests passed (25 tests). No live fleet configuration or provider was accessed.
