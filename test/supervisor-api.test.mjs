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
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;
  const store = new StateStore();
  await store.init({ adminPassword: ADMIN });
  const built = await buildApp(store, { supervisorBackend: backend });
  const server = createServer(built.app);
  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = `t2o_admin=${encodeURIComponent(built.sessions.create())}`;
  const csrf = built.sessions.csrfToken(decodeURIComponent(cookie.slice("t2o_admin=".length)));
  t.after(async () => { await close(server); await rm(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = previous; if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
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
  const snapshot = { supervisor: { status: "healthy" }, orchestrator: { status: "degraded" }, workers: [{ id: "session-a", accountId: "acct-a", accountLabel: "Primary account", status: "running", monitorState: "running", requestedModel: "gpt-requested", actualModel: "gpt-observed", taskCorrelation: "job-a:task-1", heartbeatAt: 1791792000 }], events: [
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
  assert.match(json.workersHtml, /Primary account/);
  assert.match(json.workersHtml, /gpt-requested/);
  assert.match(json.workersHtml, /gpt-observed/);
  assert.match(json.workersHtml, /job-a:task-1/);
  assert.equal(json.activeWorkers, 1);
  assert.equal(json.attentionWorkers, 0);
  assert.match(json.latestHeartbeat, /2026-/);
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
  const invalidConcurrency = await post(f.csrf, { projectId: "project-e", action: "set_concurrency", value: 33, expectedRevision: 4 });
  assert.equal(invalidConcurrency.status, 400);
  const concurrency = { projectId: "project-e", action: "set_concurrency", value: 2, expectedRevision: 4 };
  const concurrencyResponse = await post(f.csrf, concurrency);
  assert.equal(concurrencyResponse.status, 200);
  assert.deepEqual(calls[1], concurrency);
  const unexpectedValue = await post(f.csrf, { ...request, value: true });
  assert.equal(unexpectedValue.status, 400);
});

test("worker guidance requires admin session and CSRF and delegates only the bounded registered-worker request", async (t) => {
  const calls = [];
  const f = await fixture(t, { callTool: async () => ({}), guidanceAdmin: async (input) => { calls.push(input); return { requestId: input.requestId, state: "accepted", reason: "provider_accepted_message", requestedModel: "gpt-6-luna", reportedModel: "gpt-6-luna" }; } });
  const url = f.base + "/admin/api/v1/supervisor/project-a/workers/session-a/guidance";
  const body = { requestId: "guidance-001", message: "Please clarify the next bounded step.", expectedPromptCount: 3, expectedQuestionId: "q-17" };
  const post = (cookie, csrf, value = body) => fetch(url, { method: "POST", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: JSON.stringify(value) });
  assert.equal((await post(undefined, f.csrf)).status, 401);
  assert.equal((await post(f.cookie, undefined)).status, 403);
  assert.equal((await post(f.cookie, f.csrf, { ...body, extra: "blocked" })).status, 400);
  assert.deepEqual(calls, []);
  const response = await post(f.cookie, f.csrf);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { requestId: body.requestId, state: "accepted", reason: "provider_accepted_message", requestedModel: "gpt-6-luna", reportedModel: "gpt-6-luna" });
  assert.deepEqual(calls, [{ projectId: "project-a", workerId: "session-a", ...body }]);
});

test("supervision inbox requires admin auth, bounds pages, and CSRF-protects project event acknowledgments", async (t) => {
  const reads = [];
  const acks = [];
  const f = await fixture(t, { callTool: async () => ({}), readSupervision: async (...args) => { reads.push(args); return { available: true, project: args[0], events: [], models: [], recovery: { available: true, project: args[0], cursor: 5, decisions: [{ eventId: "guidance-5", decision: { outcome: "human_handoff" } }], pendingHandoffs: [], notifyReceipts: [], oracleAdvice: [{ result: "api_key=should-be-redacted" }] } }; }, acknowledgeSupervision: async (...args) => { acks.push(args); return { acknowledged: true, eventId: args[1] }; } });
  const url = f.base + "/admin/api/v1/supervisor/project-s/inbox";
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url + "?after=-1", { headers: headers(f.cookie) })).status, 400);
  const page = await fetch(url + "?after=12&limit=4", { headers: headers(f.cookie) });
  const payload = await page.json();
  assert.equal(page.status, 200);
  assert.deepEqual(reads, [["project-s", 12, 4]]);
  assert.equal(payload.recovery.project, "project-s");
  assert.equal(payload.recovery.cursor, 5);
  assert.equal(payload.recovery.decisions[0].decision.outcome, "human_handoff");
  assert.doesNotMatch(JSON.stringify(payload), /should-be-redacted/);
  const ackUrl = url + "/7/ack";
  const body = { method: "POST", headers: { ...headers(f.cookie), "content-type": "application/json" }, body: "{}" };
  assert.equal((await fetch(ackUrl, body)).status, 403);
  assert.deepEqual(acks, []);
  const accepted = await fetch(ackUrl, { ...body, headers: { ...body.headers, "x-csrf-token": f.csrf } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(acks, [["project-s", 7]]);
});

test("compact project summary requires admin auth, bounds query/output, and delegates only its project scope", async (t) => {
  const reads = [];
  const summaryWorkers = Array.from({ length: 250 }, (_, index) => ({ id: `worker-${index}`, state: "idle" }));
  const f = await fixture(t, { callTool: async () => ({}), readCompactSummary: async (...args) => {
    reads.push(args);
    return { project: args[0], workers: summaryWorkers, events: [{ error: "api_key=do-not-return" }], cursor: args[1], hasMore: false };
  } });
  const url = f.base + "/admin/api/v1/supervisor/project-s/summary";
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url + "?after=-1", { headers: headers(f.cookie) })).status, 400);
  assert.equal((await fetch(url + "?limit=21", { headers: headers(f.cookie) })).status, 400);
  const response = await fetch(url + "?after=12&limit=4", { headers: headers(f.cookie) });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(reads, [["project-s", 12, 4]]);
  assert.equal(payload.project, "project-s");
  assert.ok(payload.workers.length <= 200, "redactor caps arrays and marks omitted entries");
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 512 * 1024);
  assert.doesNotMatch(JSON.stringify(payload), /do-not-return/);
});

