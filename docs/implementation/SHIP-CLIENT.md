# Client setup polish checkpoint

Branch `codex/rotoxy-client-polish-20261016` is based on `rotoxy` main at `2c0bc90f8658c2330f4ad9e0067b3bcaf2343088`.

The generated Claude Code and Codex CLI commands register the canonical `rotoxy` server at the supplied root `/mcp` endpoint through each official CLI. Registration remains dry-run by default; successful registration tells users to finish the OAuth handoff in the client and explicitly says ROTOXY does not copy client credentials. No OpenCode config is generated: the CLI reports OpenCode as unsupported by this helper because there is no writer or compatibility check. ChatGPT web setup remains user-managed/manual. These flows configure MCP endpoint access and do not claim access to consumer subscription APIs.

New exact private backups default to `~/.rotoxy/mcp-backups`. Restore discovery still accepts an explicitly selected backup in the previous `~/.token2oauth/mcp-backups` directory; writes use only the new location. CLI restore supports preview by default and guarded `--apply` only while the post-change config fingerprint matches. The CLI labels these as exact private config backups, not redacted snapshots. The tools page has no client-setup snippets, so it was left unchanged.

Validation: `npm run build` passed; `node --test test/client-connections.test.mjs` passed (12 tests), including CLI help assertions and isolated backup/restore fixtures. No real client configuration was read or changed.
