import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pkceS256 } from "../dist/crypto.js";
import { StateStore } from "../dist/store.js";
import { buildApp } from "../dist/server.js";
import { refreshAccountCapabilities } from "../dist/capabilities.js";

const ADMIN = "correct-horse-battery-staple";
const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
const close = (server) => new Promise((resolve) => server.close(resolve));

const TOOLS = [
  { name: "safe", description: "Harmless", inputSchema: { type: "object" } },
  { name: "danger", description: "Deletes <script>alert(1)</script> things", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
  { name: "reader", description: "Reads", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];

/**
 * A small Streamable-HTTP MCP upstream. Sessions belong to the token that
 * created them; `fail[token]` forces an HTTP status for tool traffic; `sse`
 * switches responses to text/event-stream.
 */
function mockUpstream() {
  const calls = [];
  const sessions = new Map();
  const ctl = { fail: {}, sse: false, calls, sessions };
  let n = 0;
  const server = createHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
      const session = req.headers["mcp-session-id"];
      let body;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined; } catch { body = undefined; }
      calls.push({ token, session: session || null, method: body?.method || req.method, tool: body?.params?.name, url: req.url });
      if (!["tok-A", "tok-B"].includes(token)) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end('{"error":"bad token"}');
      }
      if (req.method === "DELETE") { sessions.delete(session); res.writeHead(200); return res.end(); }
      if (session && sessions.get(session) !== token) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end('{"error":"unknown session"}');
      }
      const forced = ctl.fail[token];
      if (forced && body && ["tools/call", "tools/list"].includes(body.method)) {
        res.writeHead(forced, { "content-type": "application/json" });
        return res.end('{"error":"forced"}');
      }
      const headers = { "content-type": ctl.sse ? "text/event-stream" : "application/json" };
      let result;
      if (body?.method === "initialize") {
        const id = `sess-${token}-${++n}`;
        sessions.set(id, token);
        headers["mcp-session-id"] = id;
        result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "1.0" } };
      } else if (body?.method === "notifications/initialized") {
        res.writeHead(202); return res.end();
      } else if (body?.method === "tools/list") {
        result = { tools: TOOLS };
      } else if (body?.method === "tools/call") {
        result = body.params.name === "async"
          ? { task: { taskId: "task-" + token } }
          : { content: [{ type: "text", text: "ran " + body.params.name + " as " + token }] };
      } else if (body?.method === "tasks/get") {
        result = { servedBy: token };
      } else {
        result = { url: req.url };
      }
      const payload = JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? null, result });
      res.writeHead(200, headers);
      res.end(ctl.sse ? `event: message\ndata: ${payload}\n\n` : payload);
    });
  });
  return { server, ctl };
}

async function setup({ strategy = "round-robin", upstreamQuery = "" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "t2o-int-"));
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;
  const { server: upstream, ctl } = mockUpstream();
  const upAddr = await listen(upstream);
  const store = new StateStore();
  await store.init({ adminPassword: ADMIN });
  const built = await buildApp(store);
  const gateway = createHttpServer(built.app);
  const gwAddr = await listen(gateway);
  const base = `http://127.0.0.1:${gwAddr.port}`;
  await store.update((state) => {
    state.config.publicBaseUrl = base;
    state.config.basePath = "";
    state.config.upstreamUrl = `http://127.0.0.1:${upAddr.port}/mcp${upstreamQuery}`;
    state.config.strategy = strategy;
    state.config.maxFailoverAttempts = 3;
  });
  const a = await store.addAccount({ label: "Account A", token: "tok-A", priority: 1 });
  const b = await store.addAccount({ label: "Account B", token: "tok-B", priority: 2 });
  const teardown = async () => {
    await close(gateway);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, store, base, ctl, a, b, built, teardown };
}