test("Supervisor entry requires admin auth and lists only safe configured project links", async (t) => {
  const f = await fixture(t, { callTool: async () => ({}), listProjects: () => ["token2oauth", "<script>bad</script>"] });
  const denied = await fetch(f.base + "/admin/supervisor", { redirect: "manual" });
  assert.equal(denied.status, 302);
  const response = await fetch(f.base + "/admin/supervisor", { headers: headers(f.cookie) });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /admin\/fleet/);
  assert.match(html, /ROTOXY Fleet/);
  assert.doesNotMatch(html, /<script>bad/);
  assert.match(response.headers.get("content-security-policy"), /img-src 'self' data:/);
});


test("Fleet page uses a branded address while preserving durable identity and authenticated legacy links", async (t) => {
  const reads = [];
  const f = await fixture(t, { callTool: async () => ({}), readAdmin: async id => { reads.push(id); return { workers: [] }; } });
  const denied = await fetch(f.base + "/admin/fleet", { redirect: "manual" });
  assert.equal(denied.status, 302);
  assert.deepEqual(reads, []);
  const legacy = await fetch(f.base + "/admin/supervisor/token2oauth?severity=warning", { redirect: "manual", headers: headers(f.cookie) });
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get("location"), "/admin/fleet?severity=warning");
  assert.deepEqual(reads, []);
  const current = await fetch(f.base + legacy.headers.get("location"), { headers: headers(f.cookie) });
  assert.equal(current.status, 200);
  assert.match(await current.text(), /Workforce control desk · ROTOXY Fleet/);
  assert.deepEqual(reads, ["token2oauth"]);
});
