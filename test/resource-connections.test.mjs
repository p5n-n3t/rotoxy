import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { AdminSessions } from "../dist/admin-session.js";
import { createResourceConnectionsRouter } from "../dist/resource-connections.js";
import { loadWebToolsConfig } from "../dist/web-tools-config.js";

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); });
const close = (server) => new Promise((resolve) => server.close(resolve));

test("private resource connections are admin/CSRF gated, encrypted, explicit, and redacted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-resource-connections-"));
  const priorConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  const priorHome = process.env.HOME;
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  process.env.HOME = join(root, "home");
  t.after(() => { if (priorConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = priorConfig; });
  t.after(() => { if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome; });
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore();
  assert.equal(store.dir, join(root, "config"));
  await store.init({ adminPassword: "local-test-admin" });
  await store.update((state) => { state.oauthClients.push({ clientId: "oauth-known", clientName: "Known client", redirectUris: ["http://127.0.0.1/cb"], tokenEndpointAuthMethod: "none", createdAt: Date.now() }); });
  const sessions = new AdminSessions();
  const session = sessions.create(60_000, 0);
  const csrf = sessions.csrfToken(session);
  const app = express();
  app.use(createResourceConnectionsRouter(store, sessions));
  const server = createServer(app);
  const address = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(base + "/admin/api/v1/resource-connections")).status, 401);
  const secret = "mock-provider-key-should-never-return";
  const noCsrf = await fetch(base + "/admin/api/v1/resource-connections/accounts", {
    method: "POST", headers: { cookie: `t2o_admin=${session}`, "content-type": "application/json" },
    body: JSON.stringify({ provider: "exa", label: "Exa", credential: secret }),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await store.load()).accounts.length, 0);

  const add = async (provider) => fetch(base + "/admin/api/v1/resource-connections/accounts", {
    method: "POST", headers: { cookie: `t2o_admin=${session}`, "x-csrf-token": csrf, "content-type": "application/json" },
    body: JSON.stringify({ provider, label: `${provider} team`, credential: `${provider}-mock-key` }),
  });
  const exaResponse = await add("exa");
  assert.equal(exaResponse.status, 201);
  assert.equal((await exaResponse.text()).includes("mock-key"), false);
  await add("firecrawl");
  await add("tavily");
  const stored = await store.load();
  const exa = stored.accounts.find((account) => account.provider === "exa");
  assert.equal(await store.revealToken(exa), "exa-mock-key");
  assert.equal(JSON.stringify(exa.secret).includes("exa-mock-key"), false);

  const statePath = join(store.dir, "web-tools.json");
  const save = await fetch(base + "/admin/api/v1/resource-connections", {
    method: "POST", headers: { cookie: `t2o_admin=${session}`, "x-csrf-token": csrf, "content-type": "application/json" },
    body: JSON.stringify({
      providers: { exa: { accountId: exa.id, features: { search: true, extract: false } }, firecrawl: { accountId: stored.accounts.find((a) => a.provider === "firecrawl").id, features: { search: true, extract: true } } },
      permissions: { clients: { "oauth-known": ["web_search"] }, "unknown-client": ["web_extract"] },
    }),
  });
  assert.equal(save.status, 200);
  const result = await save.json();
  assert.deepEqual(result.clients, [{ id: "oauth-known", name: "Known client", allowedTools: ["web_search"] }]);
  assert.equal(result.providers.find((p) => p.provider === "exa").status, "connected");
  assert.equal(result.providers.find((p) => p.provider === "tavily").status, "not_configured");
  const config = await readFile(statePath, "utf8");
  assert.equal(config.includes("mock-key"), false);
  assert.deepEqual(JSON.parse(config).permissions.clients, { "oauth-known": ["web_search"] });
  await chmod(statePath, 0o600);
  assert.equal((await lstat(statePath)).mode & 0o077, 0);
  const resolvedWebTools = await loadWebToolsConfig(statePath, store, { fetch: async (_url, init) => {
    assert.equal(init.headers["x-api-key"], "exa-mock-key");
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  assert.deepEqual((await resolvedWebTools.definitionsFor("oauth-known", new Set(["web:search", "web:extract"]))).map((tool) => tool.name), ["web_search"]);
  const mockSearch = await resolvedWebTools.call("web_search", { provider: "exa", query: "local mock" }, "oauth-known");
  assert.equal(mockSearch.provider, "exa");
  await assert.rejects(resolvedWebTools.call("web_extract", { provider: "exa", url: "https://example.test" }, "oauth-known"), (error) => error.code === "tool_not_allowed");

  const listing = await fetch(base + "/admin/api/v1/resource-connections", { headers: { cookie: `t2o_admin=${session}` } });
  const listed = await listing.text();
  assert.equal(listed.includes(secret), false);
  assert.match(listed, /credential|credentialStatus|allowedTools/);
  const html = await (await fetch(base + "/admin/resources", { headers: { cookie: `t2o_admin=${session}` } })).text();
  assert.match(html, /Search &amp; scraping APIs/);
  assert.match(html, /Models &amp; APIs/);
  assert.match(html, /Known client/);
  assert.equal(html.includes("exa-mock-key"), false);

  await store.update((state) => { state.security = { adminEpoch: 1 }; });
  assert.equal((await fetch(base + "/admin/api/v1/resource-connections", { headers: { cookie: `t2o_admin=${session}` } })).status, 401);
});