async function oauthTokens(base) {
  const reg = await (await fetch(base + "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "test", redirect_uris: [base + "/cb"], token_endpoint_auth_method: "none" }),
  })).json();
  const verifier = "v".repeat(64);
  const authorized = await fetch(base + "/oauth/authorize", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: reg.client_id, redirect_uri: base + "/cb", response_type: "code",
      code_challenge: pkceS256(verifier), code_challenge_method: "S256",
      resource: base + "/mcp", scope: "mcp", admin_password: ADMIN,
    }),
  });
  const code = new URL(authorized.headers.get("location")).searchParams.get("code");
  const tokens = await (await fetch(base + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: reg.client_id, redirect_uri: base + "/cb", code, code_verifier: verifier, resource: base + "/mcp" }),
  })).json();
  return { ...tokens, clientId: reg.client_id };
}

function mcp(base, accessToken, message, session) {
  const headers = { authorization: "Bearer " + accessToken, "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) headers["mcp-session-id"] = session;
  return fetch(base + "/mcp", { method: "POST", headers, body: JSON.stringify(message) });
}

async function adminLogin(base, password = ADMIN) {
  const res = await fetch(base + "/admin/login", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password, next: "//evil.example/steal" }),
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { res, cookie };
}

async function csrfFrom(base, cookie, path = "/admin") {
  const html = await (await fetch(base + path, { headers: { cookie } })).text();
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return { html, csrf: match?.[1] };
}

function post(base, path, cookie, fields) {
  return fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

test("admin login rejects open redirects, admin POSTs require the session CSRF token, pages send security headers", async () => {
  const env = await setup();
  try {
    const { res, cookie } = await adminLogin(env.base);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), env.base + "/admin");
    const page = await fetch(env.base + "/admin", { headers: { cookie } });
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("cache-control"), "no-store");
    const { html, csrf } = await csrfFrom(env.base, cookie);
    assert.ok(csrf, "every admin form carries a CSRF token");
    const forms = html.match(/<form\b[^>]*method="post"[^>]*>/g).length;
    assert.equal(html.match(/name="_csrf"/g).length, forms);

    const without = await post(env.base, "/admin/config", cookie, { upstreamUrl: "https://evil.example/mcp", strategy: "random" });
    assert.equal(without.status, 403);
    assert.notEqual((await env.store.load()).config.upstreamUrl, "https://evil.example/mcp");

    const wrong = await post(env.base, "/admin/config", cookie, { _csrf: "A".repeat(43), upstreamUrl: "https://evil.example/mcp" });
    assert.equal(wrong.status, 403);

    const upstreamUrl = (await env.store.load()).config.upstreamUrl;
    const ok = await post(env.base, "/admin/config", cookie, { _csrf: csrf, upstreamUrl, strategy: "priority", maxFailoverAttempts: "2" });
    assert.equal(ok.status, 303);
    assert.equal((await env.store.load()).config.strategy, "priority");
  } finally {
    await env.teardown();
  }
});

test("OAuth consent from an admin session requires the CSRF token", async () => {
  const env = await setup();
  try {
    const { cookie } = await adminLogin(env.base);
    const reg = await (await fetch(env.base + "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "attacker", redirect_uris: ["https://attacker.example/cb"], token_endpoint_auth_method: "none" }),
    })).json();
    const fields = {
      client_id: reg.client_id, redirect_uri: "https://attacker.example/cb", response_type: "code",
      code_challenge: pkceS256("x".repeat(64)), code_challenge_method: "S256",
      resource: env.base + "/mcp", scope: "mcp", session_authorized: "1",
    };
    const forged = await post(env.base, "/oauth/authorize", cookie, fields);
    assert.equal(forged.status, 401, "a cross-site auto-submitted consent without CSRF is refused");

    const consentPage = await (await fetch(env.base + "/oauth/authorize?" + new URLSearchParams(fields), { headers: { cookie } })).text();
    const csrf = consentPage.match(/name="_csrf" value="([^"]+)"/)[1];
    const genuine = await post(env.base, "/oauth/authorize", cookie, { ...fields, _csrf: csrf });
    assert.equal(genuine.status, 302);
  } finally {
    await env.teardown();
  }
});

