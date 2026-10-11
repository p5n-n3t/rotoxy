import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureClientConnection,
  inspectClientConnections,
  manualClientSetupNotes,
  removeClientConnection,
  restoreClientConnection,
} from "../dist/client-connections.js";

async function tempHome(t) {
  const homeDir = await mkdtemp(join(tmpdir(), "t2o-clients-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return homeDir;
}

function mockCli(operation = async () => ({ exitCode: 0, stdout: "ok" })) {
  return async (command, args) => {
    if (args[0] === "--version") return { exitCode: 0, stdout: command === "claude" ? "Claude Code 2.1.8" : "codex-cli 0.125.0" };
    if (args[0] === "mcp" && args[1] === "add" && args[2] === "--help") return { exitCode: 0, stdout: command === "claude" ? "Usage: mcp add --transport http --scope user" : "Usage: mcp add NAME --url URL" };
    if (args[0] === "mcp" && args[1] === "remove" && args[2] === "--help") return { exitCode: 0, stdout: command === "claude" ? "Usage: mcp remove NAME --scope user" : "Usage: mcp remove NAME" };
    return operation(command, args);
  };
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
    runner: async (command, args) => { calls.push([command, args]); return mockCli()(command, args); },
  });
  assert.equal(result.applied, false);
  assert.deepEqual(result.args, ["mcp", "add", "--transport", "http", "--scope", "user", "token2oauth", "https://gateway.example/mcp"]);
  assert.deepEqual(calls, [["claude", ["--version"]], ["claude", ["mcp", "add", "--help"]], ["claude", ["mcp", "remove", "--help"]]]);
  assert.equal(await readFile(join(homeDir, ".claude.json"), "utf8"), JSON.stringify({ mcpServers: { other: { type: "http", url: "https://other.test/mcp" } } }));
  assert.equal(result.backupPath, undefined);
});

test("apply saves an exact private config backup before official Codex add without printing its contents", async (t) => {
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
  const originalConfig = [
    "model = 'example'",
    "[mcp_servers.keep]",
    "url = 'https://keep.example/mcp?token=query-secret'",
    "bearer_token_env_var = 'PRIVATE_TOKEN_ENV'",
    "[mcp_servers.local]",
    "command = 'local-mcp'",
    "args = ['--secret', 'argument-secret']",
    "env = { TOKEN = 'env-secret' }",
  ].join("\n");
  const result = await configureClientConnection({ client: "codex", name: "token2oauth", url: "https://gateway.example/mcp", apply: true }, {
    homeDir,
    now: () => 123,
    runner: mockCli(async (command, args) => {
      calls.push([command, args]);
      assert.equal((await readdir(join(homeDir, ".token2oauth", "mcp-backups"))).length, 1, "private backup exists before CLI mutation");
      return { exitCode: 0, stdout: "added" };
    }),
  });
  assert.deepEqual(calls, [["codex", ["mcp", "add", "token2oauth", "--url", "https://gateway.example/mcp"]]]);
  assert.equal(result.applied, true);
  assert.match(result.backupPath, /123-codex-[0-9a-f-]+-exact-config\.json$/);
  const backup = await readFile(result.backupPath, "utf8");
  assert.equal(JSON.parse(backup).original.contentBase64, Buffer.from(originalConfig).toString("base64"));
  assert.equal(Buffer.from(JSON.parse(backup).original.contentBase64, "base64").toString(), originalConfig);
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(result), /query-secret|PRIVATE_TOKEN_ENV|argument-secret|env-secret/);
  assert.equal(result.message.includes("successful tool execution"), true);
});

test("refuses a duplicate registration and rejects credentials in endpoint URLs", async (t) => {
  const homeDir = await tempHome(t);
  await writeFile(join(homeDir, ".claude.json"), JSON.stringify({ mcpServers: { token2oauth: { type: "http", url: "https://existing.test/mcp" } } }));
  const runner = mockCli();
  await assert.rejects(configureClientConnection({ client: "claude-code", name: "token2oauth", url: "https://gateway.example/mcp", apply: true }, { homeDir, runner }), /already registered/);
  await assert.rejects(configureClientConnection({ client: "claude-code", name: "new", url: "https://user:secret@gateway.example/mcp" }, { homeDir, runner }), /without embedded credentials/);
});

