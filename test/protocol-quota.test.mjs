import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { CredentialPool } from "../dist/pool.js";
import { McpProxy } from "../dist/proxy.js";
import { TelemetryRecorder } from "../dist/telemetry.js";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

function mockUpstream() {
  const calls = [];
  const responses = new Map();
  const server = createHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
      calls.push({ token, method: message.method, name: message.params?.name });
      const configured = responses.get(message.params?.name);
      const envelope = configured?.payload || {
        jsonrpc: "2.0", id: message.id,
        result: { content: [{ type: "text", text: "ok" }] },
      };
      const payload = JSON.stringify({ ...envelope, id: message.id });
      res.writeHead(200, { "content-type": configured?.sse ? "text/event-stream" : "application/json" });
      res.end(configured?.sse ? `event: message\ndata: ${payload}\n\n` : payload);
    });
  });
  return { server, calls, responses };
}

async function setup({ clientId = "trusted-client" } = {}) {
  const previousConfigDir = process.env.TOKEN2OAUTH_CONFIG_DIR;
  const dir = await mkdtemp(join(tmpdir(), "t2o-protocol-quota-"));
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;
  const upstream = mockUpstream();
  const upstreamAddress = await listen(upstream.server);
  const store = new StateStore();
  await store.init({ adminPassword: "test-password" });
  await store.update((state) => {
    state.config.upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}/mcp`;
    state.config.basePath = "";
    state.config.strategy = "priority";
    state.config.maxFailoverAttempts = 2;
  });
  const first = await store.addAccount({ label: "Account A", token: "token-a", priority: 1 });
  const second = await store.addAccount({ label: "Account B", token: "token-b", priority: 2 });
  const pool = new CredentialPool(store);
  const telemetry = new TelemetryRecorder({ capturePayloads: false });
  pool.telemetry = telemetry;
  const proxy = new McpProxy(store, pool, telemetry);
  const app = express();
  app.all("/mcp", express.raw({ type: "*/*", limit: "2mb" }), (req, res, next) => {
    res.locals.oauthClaims = { sub: "test-client", client_id: clientId };
    void proxy.handler(req, res, next);
  });
  const gateway = createHttpServer(app);
  const gatewayAddress = await listen(gateway);
  return {
    base: `http://127.0.0.1:${gatewayAddress.port}`,
    store, pool, telemetry, upstream, gateway, first, second, dir, previousConfigDir,
    async teardown() {
      await close(gateway);
      await close(upstream.server);
      await rm(dir, { recursive: true, force: true });
      if (previousConfigDir === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR;
      else process.env.TOKEN2OAUTH_CONFIG_DIR = previousConfigDir;
    },
  };
}

async function call(base, name, id, session, spoofClient = false) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) headers["mcp-session-id"] = session;
  if (spoofClient) headers["x-oauth-client-id"] = "header-spoof";
  return fetch(base + "/mcp", {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name }, ...(spoofClient ? { clientId: "body-spoof" } : {}) }),
  });
}

test("MCP telemetry attributes requests and attempts only to verified OAuth client claims", async () => {
  const env = await setup({ clientId: "verified-client" });
  try {
    const response = await call(env.base, "ordinary", 71, undefined, true);
    assert.equal(response.status, 200);
    await response.text();
    const events = env.telemetry.recent({ limit: 10 });
    const request = events.find((event) => event.kind === "request");
    const attempt = events.find((event) => event.kind === "attempt");
    assert.ok(request, JSON.stringify(events));
    assert.ok(attempt, JSON.stringify(events));
    assert.equal(request.clientId, "verified-client");
    assert.equal(attempt.clientId, "verified-client");
    assert.notEqual(request.clientId, "body-spoof");
    assert.notEqual(request.clientId, "header-spoof");
  } finally {
    await env.teardown();
  }
});