test("dashboard password regeneration shows the password once and revokes sessions; connection revocation is opt-in", async () => {
  const env = await setup();
  try {
    const tokens = await oauthTokens(env.base);
    const { cookie } = await adminLogin(env.base);
    let { csrf } = await csrfFrom(env.base, cookie, "/admin/security");

    const badCurrent = await post(env.base, "/admin/security/rotate", cookie, { _csrf: csrf, currentPassword: "nope" });
    assert.equal(badCurrent.status, 303);
    assert.match(badCurrent.headers.get("location"), /did%20not%20match/);

    const rotated = await post(env.base, "/admin/security/rotate", cookie, { _csrf: csrf, currentPassword: ADMIN });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.headers.get("cache-control"), "no-store");
    const html = await rotated.text();
    const password = html.match(/aria-label="New admin password">([^<]+)</)[1];
    assert.match(password, /^[A-Za-z0-9_-]{43}$/);
    const raw = await (await import("node:fs/promises")).readFile(join(env.dir, "state.json"), "utf8");
    assert.ok(!raw.includes(password), "plain password never reaches disk");

    const oldSession = await fetch(env.base + "/admin", { headers: { cookie }, redirect: "manual" });
    assert.equal(oldSession.status, 302, "existing admin session is signed out");
    assert.equal((await adminLogin(env.base, ADMIN)).res.status, 401);

    // Connections survive a plain rotation.
    const stillOk = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(stillOk.status, 200);

    // Rotate again with revocation: access and refresh tokens die.
    const second = await adminLogin(env.base, password);
    assert.equal(second.res.status, 302);
    ({ csrf } = await csrfFrom(env.base, second.cookie, "/admin/security"));
    const revoked = await post(env.base, "/admin/security/rotate", second.cookie, { _csrf: csrf, currentPassword: password, revokeConnections: "1" });
    assert.equal(revoked.status, 200);
    const denied = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 2, method: "ping" });
    assert.equal(denied.status, 401);
    const refresh = await fetch(env.base + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: tokens.clientId, refresh_token: tokens.refresh_token, resource: env.base + "/mcp" }),
    });
    assert.equal(refresh.status, 400);
    const state = await env.store.load();
    assert.equal(state.accounts.length, 2, "upstream credentials untouched");
    assert.equal(state.oauthClients.length, 1, "OAuth clients untouched");
  } finally {
    await env.teardown();
  }
});

test("a CLI-style rotation in another process signs out dashboard sessions via the admin epoch", async () => {
  const env = await setup();
  try {
    const { cookie } = await adminLogin(env.base);
    assert.equal((await fetch(env.base + "/admin", { headers: { cookie }, redirect: "manual" })).status, 200);
    await new StateStore().rotateAdminPassword("a-brand-new-long-password");
    assert.equal((await fetch(env.base + "/admin", { headers: { cookie }, redirect: "manual" })).status, 302);
  } finally {
    await env.teardown();
  }
});

test("tool policy is enforced server-side for tools/call and filters tools/list (JSON and SSE)", async () => {
  const env = await setup();
  try {
    const tokens = await oauthTokens(env.base);
    await env.store.update((s) => { s.config.toolPolicy = { denyTools: ["danger"] }; });

    for (const sse of [false, true]) {
      env.ctl.sse = sse;
      const list = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 7, method: "tools/list" });
      assert.equal(list.status, 200);
      const text = await list.text();
      const payload = sse ? JSON.parse(text.match(/^data: (.*)$/m)[1]) : JSON.parse(text);
      assert.deepEqual(payload.result.tools.map((t) => t.name), ["safe", "reader"]);
    }
    env.ctl.sse = false;

    const before = env.ctl.calls.length;
    const blocked = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "danger", arguments: {} } });
    assert.equal(blocked.status, 200);
    const err = await blocked.json();
    assert.equal(err.id, 8);
    assert.equal(err.error.code, -32602);
    assert.match(err.error.message, /tool policy/);
    assert.equal(env.ctl.calls.length, before, "blocked call never reached the upstream");

    const batch = await mcp(env.base, tokens.access_token, [
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "safe" } },
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "danger" } },
    ]);
    assert.deepEqual((await batch.json()).map((m) => m.id), [9, 10]);
    assert.equal(env.ctl.calls.length, before, "a batch with a blocked call is not partially forwarded");

    const allowed = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "safe" } });
    assert.match((await allowed.json()).result.content[0].text, /ran safe/);

    const notJson = await fetch(env.base + "/mcp", { method: "POST", headers: { authorization: "Bearer " + tokens.access_token, "content-type": "text/plain" }, body: "tools/call danger" });
    assert.equal(notJson.status, 400, "unparseable bodies are refused while a policy is active");
  } finally {
    await env.teardown();
  }
});

