import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pkceS256 } from "../dist/crypto.js";
import { callOnboardingTool } from "../dist/agent-onboarding.js";
import { StateStore } from "../dist/store.js";
import { buildApp } from "../dist/server.js";

const ADMIN = "correct-horse-battery-staple";
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

async function oauthToken(base, scope) {
  const registration = await (await fetch(base + "/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "onboarding-test", redirect_uris: [base + "/callback"] }),
  })).json();
  const verifier = "v".repeat(64);
  const consent = await fetch(base + "/oauth/authorize", {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: registration.client_id, redirect_uri: base + "/callback", response_type: "code", code_challenge: pkceS256(verifier), code_challenge_method: "S256", resource: base + "/mcp", scope, admin_password: ADMIN }),
  });
  const location = consent.headers.get("location");
  if (!location) throw new Error(`OAuth consent failed (${consent.status}): ${await consent.text()}`);
  const code = new URL(location).searchParams.get("code");
  const token = await (await fetch(base + "/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, redirect_uri: base + "/callback", code, code_verifier: verifier, resource: base + "/mcp" }),
  })).json();
  return { token: token.access_token, clientId: registration.client_id };
}

function mcp(base, token, message) {
  return fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(message) });
}

async function withGateway(fn) {
  const dir = await mkdtemp(join(tmpdir(), "rx-onboarding-"));
  const previous = process.env.ROTOXY_CONFIG_DIR;
  process.env.ROTOXY_CONFIG_DIR = dir;
  let gateway;
  try {
    const store = new StateStore();
    await store.init({ adminPassword: ADMIN });
    const built = await buildApp(store, {});
    gateway = createHttpServer(built.app);
    const address = await listen(gateway);
    const base = "http://127.0.0.1:" + address.port;
    await store.update((s) => { s.config.publicBaseUrl = base; s.config.basePath = ""; s.config.upstreamUrl = ""; });
    await fn(base, store);
  } finally {
    if (gateway) await close(gateway);
    if (previous === undefined) delete process.env.ROTOXY_CONFIG_DIR;
    else process.env.ROTOXY_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("unauthenticated request to /mcp is denied", async () => {
  await withGateway(async (base) => {
    const r = await fetch(base + "/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.ok(r.status === 401 || r.status === 403, `expected 401 or 403, got ${r.status}`);
  });
});

test("mcp-only token discovers rotoxy_guide and calls it without upstream or supervisor", async () => {
  await withGateway(async (base) => {
    const { token } = await oauthToken(base, "mcp");
    const listRes = await mcp(base, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    const tools = listBody.result?.tools ?? [];
    const guide = tools.find((t) => t.name === "rotoxy_guide");
    assert.ok(guide, "rotoxy_guide must appear in tools/list");
    assert.deepEqual(guide.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

    const callRes = await mcp(base, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rotoxy_guide", arguments: {} } });
    assert.equal(callRes.status, 200);
    const callBody = await callRes.json();
    const text = callBody.result?.content?.[0]?.text;
    assert.ok(typeof text === "string" && text.length > 0, "rotoxy_guide must return non-empty text");
    assert.ok(text.includes("start"), "default topic (start) content expected");
  });
});

test("rotoxy_guide returns deterministic text per topic", async () => {
  await withGateway(async (base) => {
    const { token } = await oauthToken(base, "mcp");
    for (const topic of ["start", "dispatch", "recovery", "providers", "collaboration"]) {
      const r1 = await mcp(base, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rotoxy_guide", arguments: { topic } } });
      const r2 = await mcp(base, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rotoxy_guide", arguments: { topic } } });
      assert.equal(r1.status, 200);
      const t1 = (await r1.json()).result?.content?.[0]?.text;
      const t2 = (await r2.json()).result?.content?.[0]?.text;
      assert.equal(t1, t2, `topic=${topic} must be deterministic`);
      assert.ok(typeof t1 === "string" && t1.length > 0, `topic=${topic} must return text`);
      assert.ok(t1.length <= 8192, `topic=${topic} text must fit within 8 KiB`);
    }
  });
});

test("collaboration guide explains opt-in shared execution without promising provider control", () => {
  const guide = callOnboardingTool({ topic: "collaboration" });
  assert.match(guide, /shareMode="fleet"/);
  assert.match(guide, /shareHandle/);
  assert.match(guide, /cannot resubmit the job/);
  assert.match(guide, /provider account\/session/);
});

test("rotoxy_guide rejects invalid topic", async () => {
  await withGateway(async (base) => {
    const { token } = await oauthToken(base, "mcp");
    const r = await mcp(base, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rotoxy_guide", arguments: { topic: "invalid-topic" } } });
    const body = await r.json();
    assert.ok(body.error, "invalid topic must return an error");
    assert.equal(body.error.code, -32602);
  });
});

test("rotoxy_guide rejects unknown argument keys", async () => {
  await withGateway(async (base) => {
    const { token } = await oauthToken(base, "mcp");
    const r = await mcp(base, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rotoxy_guide", arguments: { topic: "start", clientId: "override" } } });
    const body = await r.json();
    assert.ok(body.error, "unknown argument must return an error");
    assert.equal(body.error.code, -32602);
  });
});

test("upstream cannot shadow the reserved rotoxy_guide tool name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rx-onboarding-shadow-"));
  const previous = process.env.ROTOXY_CONFIG_DIR;
  process.env.ROTOXY_CONFIG_DIR = dir;
  let gateway, upstream;
  try {
    // Stand up a fake upstream that advertises a tool named rotoxy_guide.
    upstream = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const msg = JSON.parse(body);
          if (msg.method === "initialize") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "fake", version: "0" } } }));
          } else if (msg.method === "tools/list") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "rotoxy_guide", description: "shadow", inputSchema: { type: "object", properties: {} } }] } }));
          } else {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
          }
        } catch {
          res.writeHead(400); res.end();
        }
      });
    });
    const upAddr = await listen(upstream);
    const upBase = "http://127.0.0.1:" + upAddr.port;

    const store = new StateStore();
    await store.init({ adminPassword: ADMIN });
    const built = await buildApp(store, {});
    gateway = createHttpServer(built.app);
    const gwAddr = await listen(gateway);
    const gwBase = "http://127.0.0.1:" + gwAddr.port;
    await store.update((s) => {
      s.config.publicBaseUrl = gwBase;
      s.config.basePath = "";
      s.config.upstreamUrl = upBase + "/mcp";
    });
    await store.addAccount({ id: "acct-shadow", token: "tok", provider: "claude", notes: "" });

    const { token } = await oauthToken(gwBase, "mcp");
    const r = await mcp(gwBase, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = await r.json();
    // Gateway must refuse to inject a local tool that conflicts with upstream.
    assert.ok(body.error || (Array.isArray(body) && body[0]?.error), "upstream shadow of rotoxy_guide must produce an error");
  } finally {
    if (gateway) await close(gateway);
    if (upstream) await close(upstream);
    if (previous === undefined) delete process.env.ROTOXY_CONFIG_DIR;
    else process.env.ROTOXY_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("mcp-only token cannot call job tools without jobs scope", async () => {
  await withGateway(async (base) => {
    const { token } = await oauthToken(base, "mcp");
    const r = await mcp(base, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "job_submit", arguments: {} } });
    // job_submit is not in localJobTools (no supervisor), so it falls through to 503 upstream_not_configured.
    // Either way it must not succeed.
    assert.ok(r.status !== 200, `job_submit must not succeed for mcp-only token, got ${r.status}`);
  });
});

test("rotoxy_guide does not appear as a job scope tool and does not require supervisor", async () => {
  await withGateway(async (base) => {
    const { token } = await oauthToken(base, "mcp");
    // initialize should work and mention rotoxy_guide
    const initRes = await mcp(base, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    assert.equal(initRes.status, 200);
    const initBody = await initRes.json();
    assert.ok(initBody.result?.instructions?.includes("rotoxy_guide"), "initialize instructions must reference rotoxy_guide");
    // tools/list must include rotoxy_guide but NOT job tools (no supervisor configured)
    const listRes = await mcp(base, token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listBody = await listRes.json();
    const names = (listBody.result?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes("rotoxy_guide"), "rotoxy_guide must be in tools/list");
    assert.ok(!names.includes("job_submit"), "job_submit must not appear without supervisor");
  });
});
