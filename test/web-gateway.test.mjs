import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, chmod, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { buildApp } from "../dist/server.js";
import { pkceS256 } from "../dist/crypto.js";
import { loadWebToolsConfig } from "../dist/web-tools-config.js";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address())));
const close = (server) => new Promise((resolve) => server.close(resolve));

test("private web binding is opt-in, caller-scoped, provider-identified, and never retries a paid request", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-web-gateway-"));
  const previous = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = previous; });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore();
  assert.equal(store.dir, dir, "test accounts must use the temporary store");
  await store.init({ adminPassword: "correct-horse-battery-staple" });
  const account = await store.addAccount({ label: "temporary mock", provider: "exa", token: "mock-only-secret" });
  assert.equal(await loadWebToolsConfig(undefined, store), undefined);
  const path = join(dir, "web-tools.json");
  await writeFile(path, JSON.stringify({ providers: { exa: { enabled: true, accountId: account.id, features: { search: "supported", extract: "unknown" } }, tavily: { enabled: false, features: { search: "supported" } } }, permissions: { clients: { "oauth-a": ["web_search"] } } }), { mode: 0o600 });
  await chmod(path, 0o600);
  const linked = join(dir, "linked.json");
  await symlink(path, linked);
  await assert.rejects(loadWebToolsConfig(linked, store), /owner-private/);
  let calls = 0;
  let revealed = 0;
  const configured = await loadWebToolsConfig(path, {
    load: () => store.load(),
    revealToken: async (a) => { revealed += 1; return store.revealToken(a); },
  }, { fetch: async (_url, init) => { calls += 1; assert.equal(init.headers["x-api-key"], "mock-only-secret"); return new Response("provider unavailable", { status: 503 }); } });
  assert.deepEqual(await configured.definitionsFor("other-client", new Set(["web:search"])), []);
  assert.deepEqual(await configured.definitionsFor("oauth-a", new Set(["web:extract"])), []);
  assert.deepEqual((await configured.definitionsFor("oauth-a", new Set(["web:search"]))).map((x) => x.name), ["web_search"]);
  await assert.rejects(configured.call("web_search", { provider: "exa", query: "mock query" }, "other-client"), (e) => e.code === "tool_not_allowed");
  await assert.rejects(configured.call("web_extract", { provider: "exa", url: "https://example.test" }, "oauth-a"), (e) => e.code === "tool_not_allowed");
  assert.equal(calls, 0);
  assert.equal(revealed, 0);
  await assert.rejects(configured.call("web_search", { provider: "tavily", query: "mock query" }, "oauth-a"), (e) => e.code === "provider_not_enabled");
  assert.equal(calls, 0);
  await assert.rejects(configured.call("web_search", { provider: "exa", query: "mock query" }, "oauth-a"), (e) => e.code === "provider_request_failed");
  assert.equal(calls, 1);
  assert.equal(revealed, 1);
  const generic = await store.addAccount({ label: "not an Exa key", provider: "generic-bearer-mcp", token: "generic-mock" });
  await writeFile(path, JSON.stringify({ providers: { exa: { enabled: true, accountId: generic.id, features: { search: "supported" } } }, permissions: { clients: { "oauth-a": ["web_search"] } } }), { mode: 0o600 });
  let mismatchReveal = 0;
  const mismatched = await loadWebToolsConfig(path, { load: () => store.load(), revealToken: async () => { mismatchReveal += 1; return "generic-mock"; } }, { fetch: async () => { calls += 1; return new Response("should not run"); } });
  assert.deepEqual(await mismatched.definitionsFor("oauth-a", new Set(["web:search"])), []);
  await assert.rejects(mismatched.call("web_search", { provider: "exa", query: "mock query" }, "oauth-a"), (e) => e.code === "provider_request_failed");
  assert.equal(calls, 1);
  assert.equal(mismatchReveal, 0);
});

test("OAuth advertises and enforces separate web scopes for local MCP discovery and calls", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-web-oauth-"));
  const previous = process.env.TOKEN2OAUTH_CONFIG_DIR;
  t.after(() => { if (previous === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = previous; });
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;
  const store = new StateStore();
  await store.init({ adminPassword: "correct-horse-battery-staple" });
  const webTools = { definitionsFor: (_caller, scopes) => scopes.has("web:search") ? [{ name: "web_search", inputSchema: { type: "object" } }] : [], call: async () => ({ ok: true }) };
  const built = await buildApp(store, { webTools });
  const server = createServer(built.app);
  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  await store.update((s) => { s.config.publicBaseUrl = base; s.config.basePath = ""; });
  t.after(() => close(server));
  const metadata = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
  assert.ok(metadata.scopes_supported.includes("web:search"));
  assert.ok(metadata.scopes_supported.includes("web:extract"));
  const reg = await (await fetch(base + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [base + "/cb"] }) })).json();
  async function token(scope) {
    const verifier = "v".repeat(64);
    const authorized = await fetch(base + "/oauth/authorize", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: reg.client_id, redirect_uri: base + "/cb", response_type: "code", code_challenge: pkceS256(verifier), code_challenge_method: "S256", resource: base + "/mcp", scope, admin_password: "correct-horse-battery-staple" }) });
    assert.equal(authorized.status, 302);
    const code = new URL(authorized.headers.get("location")).searchParams.get("code");
    return (await fetch(base + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: reg.client_id, redirect_uri: base + "/cb", code, code_verifier: verifier, resource: base + "/mcp" }) })).json();
  }
  const tokenWithScope = await token("mcp web:search");
  const call = (access, message) => fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: JSON.stringify(message) });
  const listed = await (await call(tokenWithScope.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  assert.deepEqual(listed.result.tools.map((x) => x.name), ["web_search"]);
  const result = await (await call(tokenWithScope.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web_search", arguments: { provider: "exa", query: "test" } } })).json();
  assert.deepEqual(JSON.parse(result.result.content[0].text), { ok: true });
  const noScope = await token("mcp");
  const emptyDiscovery = await (await call(noScope.access_token, { jsonrpc: "2.0", id: 4, method: "tools/list" })).json();
  assert.deepEqual(emptyDiscovery.result.tools, []);
  const denied = await call(noScope.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_search", arguments: { provider: "exa", query: "test" } } });
  assert.equal(denied.status, 403);
});