test("tool inventory is collected per account, rendered escaped, and the dashboard toggle writes an enforced policy", async () => {
  const env = await setup();
  try {
    const caps = await refreshAccountCapabilities(env.store, env.a.id);
    assert.equal(caps.ok, true);
    assert.deepEqual(caps.tools.map((t) => t.name), ["safe", "danger", "reader"]);
    assert.equal(caps.serverName, "mock");
    assert.equal(env.ctl.sessions.size, 0, "inventory closes the upstream session it opened");
    const raw = await (await import("node:fs/promises")).readFile(join(env.dir, "state.json"), "utf8");
    assert.ok(!raw.includes("tok-A"));

    const { cookie } = await adminLogin(env.base);
    const { html, csrf } = await csrfFrom(env.base, cookie, "/admin/tools");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(!html.includes("<script>alert(1)</script>"));

    const saved = await fetch(env.base + "/admin/tools/policy", {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([["_csrf", csrf], ["enabled", "safe"], ["enabled", "reader"], ["readOnly", "reader"]]),
    });
    assert.equal(saved.status, 303);
    const state = await env.store.load();
    assert.deepEqual(state.config.toolPolicy, { denyTools: ["danger"] });
    assert.deepEqual(state.config.readOnlyTools, ["reader"]);

    const tokens = await oauthTokens(env.base);
    const blocked = await (await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "danger" } })).json();
    assert.equal(blocked.error.code, -32602);

    // Re-enabling everything returns to passthrough.
    const { csrf: csrf2 } = await csrfFrom(env.base, cookie, "/admin/tools");
    await fetch(env.base + "/admin/tools/policy", {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([["_csrf", csrf2], ["enabled", "safe"], ["enabled", "reader"], ["enabled", "danger"]]),
    });
    assert.equal((await env.store.load()).config.toolPolicy, undefined);
  } finally {
    await env.teardown();
  }
});

test("failover replays only pre-execution rejections or read-only requests", async () => {
  const env = await setup({ strategy: "priority" });
  try {
    const tokens = await oauthTokens(env.base);
    env.ctl.fail["tok-A"] = 502;
    let before = env.ctl.calls.length;
    const call = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "safe" } });
    assert.equal(call.status, 502, "an ambiguous failure of a mutating call is not replayed");
    assert.deepEqual(env.ctl.calls.slice(before).map((c) => c.token), ["tok-A"]);

    await env.store.resetAccountHealth();
    before = env.ctl.calls.length;
    const list = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(list.status, 200, "read-only requests fail over");
    assert.deepEqual(env.ctl.calls.slice(before).map((c) => c.token), ["tok-A", "tok-B"]);

    await env.store.resetAccountHealth();
    env.ctl.fail["tok-A"] = 429;
    before = env.ctl.calls.length;
    const quota = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "safe" } });
    assert.equal(quota.status, 200, "a quota rejection happened before execution, so the call moves on");
    assert.deepEqual(env.ctl.calls.slice(before).map((c) => c.token), ["tok-A", "tok-B"]);

    await env.store.resetAccountHealth();
    env.ctl.fail["tok-A"] = 502;
    await env.store.update((s) => { s.config.readOnlyTools = ["reader"]; });
    before = env.ctl.calls.length;
    const reader = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "reader" } });
    assert.equal(reader.status, 200, "tools marked replay-safe fail over");
    assert.deepEqual(env.ctl.calls.slice(before).map((c) => c.token), ["tok-A", "tok-B"]);
  } finally {
    await env.teardown();
  }
});

