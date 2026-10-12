import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pkceS256 } from "../dist/crypto.js";
import { StateStore } from "../dist/store.js";
import { buildApp } from "../dist/server.js";

const ADMIN = "test-only-affinity-password";
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.listening ? server.close(resolve) : resolve());

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "t2o-affinity-storage-"));
  const previousConfigDir = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;
  const calls = [];
  const sessionOwners = new Map([["agent-a", "token-a"], ["agent-b", "token-b"]]);
  const control = { denyToken: undefined, ambiguousToken: undefined };
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { message = {}; }
      const sessionId = req.headers["mcp-session-id"];
      calls.push({ token, sessionId, method: message.method, name: message.params?.name, args: message.params?.arguments });
      if (control.ambiguousToken === token && message.method === "tools/call" && message.params?.name === "mutate") {
        req.socket.destroy();
        return;
      }
      if (control.denyToken === token) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "session access denied" }));
        return;
      }
      if (sessionId && sessionOwners.get(sessionId) !== token) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "session belongs to another account" }));
        return;
      }
      let result = { content: [{ type: "text", text: "ok" }] };
      if (message.method === "tools/call" && message.params?.name === "lightsprint_api") {
        const match = /^\/api\/agent-sessions\/([A-Za-z0-9_-]{1,128})\/status$/.exec(message.params?.arguments?.path || "");
        const isOwner = match ? sessionOwners.get(match[1]) === token : false;
        result = { content: [{ type: "text", text: JSON.stringify({ status: { isOwner } }) }] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  const address = await listen(upstream);
  const store = new StateStore();
  await store.init({ adminPassword: ADMIN });
  await store.update((state) => {
    state.config.upstreamUrl = `http://127.0.0.1:${address.port}/mcp`;
    state.config.strategy = "round-robin";
    state.config.maxFailoverAttempts = 2;
    state.config.failoverStateful = true;
  });
  const accountA = await store.addAccount({ label: "synthetic A", token: "token-a" });
  const accountB = await store.addAccount({ label: "synthetic B", token: "token-b" });
  const built = await buildApp(store);
  const gateway = createServer(built.app);
  const gatewayAddress = await listen(gateway);
  const base = `http://127.0.0.1:${gatewayAddress.port}`;
  await store.update((state) => { state.config.publicBaseUrl = base; state.config.basePath = ""; });
  t.after(async () => {
    await close(gateway);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR;
    else process.env.TOKEN2OAUTH_CONFIG_DIR = previousConfigDir;
  });
  const tokens = await oauthTokens(base);
  return { base, tokens, built, accountA, accountB, calls, control };
}

async function oauthTokens(base) {
  const client = await (await fetch(base + "/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "affinity test", redirect_uris: [base + "/cb"], token_endpoint_auth_method: "none" }),
  })).json();
  const verifier = "v".repeat(64);
  const authorization = await fetch(base + "/oauth/authorize", {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.client_id, redirect_uri: base + "/cb", response_type: "code",
      code_challenge: pkceS256(verifier), code_challenge_method: "S256", resource: base + "/mcp", scope: "mcp", admin_password: ADMIN }),
  });
  if (authorization.status !== 302) throw new Error(`OAuth authorize failed (${authorization.status}): ${(await authorization.text()).slice(0, 300)}`);
  const code = new URL(authorization.headers.get("location")).searchParams.get("code");
  const tokenResponse = await fetch(base + "/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: base + "/cb", code, code_verifier: verifier, resource: base + "/mcp" }),
  });
  return tokenResponse.json();
}

function statusMessage(id, sessionId) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "lightsprint_api", arguments: {
    method: "GET", path: `/api/agent-sessions/${sessionId}/status`,
  } } };
}

async function mcp(f, message, sessionId) {
  return fetch(f.base + "/mcp", { method: "POST", headers: {
    authorization: `Bearer ${f.tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  }, body: JSON.stringify(message) });
}

test("two trusted LightSprint session bindings route independently and survive denied/non-owner responses", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.built.pool.registerSessionOwner("agent-a", f.accountA.id), { ok: true, ownerAccountId: f.accountA.id });
  assert.deepEqual(f.built.pool.registerSessionOwner("agent-b", f.accountB.id), { ok: true, ownerAccountId: f.accountB.id });
  assert.deepEqual(f.built.pool.registerSessionOwner("agent-a", f.accountB.id), { ok: false, ownerAccountId: f.accountA.id });

  const a = await mcp(f, statusMessage(1, "agent-a"), "agent-a");
  const b = await mcp(f, statusMessage(2, "agent-b"), "agent-b");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(f.calls.slice(0, 2).map((call) => [call.sessionId, call.token]), [["agent-a", "token-a"], ["agent-b", "token-b"]]);
  assert.equal(f.built.pool.ownership.sessionOwner("agent-a"), f.accountA.id);
  assert.equal(f.built.pool.ownership.sessionOwner("agent-b"), f.accountB.id);

  const falseStatus = await mcp(f, statusMessage(3, "agent-b"), "agent-a");
  const falsePayload = await falseStatus.json();
  assert.equal(JSON.parse(falsePayload.result.content[0].text).status.isOwner, false);
  assert.equal(f.calls.at(-1).token, "token-a");
  assert.equal(f.built.pool.ownership.sessionOwner("agent-a"), f.accountA.id);
  assert.equal(f.built.pool.ownership.sessionOwner("agent-b"), f.accountB.id, "isOwner=false/HTTP 200 cannot overwrite the trusted binding");

  const beforeUnknown = f.calls.length;
  const nonOwner200 = await mcp(f, statusMessage(3, "agent-a"), "unregistered-mcp-session");
  assert.equal(nonOwner200.status, 404);
  assert.equal(f.calls.length, beforeUnknown, "HTTP 200/status.isOwner=false must not establish ownership");
  assert.equal(f.built.pool.ownership.sessionOwner("unregistered-mcp-session"), undefined);

  f.control.denyToken = "token-a";
  const deniedStart = f.calls.length;
  const denied = await mcp(f, statusMessage(4, "agent-a"), "agent-a");
  assert.equal(denied.status, 403);
  assert.deepEqual(f.calls.slice(deniedStart).map((call) => call.token), ["token-a"], "a denied owner request never fails over to account B");
  assert.equal(f.built.pool.ownership.sessionOwner("agent-a"), f.accountA.id);
});

test("an ambiguous mutation on a bound session is never replayed to another account", async (t) => {
  const f = await fixture(t);
  f.built.pool.registerSessionOwner("agent-a", f.accountA.id);
  f.control.ambiguousToken = "token-a";
  const response = await mcp(f, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "mutate", arguments: { input: "synthetic" } } }, "agent-a");
  assert.equal(response.status, 502);
  assert.deepEqual(f.calls.map((call) => call.token), ["token-a"]);
});
