import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { formatKeyValues, formatTable } from "../dist/cli-format.js";

function cli(args, env) {
  return execFileSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, ...args], {
    env: { ...process.env, TOKEN2OAUTH_CONFIG_DIR: env.configDir }, encoding: "utf8",
  });
}

test("shared CLI formatter prints readable values, aligned tables, and human dates", () => {
  const values = formatKeyValues({ enabled: true, strategies: ["round-robin", "priority"], nested: { count: 2 } });
  assert.match(values, /enabled\s+yes/);
  assert.match(values, /strategies\s+round-robin, priority/);
  assert.match(values, /nested\.count\s+2/);
  const table = formatTable([{ label: "worker", enabled: false, lastProbeAt: 1_760_000_000_000 }]);
  assert.match(table, /label\s+enabled\s+lastProbeAt/);
  assert.match(table, /worker\s+no/);
  assert.doesNotMatch(table, /1760000000000/);
  const hostile = formatTable([{ value: ["one\u001b[31m", "two"], lastProbeAt: 1e100 }]);
  assert.doesNotMatch(hostile, /\u001b/);
  assert.match(hostile, /1e\+100/);
});

test("read-only CLI views are human by default and retain secret-safe JSON output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-cli-human-"));
  const configDir = join(root, "config");
  const previousConfigDir = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.TOKEN2OAUTH_CONFIG_DIR = configDir;
  t.after(() => { if (previousConfigDir === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = previousConfigDir; });
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore();
  await store.init({ adminPassword: "synthetic-cli-test-password" });
  const account = await store.addAccount({ label: "Readable account", token: "synthetic-cli-secret-token" });
  await store.update((state) => {
    state.config.upstreamUrl = "https://synthetic-user:synthetic-password@example.test/mcp?api_key=query-secret#fragment-secret";
    state.config.toolPolicy = { denyTools: ["dangerous_tool"] };
    const row = state.accounts.find(candidate => candidate.id === account.id);
    row.stats.lastProbeAt = 1_760_000_000_000;
  });

  const config = cli(["config", "show"], { configDir });
  assert.match(config, /upstreamUrl\s+https:\/\/<redacted>@example\.test\/mcp/);
  assert.doesNotMatch(config, /synthetic-password|query-secret|fragment-secret/);
  const configJson = JSON.parse(cli(["config", "list", "--json"], { configDir }));
  assert.match(configJson.upstreamUrl, /<redacted>/);
  assert.doesNotMatch(configJson.upstreamUrl, /query-secret|fragment-secret/);

  const accounts = cli(["account", "list"], { configDir });
  assert.match(accounts, /Readable account/);
  assert.match(accounts, /lastProbeAt/);
  assert.doesNotMatch(accounts, /synthetic-cli-secret-token/);
  const accountsJson = JSON.parse(cli(["account", "list", "--json"], { configDir }));
  assert.equal(accountsJson.length, 1);
  assert.equal(accountsJson[0].label, "Readable account");
  assert.doesNotMatch(JSON.stringify(accountsJson), /synthetic-cli-secret-token/);

  assert.match(cli(["pool", "status"], { configDir }), /Strategy:/);
  const poolJson = JSON.parse(cli(["pool", "status", "--json"], { configDir }));
  assert.equal(poolJson.accounts.length, 1);
  assert.match(cli(["tools", "policy", "show"], { configDir }), /denyTools\s+dangerous_tool/);
  assert.deepEqual(JSON.parse(cli(["tools", "policy", "show", "--json"], { configDir })), { denyTools: ["dangerous_tool"] });
  await store.update((state) => { state.config.upstreamUrl = "https://provider.example/mcp"; });
  assert.match(cli(["pools", "preview"], { configDir }), /legacy-default/);
  assert.deepEqual(JSON.parse(cli(["pools", "preview", "--json"], { configDir })).accountIds, [account.id]);
});