test("sessions and tasks stay on their owning credential under every strategy, and unknown sessions are rediscovered", async () => {
  const env = await setup({ strategy: "round-robin" });
  try {
    const tokens = await oauthTokens(env.base);
    const init = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const session = init.headers.get("mcp-session-id");
    const owner = env.ctl.sessions.get(session);
    for (let i = 0; i < 4; i++) {
      const res = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: { name: "safe" } }, session);
      assert.equal(res.status, 200);
      assert.match((await res.json()).result.content[0].text, new RegExp("as " + owner));
    }

    const task = await (await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "async" } }, session)).json();
    const taskId = task.result.task.taskId;
    for (let i = 0; i < 3; i++) {
      const res = await (await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 30 + i, method: "tasks/get", params: { taskId } })).json();
      assert.equal(res.result.servedBy, owner, "task follow-ups route to the task owner without a session header");
    }

    // Simulate a gateway restart: ownership is forgotten, the session id is not.
    env.built.pool.ownership.forgetSession(session);
    const rediscovered = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "safe" } }, session);
    assert.equal(rediscovered.status, 200);
    const state = await env.store.load();
    assert.ok(state.accounts.every((a) => a.stats.state !== "cooldown"), "a 404 for a foreign session does not mark the credential unhealthy");

    // Disabling the owner makes the session unusable: the client is told to re-initialize.
    await env.store.setAccountEnabled(state.accounts.find((a) => a.label === (owner === "tok-A" ? "Account A" : "Account B")).id, false);
    const gone = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 41, method: "ping" }, session);
    assert.equal(gone.status, 404);
  } finally {
    await env.teardown();
  }
});

test("upstream URL query parameters survive proxying and diagnostics report honest telemetry", async () => {
  const env = await setup({ upstreamQuery: "?tenant=t1" });
  try {
    const tokens = await oauthTokens(env.base);
    const res = await (await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).json();
    assert.match(res.result.url, /tenant=t1/);

    const { cookie } = await adminLogin(env.base);
    const html = await (await fetch(env.base + "/admin/diagnostics", { headers: { cookie } })).text();
    assert.match(html, /Client request ping using Account [AB] succeeded \(HTTP 200\)/);
    assert.match(html, /<strong>Unavailable\.<\/strong> The upstream does not report remaining credits/);
    assert.ok(!html.includes("tok-A") && !html.includes("tok-B"));

    const json = await (await fetch(env.base + "/admin/diagnostics.json", { headers: { cookie } })).json();
    assert.equal(json.telemetry.summary.by.kind.request.count, 1);
    assert.ok(["healthy", "issues", "incomplete"].includes(json.doctor.status));
    const unauth = await fetch(env.base + "/admin/diagnostics.json", { redirect: "manual" });
    assert.equal(unauth.status, 302);
  } finally {
    await env.teardown();
  }
});

test("state files written before this release load unchanged and keep passthrough behaviour", async () => {
  const env = await setup();
  try {
    await env.store.update((s) => { delete s.security; delete s.capabilities; delete s.config.toolPolicy; delete s.config.readOnlyTools; });
    const tokens = await oauthTokens(env.base);
    const res = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal((await res.json()).result.tools.length, 3);
    assert.equal((await adminLogin(env.base)).res.status, 302);
  } finally {
    await env.teardown();
  }
});

