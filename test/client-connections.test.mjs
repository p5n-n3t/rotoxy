import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureClientConnection,
  inspectClientConnections,
  manualClientSetupNotes,
  removeClientConnection,
} from "../dist/client-connections.js";

async function tempHome(t) {
  const homeDir = await mkdtemp(join(tmpdir(), "t2o-clients-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return homeDir;
}

test("inspect is read-only, checks version and reports only local MCP names", async (t) => {
  const homeDir = await tempHome(t);
  await mkdir(join(homeDir, ".claude"));
  await writeFile(join(homeDir, ".claude", ".credentials.json"), "token-store-must-not-be-read-or-copied");
  await writeFile(join(homeDir, ".claude.json"), JSON.stringify({
    mcpServers: { alpha: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "never-print-this" } } },
  }));
  const calls = [];
  const status = await inspectClientConnections({
    homeDir,
    runner: async (command, args) => { calls.push([command, args]); return { exitCode: command === "claude" ? 0 : 1, stdout: "cli version 1.2.3" }; },
  });
  assert.deepEqual(calls, [["claude", ["--version"]], ["codex", ["--version"]]]);
  assert.equal(status[0].registration, "configured");
  assert.deepEqual(status[0].serverNames, ["alpha"]);
  assert.equal(status[1].installed, false);
  assert.doesNotMatch(JSON.stringify(status), /never-print-this|token-store-must-not-be-read-or-copied|example\.test/);
});

test("dry-run uses the documented Claude Code command without writing config or backups", async (t) => {
  const homeDir = await tempHome(t);
  await writeFile(join(homeDir, ".claude.json"), JSON.stringify({ mcpServers: { other: { type: "http", url: "https://other.test/mcp" } } }));
  const calls = [];
  const result = await configureClientConnection({ client: "claude-code", name: "token2oauth", url: "https://gateway.example/mcp" }, {
    homeDir,
    runner: async (command, args) => { calls.push([command, args]); return { exitCode: 0, stdout: "Claude Code 2.1" }; },
  });
  assert.equal(result.applied, false);
  assert.deepEqual(result.args, ["mcp", "add", "--transport", "http", "--scope", "user", "token2oauth", "https://gateway.example/mcp"]);
  assert.deepEqual(calls, [["claude", ["--version"]]]);
  assert.equal(await readFile(join(homeDir, ".claude.json"), "utf8"), JSON.stringify({ mcpServers: { other: { type: "http", url: "https://other.test/mcp" } } }));
  assert.equal(result.backupPath, undefined);
});

test("apply snapshots only safe MCP metadata before official Codex add; secrets are omitted", async (t) => {
  const homeDir = await tempHome(t);
  const configDir = join(homeDir, ".codex");
  await mkdir(configDir);
  await writeFile(join(configDir, "config.toml"), [
    "model = 'example'",
    "[mcp_servers.keep]",
    "url = 'https://keep.example/mcp?token=query-secret'",
    "bearer_token_env_var = 'PRIVATE_TOKEN_ENV'",
    "[mcp_servers.local]",
    "command = 'local-mcp'",
    "args = ['--secret', 'argument-secret']",
    "env = { TOKEN = 'env-secret' }",
  ].join("\n"));
  const calls = [];
  const result = await configureClientConnection({ client: "codex", name: "token2oauth", url: "https://gateway.example/mcp", apply: true }, {
    homeDir,
    now: () => 123,
    runner: async (command, args) => { calls.push([command, args]); return { exitCode: 0, stdout: "added" }; },
  });
  assert.deepEqual(calls, [["codex", ["--version"]], ["codex", ["mcp", "add", "token2oauth", "--url", "https://gateway.example/mcp"]]]);
  assert.equal(result.applied, true);
  assert.equal(result.backupPath, join(homeDir, ".token2oauth", "mcp-backups", "123-codex-mcp.json"));
  const backup = await readFile(result.backupPath, "utf8");
  assert.match(backup, /"name": "keep"/);
  assert.match(backup, /"endpoint": "https:\/\/keep\.example"/);
  assert.match(backup, /"name": "local"/);
  assert.doesNotMatch(backup, /query-secret|PRIVATE_TOKEN_ENV|argument-secret|env-secret|bearer_token_env_var/);
  assert.equal(result.message.includes("successful tool execution"), true);
});

test("refuses a duplicate registration and rejects credentials in endpoint URLs", async (t) => {
  const homeDir = await tempHome(t);
  await writeFile(join(homeDir, ".claude.json"), JSON.stringify({ mcpServers: { token2oauth: { type: "http", url: "https://existing.test/mcp" } } }));
  const runner = async () => ({ exitCode: 0, stdout: "Claude Code 2.1" });
  await assert.rejects(configureClientConnection({ client: "claude-code", name: "token2oauth", url: "https://gateway.example/mcp", apply: true }, { homeDir, runner }), /already registered/);
  await assert.rejects(configureClientConnection({ client: "claude-code", name: "new", url: "https://user:secret@gateway.example/mcp" }, { homeDir, runner }), /without embedded credentials/);
});

test("removal is dry-run by default and delegates to the official CLI when applied", async (t) => {
  const homeDir = await tempHome(t);
  const codexDir = join(homeDir, ".codex");
  await mkdir(codexDir);
  const configPath = join(codexDir, "config.toml");
  await writeFile(configPath, "[mcp_servers.token2oauth]\nurl = 'https://gateway.example/mcp'\n");
  const calls = [];
  const runner = async (command, args) => { calls.push([command, args]); return { exitCode: 0, stdout: "removed" }; };
  const dryRun = await removeClientConnection({ client: "codex", name: "token2oauth" }, { homeDir, runner });
  assert.equal(dryRun.applied, false);
  assert.deepEqual(dryRun.args, ["mcp", "remove", "token2oauth"]);
  assert.equal(await readFile(configPath, "utf8"), "[mcp_servers.token2oauth]\nurl = 'https://gateway.example/mcp'\n");
  const applied = await removeClientConnection({ client: "codex", name: "token2oauth", apply: true }, { homeDir, runner });
  assert.equal(applied.applied, true);
  assert.deepEqual(calls, [["codex", ["--version"]], ["codex", ["--version"]], ["codex", ["mcp", "remove", "token2oauth"]]]);
});

test("manual web setup is labeled honestly and Desktop is unsupported", () => {
  assert.deepEqual(manualClientSetupNotes().map((row) => [row.client, row.support]), [
    ["ChatGPT Web", "manual"], ["Claude Desktop", "unsupported"],
  ]);
});
