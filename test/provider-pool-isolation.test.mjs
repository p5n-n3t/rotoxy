import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { CredentialPool } from "../dist/pool.js";

test("provider-specific web keys never enter a different MCP pool or probe; generic bearer remains compatible", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-pool-isolation-"));
  const priorConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  const priorHome = process.env.HOME;
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  process.env.HOME = join(root, "home");
  t.after(() => { if (priorConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = priorConfig; });
  t.after(() => { if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome; });
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore();
  assert.equal(store.dir, join(root, "config"), "set isolated HOME/config before constructing StateStore");
  await store.init({ adminPassword: "local-test-admin" });
  for (const provider of ["generic-bearer-mcp", "exa", "firecrawl", "tavily"]) {
    await store.addAccount({ label: provider, provider, token: `${provider}-secret` });
  }
  const pool = new CredentialPool(store);
  let state = await store.load();

  state.config.strategy = "round-robin";
  state.config.upstreamUrl = "https://mcp.lightsprint.ai/mcp";
  const genericOnly = pool.pick(state);
  assert.equal(genericOnly.provider, "generic-bearer-mcp");
  assert.equal(state.accounts.filter((account) => pool.isCompatibleAccount(account, state)).length, 1);

  state.config.upstreamUrl = "https://mcp.exa.ai/mcp";
  const exaAndGeneric = state.accounts.filter((account) => pool.isCompatibleAccount(account, state)).map((account) => account.provider).sort();
  assert.deepEqual(exaAndGeneric, ["exa", "generic-bearer-mcp"]);
  for (let i = 0; i < 12; i++) assert.ok(["exa", "generic-bearer-mcp"].includes(pool.pick(state).provider));

  state.config.upstreamUrl = "https://mcp.firecrawl.dev/v2/mcp";
  const firecrawlAndGeneric = state.accounts.filter((account) => pool.isCompatibleAccount(account, state)).map((account) => account.provider).sort();
  assert.deepEqual(firecrawlAndGeneric, ["firecrawl", "generic-bearer-mcp"]);
  for (let i = 0; i < 12; i++) assert.ok(["firecrawl", "generic-bearer-mcp"].includes(pool.pick(state).provider));

  state.config.upstreamUrl = "not a URL";
  assert.equal(pool.pick(state).provider, "generic-bearer-mcp");

  let calls = 0;
  const mock = createServer((_req, res) => { calls += 1; res.writeHead(200, { "content-type": "application/json" }); res.end('{"jsonrpc":"2.0","id":"probe","result":{}}'); });
  const address = await new Promise((resolve) => mock.listen(0, "127.0.0.1", () => resolve(mock.address())));
  t.after(() => new Promise((resolve) => mock.close(resolve)));
  await store.update((stored) => { stored.config.upstreamUrl = `http://127.0.0.1:${address.port}/mcp`; });
  const exa = (await store.load()).accounts.find((account) => account.provider === "exa");
  const refused = await pool.probeAccount(exa.id);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /does not match/);
  assert.equal(calls, 0, "mismatched provider credentials are rejected before network I/O");
  const generic = (await store.load()).accounts.find((account) => account.provider === "generic-bearer-mcp");
  assert.equal((await pool.probeAccount(generic.id)).ok, true);
  assert.equal(calls, 1, "generic bearer account compatibility remains intact");
});