test("lifecycle and CLI can only ever target Token2OAuth's own /token2oauth path", async () => {
  const { planUp, validateStep, DEFAULT_ROUTES, parseServeConfig, inspectRoutes, unrelatedView, canonicalJson } = await import("../dist/lifecycle.js");
  const serveConfig = parseServeConfig(JSON.stringify({
    TCP: { 443: { HTTPS: true } },
    Web: { "host.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:2025" } } } },
    AllowFunnel: { "host.ts.net:443": true },
  }));
  const observed = {
    service: { active: "active" },
    serveConfig,
    routes: inspectRoutes(serveConfig),
    unrelatedFingerprint: canonicalJson(unrelatedView(serveConfig)),
    configFingerprint: canonicalJson(serveConfig),
  };
  const plan = planUp(observed);
  assert.deepEqual(plan.steps.map((s) => [s.command, ...s.args].join(" ")), [
    "tailscale funnel --bg --https=443 --set-path=/token2oauth http://127.0.0.1:2030",
  ]);
  for (const ownedPath of ["/", "/loopback"]) {
    assert.throws(() => planUp(observed, { routes: { ownedPath } }));
    const routes = { ...DEFAULT_ROUTES, ownedPath };
    assert.throws(() => validateStep({ id: "route-add", kind: "tailscale", command: "tailscale", args: ["funnel", "--bg", "--https=443", "--set-path=" + ownedPath, routes.ownedTarget], description: "" }, routes));
  }

  const { execFile } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "t2o-cli-"));
  const result = await new Promise((resolve) => execFile(process.execPath, ["dist/cli.js", "tailscale", "expose", "--path", "/"], { env: { ...process.env, TOKEN2OAUTH_CONFIG_DIR: dir, PATH: "/nonexistent" } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stderr })));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /only manages its own compatibility path/);
  await rm(dir, { recursive: true, force: true });
});

test("review fixes: non-POST bodies, quota text on 5xx, odd tool names, framed consent, interrupted streams", async () => {
  const env = await setup({ strategy: "priority" });
  try {
    const tokens = await oauthTokens(env.base);
    await env.store.update((s) => { s.config.toolPolicy = { denyTools: ["ns:danger tool"] }; });
    const before = env.ctl.calls.length;
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await fetch(env.base + "/mcp", { method, headers: { authorization: "Bearer " + tokens.access_token, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "danger" } }) });
      assert.ok([400, 405].includes(res.status), method + " with a body is refused under a policy");
    }
    assert.equal(env.ctl.calls.length, before);
    const odd = await (await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ns:danger tool" } })).json();
    assert.equal(odd.error.code, -32602, "tool names with colons/spaces can be denied");
    await env.store.update((s) => { delete s.config.toolPolicy; });

    // 500 whose text matches a quota pattern: a write call must not be replayed.
    const { createServer } = await import("node:http");
    const flaky = createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"downstream rate limit exceeded"}'); }); });
    const fAddr = await listen(flaky);
    const original = (await env.store.load()).config.upstreamUrl;
    await env.store.update((s) => { s.config.upstreamUrl = `http://127.0.0.1:${fAddr.port}/mcp`; });
    const r500 = await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "safe" } });
    assert.equal(r500.status, 500);
    const events = env.built.telemetry.recent({ kind: "attempt", limit: 5 });
    assert.equal(events.filter((e) => e.tool === "safe" && e.status === 500).length, 1, "exactly one upstream attempt");
    await close(flaky);

    // An upstream that resets mid-stream must not crash the gateway.
    const broken = createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("event: message\ndata: {\"jsonrpc\":\"2.0\""); setTimeout(() => res.socket.destroy(), 30); }); });
    const bAddr = await listen(broken);
    await env.store.update((s) => { s.config.upstreamUrl = `http://127.0.0.1:${bAddr.port}/mcp`; });
    await env.store.resetAccountHealth();
    await mcp(env.base, tokens.access_token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "safe" } }).then((r) => r.text()).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await fetch(env.base + "/healthz")).status, 200, "gateway survived the interrupted stream");
    await close(broken);
    await env.store.update((s) => { s.config.upstreamUrl = original; });

    const consent = await fetch(env.base + "/oauth/authorize?client_id=x");
    assert.equal(consent.headers.get("x-frame-options"), "DENY");
    assert.match(consent.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  } finally {
    await env.teardown();
  }
});
