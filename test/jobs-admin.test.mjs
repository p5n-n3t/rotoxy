import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { AdminSessions } from "../dist/admin-session.js";
import { createJobsAdminRouter } from "../dist/jobs-admin.js";

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); });
const close = (server) => new Promise((resolve) => server.close(resolve));

test("jobs page/API authenticate, expose only snapshot facts, and cap project reads at three", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-jobs-admin-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  t.after(async () => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
    await rm(root, { recursive: true, force: true });
  });
  const store = new StateStore();
  await store.init({ adminPassword: "test-only-admin", publicBaseUrl: "https://gateway.example/token2oauth" });
  const sessions = new AdminSessions();
  let active = 0, maxActive = 0;
  const backend = {
    callTool: async () => ({}),
    listProjects: () => ["project-a", "project-b", "project-c", "project-d", "<script>bad</script>"],
    readAdmin: async (id) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active--;
      return {
        projectControl: { projectId: id, state: "running", revision: 1, maxConcurrency: 2, activeTaskCount: 99 },
        jobs: [{ id: "job-1", status: "queued", label: "prompt should never display: private user instructions" }],
        tasks: [
          { id: "task-done", status: "completed", summary: "sensitive prompt should not render" },
          { id: "task-active", status: "running", prompt: "private prompt body" },
          { id: "task-waiting", status: "queued" },
          { id: "task-other", status: "paused" },
        ],
        events: [{ id: "err-1", severity: "error", message: "credential=private-secret prompt content", at: "2026-10-15T12:00:00Z" }],
        api_key: "must-not-appear",
      };
    },
  };
  const app = express();
  app.use(createJobsAdminRouter(store, sessions, backend));
  const server = createServer(app);
  const address = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${address.port}`;

  const denied = await fetch(base + "/admin/api/v1/jobs");
  assert.equal(denied.status, 401);
  assert.equal(maxActive, 0);
  const cookie = `t2o_admin=${sessions.create()}`;
  const response = await fetch(base + "/admin/api/v1/jobs", { headers: { cookie } });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.projects.length, 4);
  assert.ok(maxActive <= 3);
  assert.deepEqual(snapshot.projects[0].counts, { jobs: 1, tasks: 4, completed: 1, active: 1, pending: 1 });
  assert.equal(snapshot.projects[0].jobs[0].state, "queued");
  assert.deepEqual(snapshot.projects[0].errors, [{ id: "err-1", state: "error", at: "2026-10-15T12:00:00Z" }]);
  const serialized = JSON.stringify(snapshot);
  for (const privateValue of ["private user instructions", "sensitive prompt", "private prompt body", "credential=", "must-not-appear"]) assert.equal(serialized.includes(privateValue), false);

  const pageResponse = await fetch(base + "/admin/jobs", { headers: { cookie } });
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.match(html, /href="\/token2oauth\/admin\/supervisor\/project-a"/);
  assert.match(html, /Completed tasks/);
  assert.match(html, /Queued means reported queued/);
  assert.match(html, /Inspect reported jobs, tasks, and error events/);
  assert.doesNotMatch(html, /prompt should never display/i);
  assert.match(html, /task-done/);
  assert.match(html, /err-1/);
  assert.doesNotMatch(html, /private user instructions|sensitive prompt|private prompt body|credential=|must-not-appear/);
  assert.match(html, /name="_csrf"/);
  assert.match(pageResponse.headers.get("content-security-policy"), /default-src 'none'/);
});

test("jobs page redirects unauthenticated visitors and unknown task data stays unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-jobs-admin-unknown-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home"); process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  t.after(async () => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig; await rm(root, { recursive: true, force: true }); });
  const store = new StateStore();
  await store.init({ adminPassword: "test-only-admin", publicBaseUrl: "https://gateway.example/token2oauth" });
  const app = express(), sessions = new AdminSessions();
  app.use(createJobsAdminRouter(store, sessions, { callTool: async () => ({}), listProjects: () => ["project-unknown"], readAdmin: async () => ({ projectControl: { projectId: "project-unknown", state: "running", revision: 1, maxConcurrency: 1, activeTaskCount: 0 } }) }));
  const server = createServer(app), address = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${address.port}`;
  const denied = await fetch(base + "/admin/jobs", { redirect: "manual" });
  assert.equal(denied.status, 302);
  assert.match(denied.headers.get("location"), /^\/token2oauth\/admin\/login/);
  const cookie = `t2o_admin=${sessions.create()}`;
  const response = await fetch(base + "/admin/api/v1/jobs", { headers: { cookie } });
  const snapshot = await response.json();
  assert.equal(snapshot.projects[0].counts.jobs, null);
  assert.equal(snapshot.projects[0].counts.completed, null);
  assert.equal(snapshot.projects[0].counts.active, 0);
  assert.equal(snapshot.projects[0].counts.pending, null);
});

test("jobs page sends the primary ROTOXY Fleet to its canonical Fleet view", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-jobs-admin-fleet-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home"); process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  t.after(async () => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig; await rm(root, { recursive: true, force: true }); });
  const store = new StateStore();
  await store.init({ adminPassword: "test-only-admin", publicBaseUrl: "https://gateway.example/token2oauth" });
  const app = express(), sessions = new AdminSessions();
  app.use(createJobsAdminRouter(store, sessions, { callTool: async () => ({}), listProjects: () => ["token2oauth"], readAdmin: async () => ({ projectControl: { projectId: "token2oauth", state: "running", revision: 1, maxConcurrency: 1, activeTaskCount: 0 } }) }));
  const server = createServer(app), address = await listen(server);
  t.after(() => close(server));
  const response = await fetch(`http://127.0.0.1:${address.port}/admin/jobs`, { headers: { cookie: `t2o_admin=${sessions.create()}` } });
  const html = await response.text();
  assert.match(html, /href="\/token2oauth\/admin\/fleet">token2oauth/);
  assert.doesNotMatch(html, /href="\/token2oauth\/admin\/supervisor\/token2oauth"/);
  assert.doesNotMatch(html, />Unknown</);
});