test("removal is dry-run by default and delegates to the official CLI when applied", async (t) => {
  const homeDir = await tempHome(t);
  const codexDir = join(homeDir, ".codex");
  await mkdir(codexDir);
  const configPath = join(codexDir, "config.toml");
  const originalConfig = "model = 'kept'\n[mcp_servers.token2oauth]\nurl = 'https://gateway.example/mcp'\n[mcp_servers.local]\ncommand = 'local-server'\n";
  await writeFile(configPath, originalConfig);
  const originalMode = (await stat(configPath)).mode & 0o777;
  const calls = [];
  const runner = mockCli(async (command, args) => {
    calls.push([command, args]);
    assert.equal((await readdir(join(homeDir, ".token2oauth", "mcp-backups"))).length, 1, "private backup exists before CLI mutation");
    await writeFile(configPath, "model = 'kept'\n[mcp_servers.local]\ncommand = 'local-server'\n");
    return { exitCode: 0, stdout: "removed" };
  });
  const dryRun = await removeClientConnection({ client: "codex", name: "token2oauth" }, { homeDir, runner });
  assert.equal(dryRun.applied, false);
  assert.deepEqual(dryRun.args, ["mcp", "remove", "token2oauth"]);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);
  const applied = await removeClientConnection({ client: "codex", name: "token2oauth", apply: true }, { homeDir, runner });
  assert.equal(applied.applied, true);
  assert.ok(applied.backupPath);
  const afterRemove = await readFile(configPath, "utf8");
  assert.match(afterRemove, /mcp_servers\.local/);
  assert.doesNotMatch(afterRemove, /mcp_servers\.token2oauth/);
  assert.deepEqual(calls, [["codex", ["mcp", "remove", "token2oauth"]]]);
  const preview = await restoreClientConnection({ client: "codex", backupPath: applied.backupPath }, { homeDir });
  assert.equal(preview.applied, false);
  assert.equal(await readFile(configPath, "utf8"), afterRemove);
  const restored = await restoreClientConnection({ client: "codex", backupPath: applied.backupPath, apply: true }, { homeDir });
  assert.equal(restored.applied, true);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);
  assert.equal((await stat(configPath)).mode & 0o777, originalMode);
  await assert.rejects(restoreClientConnection({ client: "codex", backupPath: applied.backupPath, apply: true }, { homeDir }), /already been restored/);
});

test("Claude add preserves unrelated MCP servers and guarded restore refuses later config edits", async (t) => {
  const homeDir = await tempHome(t);
  const configPath = join(homeDir, ".claude.json");
  const originalConfig = JSON.stringify({ theme: "dark", mcpServers: { keep: { type: "http", url: "https://keep.example/mcp", headers: { Authorization: "sensitive" } } } }, null, 2);
  await writeFile(configPath, originalConfig);
  const runner = mockCli(async (_command, args) => {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.mcpServers[args[args.length - 2]] = { type: "http", url: args.at(-1) };
    await writeFile(configPath, JSON.stringify(config, null, 2));
    return { exitCode: 0, stdout: "added" };
  });
  const result = await configureClientConnection({ client: "claude-code", name: "token2oauth", url: "https://gateway.example/mcp", apply: true }, { homeDir, runner });
  const changed = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(Object.keys(changed.mcpServers).sort(), ["keep", "token2oauth"]);
  assert.equal(changed.mcpServers.keep.headers.Authorization, "sensitive");
  await writeFile(configPath, `${await readFile(configPath, "utf8")}\n`); // Simulate an unrelated later edit.
  await assert.rejects(restoreClientConnection({ client: "claude-code", backupPath: result.backupPath, apply: true }, { homeDir }), /changed after this backup/);
  assert.match(await readFile(configPath, "utf8"), /token2oauth/);
});

test("refuses incompatible official CLI help before backup or configuration changes", async (t) => {
  const homeDir = await tempHome(t);
  const configPath = join(homeDir, ".claude.json");
  const original = JSON.stringify({ mcpServers: {} });
  await writeFile(configPath, original);
  const runner = async (_command, args) => {
    if (args[0] === "--version") return { exitCode: 0, stdout: "Claude Code 2.0.0" };
    if (args[1] === "add") return { exitCode: 0, stdout: "Usage: mcp add NAME URL" };
    return { exitCode: 0, stdout: "Usage: mcp remove --scope user" };
  };
  await assert.rejects(configureClientConnection({ client: "claude-code", name: "token2oauth", url: "https://gateway.example/mcp", apply: true }, { homeDir, runner }), /does not advertise/);
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("add from an absent config can be restored to absence using only the saved client config", async (t) => {
  const homeDir = await tempHome(t);
  const configDir = join(homeDir, ".codex");
  const configPath = join(configDir, "config.toml");
  const runner = mockCli(async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, "[mcp_servers.token2oauth]\nurl = 'https://gateway.example/mcp'\n");
    return { exitCode: 0, stdout: "added" };
  });
  const added = await configureClientConnection({ client: "codex", name: "token2oauth", url: "https://gateway.example/mcp", apply: true }, { homeDir, runner });
  assert.match(await readFile(configPath, "utf8"), /token2oauth/);
  await restoreClientConnection({ client: "codex", backupPath: added.backupPath, apply: true }, { homeDir });
  await assert.rejects(readFile(configPath), { code: "ENOENT" });
});

test("refuses an insecure backup directory before invoking the config-changing command", async (t) => {
  const homeDir = await tempHome(t);
  const backupDir = join(homeDir, "public-backups");
  await mkdir(backupDir, { mode: 0o755 });
  const configPath = join(homeDir, ".claude.json");
  const original = JSON.stringify({ mcpServers: {} });
  await writeFile(configPath, original);
  let changed = false;
  const runner = mockCli(async () => { changed = true; return { exitCode: 0 }; });
  await assert.rejects(configureClientConnection({ client: "claude-code", name: "token2oauth", url: "https://gateway.example/mcp", apply: true }, { homeDir, backupDir, runner }), /owner-only directory/);
  assert.equal(changed, false);
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("manual web setup is labeled honestly and Desktop is unsupported", () => {
  assert.deepEqual(manualClientSetupNotes().map((row) => [row.client, row.support]), [
    ["ChatGPT Web", "manual"], ["Claude Desktop", "unsupported"],
  ]);
});