test("HTTP 200 protocol quota errors cool the owner without replaying or rewriting the response", async () => {
  const env = await setup();
  try {
    env.pool.ownership.bindSession("session-a", env.first.id);
    const json = {
      jsonrpc: "2.0", id: 1,
      result: { isError: true, content: [{ type: "text", text: "HTTP 402: Insufficient credits. Add credit packs, turn on usage-based billing, or wait for monthly renewal." }] },
    };
    const sse = {
      jsonrpc: "2.0", id: 2,
      result: { isError: true, content: [{ type: "text", text: "HTTP 402: Insufficient credits. Add credit packs, turn on usage-based billing, or wait for monthly renewal." }] },
    };
    env.upstream.responses.set("quota-json", { payload: json });
    env.upstream.responses.set("quota-sse", { payload: sse, sse: true });

    const jsonResponse = await call(env.base, "quota-json", 1, "session-a");
    const jsonText = await jsonResponse.text();
    assert.equal(jsonResponse.status, 200);
    assert.equal(jsonText, JSON.stringify(json), "the gateway forwards the protocol response unchanged");
    assert.deepEqual(env.upstream.calls.map((item) => item.token), ["token-a"], "a mutating request is never replayed");

    const stateAfterJson = await env.store.load();
    const firstAfterJson = stateAfterJson.accounts.find((account) => account.id === env.first.id);
    assert.equal(firstAfterJson.stats.state, "exhausted");
    assert.ok(firstAfterJson.stats.cooldownUntil > Date.now());
    assert.equal(firstAfterJson.stats.requests, 1);
    assert.equal(firstAfterJson.stats.failures, 1);
    assert.equal(firstAfterJson.stats.successes, 0);
    const requestEvent = env.telemetry.recent({ limit: 20 }).find((event) => event.kind === "request");
    assert.equal(requestEvent.errorClass, "upstream-protocol-quota");

    const sseResponse = await call(env.base, "quota-sse", 2, "session-a");
    const sseText = await sseResponse.text();
    assert.equal(sseResponse.status, 200);
    assert.equal(sseText, `event: message\ndata: ${JSON.stringify(sse)}\n\n`);
    assert.deepEqual(env.upstream.calls.map((item) => item.token), ["token-a", "token-a"], "session ownership survives cooldown");
    const afterSse = await env.store.load();
    const firstAfterSse = afterSse.accounts.find((account) => account.id === env.first.id);
    assert.equal(firstAfterSse.stats.requests, 2);
    assert.equal(firstAfterSse.stats.failures, 2);

    env.upstream.responses.set("unrelated", { payload: {
      jsonrpc: "2.0", id: 3,
      result: { isError: true, content: [{ type: "text", text: "HTTP 400: Invalid tool arguments" }] },
    } });
    const unrelated = await call(env.base, "unrelated", 3);
    assert.equal(unrelated.status, 200);
    await unrelated.text();
    const afterUnrelated = await env.store.load();
    assert.equal(afterUnrelated.accounts.find((account) => account.id === env.second.id).stats.state, "healthy");
    assert.equal(
      env.telemetry.recent({ limit: 20 }).find((event) => event.kind === "request" && event.accountId === env.second.id).errorClass,
      "upstream-protocol-error",
      "an unclassified tool error is recorded explicitly without a quota classification",
    );

    env.upstream.responses.set("bounded", { payload: {
      jsonrpc: "2.0", id: 4,
      result: { isError: true, content: [{ type: "text", text: "x".repeat(1_100_000) + " HTTP 402: Insufficient credits" }] },
    } });
    const bounded = await call(env.base, "bounded", 4);
    assert.equal(bounded.status, 200);
    await bounded.text();
    const afterBounded = await env.store.load();
    assert.equal(afterBounded.accounts.find((account) => account.id === env.second.id).stats.state, "healthy");

    env.upstream.responses.set("auth", { payload: {
      jsonrpc: "2.0", id: 5,
      result: { isError: true, content: [{ type: "text", text: "HTTP 401: Invalid provider credential" }] },
    } });
    const auth = await call(env.base, "auth", 5);
    assert.equal(auth.status, 200);
    await auth.text();
    const afterAuth = await env.store.load();
    assert.equal(afterAuth.accounts.find((account) => account.id === env.second.id).stats.state, "auth-failed");
    assert.deepEqual(
      env.upstream.calls.map((item) => item.token),
      ["token-a", "token-a", "token-b", "token-b", "token-b"],
      "protocol errors never replay an operation or move a session to another owner",
    );
  } finally {
    await env.teardown();
  }
});


test("direct LightSprint MCP mutation respects pool pause while status and stop remain available",async()=>{
 const h=await setup();
 try{
  await h.store.update(state=>{state.accounts.forEach(a=>{a.provider="lightsprint";});});
  const {ResourceRoutingRulesStore}=await import("../dist/resource-routing.js");
  await new ResourceRoutingRulesStore(h.store).replace({version:1,pools:{lightsprint:{enabled:false}}});
  const invoke=async(method,path)=>fetch(h.base+"/mcp",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"lightsprint_api",arguments:{method,path}}})});
  assert.equal((await invoke("POST","/api/agent-sessions/session-a/chat")).status,409);
  assert.equal(h.upstream.calls.length,0);
  assert.equal((await invoke("GET","/api/agent-sessions/session-a/status")).status,200);
  assert.equal((await invoke("POST","/api/agent-sessions/session-a/stop")).status,200);
  assert.equal(h.upstream.calls.length,2);
 }finally{await h.teardown();}
});
