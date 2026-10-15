# Canonical ROTOXY cutover — 2026-10-16

Canonical repository: https://github.com/p5n-n3t/rotoxy. Code artifact: `2c0bc90f8658c2330f4ad9e0067b3bcaf2343088`.

The installed gateway now runs from `~/.local/share/rotoxy`, reads encrypted configuration from `~/.config/rotoxy`, and uses `~/.local/state/rotoxy/supervision` and `~/.local/state/rotoxy/oracle-pool`. The predecessor configuration was archived privately; its keys were not merged into the gateway's credential store. The former gateway runtime and data remain available for rollback.

Active units are `rotoxy-gateway.service`, `rotoxy-oracle-pool.service`, `rotoxy-worker-monitor.service`, and `rotoxy-funnel.service`, anchored by the manually started `rotoxy.target`. Old gateway units are masked. New unit files have no boot-install section. `rotoxy up`, `rotoxy down`, and `rotoxy status` use the canonical units. The separate Loopback service was left unchanged.

The existing foreground HTTPS Funnel continues serving the root to loopback port2030. Public surfaces are `/mcp`, `/v1`, and `/admin`. OAuth metadata uses the root issuer. MCP returns401 without authorization; the administrator password is not a bearer token.

## Verification

- TypeScript build and46 focused Node integration checks passed.
- Oracle ora5 ran all322 Python tests successfully.
- SQLite integrity checks and table counts matched across stopped source databases and canonical copies; existing ambiguous Oracle outcomes were preserved.
- Master-key bytes were unchanged; every existing MCP credential decrypted in the canonical store without printing credentials.
- Canonical CLI status confirmed all configured units active, exactly one root public mount, Funnel enabled and local health passed.
- Public health reports12 configured accounts,11 selectable. This does not claim live credits or12 worker slots per account.
- Doctor passed process, config, credentials, upstream, OAuth, tools and Funnel stages.
- Monitor's first canonical cycle checked64 owner bindings with zero status errors. Bindings are not a count of distinct executing agents.
- Claude Code reached the correct root authorization endpoint; interactive consent timed out without a callback. End-to-end Claude authentication remains unverified.

## Backup and rollback

Private backup: `~/.local/state/rotoxy/migration-20261016/cutover-20261015T232200Z`. Its stopped configuration, predecessor configuration, unit files, controller and database copies are operator-private. The timestamp is UTC; the user-facing cutover date is2026-10-16 Asia/Beirut. The runtime's BUILD-RECEIPT.json records the source commit and file hashes.

For a post-cutover rollback, first pause dispatch and stop the canonical gateway, monitor and Oracle pool. Back up their current databases and configuration. Reconcile any tasks created after cutover before restoring old data: restoring a stale database would lose durable job state and can cause duplicate effects. Restore the backed-up old unit files/controller and legacy path references only after preserving those newer records. Start the old stack, verify health and database integrity, and keep the canonical backup until verification succeeds. Do not reset Tailscale globally or retry ambiguous external operations.

## Remaining boundaries

Canonical GitHub/package/runtime identity is migrated. Historic documents, cryptographic derivation domains and compatibility parsers retain legacy identifiers where changing them could corrupt data or break existing records. The local source checkout path is retained while collaborating agents use its worktrees. This does not constitute completion of all provider, automatic recovery, subscription pooling or concurrency acceptance criteria.
