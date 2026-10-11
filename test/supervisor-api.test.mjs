import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { buildApp } from "../dist/server.js";

const ADMIN = "correct-horse-battery-staple";
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); });
const close = (server) => new Promise((resolve) => server.close(resolve));

async function fixture(t, backend) {
  const dir = await mkdtemp(join(tmpdir(), "t2o-supervisor-ui-"));
  const previous = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;
  const store = new StateStore();
  await store.init({ adminPassword: ADMIN });
  const built = await buildApp(store, { supervisorBackend: backend });
  const server = createServer(built.app);
  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = `t2o_admin=${encodeURIComponent(built.sessions.create())}`;
  const csrf = built.sessions.csrfToken(decodeURIComponent(cookie.slice("t2o_admin=".length)));
  t.after(async () => { await close(server); await rm(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = previous; });
  return { base, cookie, csrf };
}

const headers = (cookie) => ({ cookie });

test("project dashboard and admin JSON require session and set the pre-AdminUi security headers", async (t) => {
  const reads = [];
  const backend = { callTool: async () => ({}), readAdmin: async (projectId) => { reads.push(projectId); return { events: [{ id: "e1", severity: "warning", message: "quota paused", paused: true }], supervisor: { status: "healthy" } }; } };
  const f = await fixture(t, backend);
  const denied = await fetch(f.base + "/admin/supervisor/project-a", { redirect: "manual" });
  assert.equal(denied.status, 302);
  assert.match(denied.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(denied.headers.get("cache-control"), /no-store/);
  assert.equal(denied.headers.get("x-frame-options"), "DENY");
  const deniedApi = await fetch(f.base + "/admin/api/v1/supervisor/project-a");
  assert.equal(deniedApi.status, 401);
  assert.match(deniedApi.headers.get("content-security-policy"), /script-src 'nonce-/);
  assert.match(deniedApi.headers.get("referrer-policy"), /no-referrer/);

  const page = await fetch(f.base + "/admin/supervisor/project-a?search=quota&severity=warning&pause=paused", { headers: headers(f.cookie) });
  const html = await page.text();
  assert.equal(page.status, 200);
  const nonce = page.headers.get("content-security-policy").match(/script-src 'nonce-([^']+)'/)[1];
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.match(html, /quota paused/);
  assert.match(html, /Pause live updates/);
  assert.deepEqual(reads, ["project-a"]);
  for (const name of ["cache-control", "content-security-policy", "x-frame-options", "referrer-policy", "x-content-type-options"]) assert.ok(page.headers.has(name), `${name} is set`);
});

test("live endpoint returns bounded sanitized filtered event HTML and status from the actual project snapshot", async (t) => {
  const snapshot = { supervisor: { status: "healthy" }, orchestrator: { status: "degraded" }, events: [
    { id: "1", severity: "warning", message: "quota paused", paused: true, api_key: "must-not-leak" },
    { id: "2", severity: "info", message: "worker online", paused: false },
    ...Array.from({ length: 118 }, (_, i) => ({ id: `event-${i + 3}`, severity: "info", message: "bounded activity", paused: false })),
  ] };
  let requestedProject;
  const f = await fixture(t, { callTool: async () => ({}), readAdmin: async (projectId) => { requestedProject = projectId; return snapshot; } });
  const response = await fetch(f.base + "/admin/api/v1/supervisor/project-b/live?search=quota&severity=warning&pause=paused", { headers: headers(f.cookie) });
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(requestedProject, "project-b");
  assert.equal(json.supervisor, "healthy");
  assert.equal(json.orchestrator, "degraded");
  assert.match(json.eventsHtml, /quota paused/);
  assert.doesNotMatch(json.eventsHtml, /worker online|must-not-leak/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);

  const unfiltered = await fetch(f.base + "/admin/api/v1/supervisor/project-b/live?severity=all&pause=all", { headers: headers(f.cookie) });
  const bounded = await unfiltered.json();
  assert.equal((bounded.eventsHtml.match(/class="event"/g) || []).length, 60);
});

test("backend snapshots are redacted and bounded; unknown backend failures stay visible without fabricated health", async (t) => {
  const f = await fixture(t, { callTool: async () => ({}), readAdmin: async () => ({ api_key: "top-secret", events: Array.from({ length: 250 }, (_, i) => ({ id: String(i), message: "event" })) }) });
  const response = await fetch(f.base + "/admin/api/v1/supervisor/project-c", { headers: headers(f.cookie) });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(body, /top-secret/);
  assert.ok(JSON.parse(body).events.length <= 200);

  const unavailable = await fixture(t, { callTool: async () => ({}), readAdmin: async () => { throw new Error("private internal details"); } });
  const page = await fetch(unavailable.base + "/admin/supervisor/project-d", { headers: headers(unavailable.cookie) });
  const html = await page.text();
  assert.equal(page.status, 404);
  assert.match(html, /Project snapshot is unavailable/);
  assert.doesNotMatch(html, /private internal details/);
  assert.match(html, />Unknown</);
});

test("existing revision-fenced admin control still rejects missing CSRF and delegates only valid project/action/revision", async (t) => {
  const calls = [];
  const f = await fixture(t, { callTool: async () => ({}), controlAdmin: async (input) => { calls.push(input); return { state: "confirmed", revision: input.expectedRevision + 1 }; } });
  const url = f.base + "/admin/api/v1/supervisor/control";
  const post = (csrf, body) => fetch(url, { method: "POST", headers: { ...headers(f.cookie), "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: JSON.stringify(body) });
  const request = { projectId: "project-e", action: "pause_dispatch", expectedRevision: 3 };
  const denied = await post(undefined, request);
  assert.equal(denied.status, 403);
  assert.deepEqual(calls, []);
  const invalid = await post(f.csrf, { ...request, expectedRevision: -1 });
  assert.equal(invalid.status, 400);
  const accepted = await post(f.csrf, request);
  assert.equal(accepted.status, 200);
  assert.deepEqual(calls, [request]);
});

test("supervision inbox requires admin auth, bounds pages, and CSRF-protects project event acknowledgments", async (t) => {
  const reads = [];
  const acks = [];
  const f = await fixture(t, { callTool: async () => ({}), readSupervision: async (...args) => { reads.push(args); return { project: args[0], events: [], models: [] }; }, acknowledgeSupervision: async (...args) => { acks.push(args); return { acknowledged: true, eventId: args[1] }; } });
  const url = f.base + "/admin/api/v1/supervisor/project-s/inbox";
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url + "?after=-1", { headers: headers(f.cookie) })).status, 400);
  const page = await fetch(url + "?after=12&limit=4", { headers: headers(f.cookie) });
  assert.equal(page.status, 200);
  assert.deepEqual(reads, [["project-s", 12, 4]]);
  const ackUrl = url + "/7/ack";
  const body = { method: "POST", headers: { ...headers(f.cookie), "content-type": "application/json" }, body: "{}" };
  assert.equal((await fetch(ackUrl, body)).status, 403);
  assert.deepEqual(acks, []);
  const accepted = await fetch(ackUrl, { ...body, headers: { ...body.headers, "x-csrf-token": f.csrf } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(acks, [["project-s", 7]]);
});
