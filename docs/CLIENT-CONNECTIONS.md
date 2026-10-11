# Local MCP client connections

`token2oauth clients inspect` checks for the Claude Code and Codex CLI executables, reads their user-level client config files to extract MCP server names, and reports those names. It does not invoke a server, log in, access client token stores, or prove that a connection works. It does not inspect project-level entries.

Setup is a dry run unless you pass `--apply`:

```sh
token2oauth clients configure claude-code --url https://gateway.example/mcp
token2oauth clients configure claude-code --url https://gateway.example/mcp --apply
token2oauth clients configure codex --name token2oauth --url https://gateway.example/mcp --apply
```

The Claude Code command uses `claude mcp add --transport http --scope user NAME URL`. Codex uses `codex mcp add NAME --url URL`. The helper refuses to replace an existing registration, rejects URLs containing user information, query strings, or fragments, and never passes a token. Before an applied addition, it writes a mode-restricted JSON snapshot of the existing MCP server names, transport, and endpoint origin to `~/.token2oauth/mcp-backups/`. The snapshot omits endpoint paths, headers, environment variables, arguments, and URL query or fragment; it is a non-secret inventory, not a restorable copy of authentication settings. The official CLI owns the config edit so unrelated server entries remain under that client's normal config management. Dry-run output masks the endpoint URL.

To reverse a registration, preview and then explicitly apply the matching official CLI removal:

```sh
token2oauth clients remove claude-code token2oauth
token2oauth clients remove claude-code token2oauth --apply
token2oauth clients remove codex token2oauth --apply
```

After registration, complete authorization through the client. For Codex, use its documented MCP login flow when the server uses OAuth. Claude Code handles the server's documented OAuth flow in Claude Code. Neither registration nor an OAuth prompt proves that later tool calls succeed; verify by using the client and checking the server's connection status there. A user can revoke OAuth in the client or at the gateway; this helper does not manage refresh tokens.

This is intentionally limited to local CLI clients. ChatGPT Web supports remote MCP setup through Developer Mode, but the user must configure it in the web product; this command cannot edit a web account. Claude Desktop configuration is unsupported here. The helper does not copy browser sessions, consumer-account credentials, or CLI token stores.

## Evidence

The client command shapes and configuration ownership were checked against vendor documentation on 2026-10-11:

- Claude Code MCP documentation: <https://code.claude.com/docs/en/mcp> (remote HTTP add/list; OAuth; configuration scopes). The docs specify `--scope user` for a user-wide registration.
- Codex CLI reference: <https://developers.openai.com/codex/cli/reference/> (`codex mcp add`, `--url`, and bearer-token environment-variable option).
- Codex MCP guide: <https://developers.openai.com/codex/extend/mcp> (CLI setup and OAuth login for HTTP MCP servers).
- ChatGPT Developer Mode and MCP apps: <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta> (web product configuration is user/admin controlled).

Only the local add/remove command forms are delegated to clients. Credentials stay with the clients' official interactive authorization flows. Product-specific web setup remains manual; unsupported clients are labeled rather than guessed.
