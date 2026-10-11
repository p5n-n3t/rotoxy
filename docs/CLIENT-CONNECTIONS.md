# Local MCP client connections

`token2oauth clients inspect` checks the Claude Code and Codex CLI versions and reads only their user-level MCP registration config files to report configured server names. It does not invoke a server, log in, read client authentication stores, or prove that a connection works. It does not configure Claude Desktop or ChatGPT Web.

Setup and removal are dry runs unless `--apply` is present:

```sh
token2oauth clients configure claude-code --url https://gateway.example/mcp
token2oauth clients configure claude-code --url https://gateway.example/mcp --apply
token2oauth clients configure codex --name token2oauth --url https://gateway.example/mcp --apply

token2oauth clients remove claude-code token2oauth
token2oauth clients remove codex token2oauth --apply
```

The supported local CLI targets are limited to documented user-level registration commands:

- Claude Code: `claude mcp add --transport http --scope user NAME URL`; removal uses `claude mcp remove NAME --scope user`. The configured file is `~/.claude.json`.
- Codex CLI: `codex mcp add NAME --url URL`; removal uses `codex mcp remove NAME`. The configured file is `~/.codex/config.toml`.

Before add or remove, `--apply` writes a **private exact backup** of only the target config file into `~/.token2oauth/mcp-backups/` (directory mode `0700`, backup mode `0600`). The backup contains the full original config bytes and should be protected like configuration credentials. It does not include Claude/Codex authentication databases, browser cookies, or web sessions. It is created with exclusive file creation; collisions fail closed. The public inspection result remains a separate, redacted inventory of server names and never exposes config values.

A scoped restore is exported as `restoreClientConnection({ client, backupPath, apply })`; `apply` defaults to false. It restores exact saved bytes and file mode only when the target path matches the client and a SHA-256 fingerprint confirms the config has not changed since the CLI operation. If unrelated changes happened afterward, restore refuses rather than overwriting them. A successful restore is one-use. The restore API does not restore authentication sessions; reauthorize through the client if needed.

**CLI integration is not included in this change.** The existing `src/cli.ts` configure command labels the returned backup path “Redacted MCP-only snapshot,” and the remove command does not print its returned `backupPath`. To expose the safe restore operation, the integration owner should update that configure label to “Private exact config backup,” print `backupPath` for applied removals too, add `restoreClientConnection` to the import at `src/cli.ts:19`, and add `clients restore <client> <backupPath> [--apply]` that delegates to the helper and prints only its message/path (never backup contents). Keep the dry-run default.

OAuth remains the official client’s interactive flow. Codex documents `codex mcp login NAME` for OAuth-backed servers; this helper does not launch it. Claude Code handles its own documented OAuth flow. Registration and authorization prompts do not prove later tool calls will work. ChatGPT Web setup remains manual in Developer Mode; Claude Desktop is explicitly unsupported here.

## Official references checked 2026-10-12

- Claude Code MCP documentation: <https://code.claude.com/docs/en/mcp> — remote HTTP add, `--transport`, user scope, and `~/.claude.json`.
- Codex CLI reference: <https://developers.openai.com/codex/cli/reference/> — `--url` and the global `config.toml` MCP section.
- Codex MCP guide: <https://developers.openai.com/codex/extend/mcp> — CLI configuration and OAuth `mcp login`.
- ChatGPT Developer Mode and MCP apps: <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta> — user-managed web configuration.

These docs establish only the command/configuration interfaces above. The compatibility check also probes each installed CLI’s current version and `mcp add/remove --help`; it refuses to edit config when required options are not advertised. No provider/cloud calls are made by that check.
