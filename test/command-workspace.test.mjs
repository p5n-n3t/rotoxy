import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { AdminSessions } from "../dist/admin-session.js";
import { ModelCredentialStore } from "../dist/model-credentials.js";
import { CloudflareCredentialStore } from "../dist/cloudflare-ai.js";
import { createCommandWorkspaceRouter } from "../dist/command-workspace.js";

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); });
const close = (server) => new Promise((resolve) => server.close(resolve));

test("workspace command centre is authenticated and renders bounded real resources without secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-command-workspace-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  t.after(async () => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig; await rm(root, { recursive: true, force: true }); });

  const store = new StateStore();
  await store.init({ adminPassword: "test-only-admin", publicBaseUrl: "https://gateway.example/token2oauth" });
  await store.addAccount({ label: "Primary MCP", token: "mock-mcp-secret-value", provider: "exa" });
  await new ModelCredentialStore(store).addCredential("Ollama primary", "mock-model-secret-value");
  await new CloudflareCredentialStore(store).addCredential({ label: "Edge models", accountId: "0123456789abcdef0123456789abcdef", token: "mock-cloudflare-secret", allowedModels: [] });
  const codexProfileId = "00000000-0000-4000-8000-000000000001";
  await writeFile(join(store.dir, "codex-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: codexProfileId, label: "<script>Profile</script>", profileDir: "/private/codex-home-must-not-leak", createdAt: 1760000000000, updatedAt: 1760000000001, apiKey: "mock-codex-secret" }] }), { mode: 0o600 });
  await chmod(join(store.dir, "codex-profiles.json"), 0o600);

  const reads = [];
  const oracleReads = [];
  const oracleSnapshot = { available: true, hosts: [
    { host: "ora1", models: ["qwen3.5:9b"], lastCatalogCheck: 1760000000, catalogCheckState: "checked", assignedTasks: 8, completedTasks: 5, runningTasks: 2, catalogError: "private oracle error" },
    { host: "ora3", models: ["gpt-oss:20b"], lastCatalogCheck: null, catalogCheckState: "never_checked", assignedTasks: 1, completedTasks: 1, runningTasks: 0 },
    { host: "ora5", models: ["tev1:0.8b", "custom-model"], lastCatalogCheck: null, catalogCheckState: "unknown", assignedTasks: 0, completedTasks: 0, runningTasks: 0 },
    { host: "ora9", models: ["qwen3.5:9b"], catalogCheckState: "checked", assignedTasks: 99, completedTasks: 99, runningTasks: 99 },
  ], summary: {}, tasks: {}, events: {}, advisoryModel: {} };
  const backend = {
    callTool: async () => ({}),
    listProjects: () => ["project-a", "<script>bad</script>"],
    readAdmin: async (id) => { reads.push(id); return { projectControl: { projectId: id, state: "running", revision: 1, maxConcurrency: 4, activeTaskCount: 2 }, workers: [{ id: "worker-a", prompt: "private prompt", status: "active" }], jobs: [{ id: "job-a", status: "queued" }], api_key: "must-not-leak" }; },
  };
  const sessions = new AdminSessions();
  const app = express();
  app.use(createCommandWorkspaceRouter(store, sessions, backend, { loadOracleSnapshot: async (paths) => { oracleReads.push(paths); return oracleSnapshot; } }));
  const server = createServer(app);
  const address = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${address.port}`;

  const denied = await fetch(base + "/admin/api/v1/workspace/snapshot");
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("content-security-policy"), /script-src 'nonce-/);
  assert.equal(reads.length, 0);
  const session = sessions.create();
  const cookie = `t2o_admin=${session}`;
  const snapshotResponse = await fetch(base + "/admin/api/v1/workspace/snapshot", { headers: { cookie } });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.deepEqual(snapshot.counts, { gateway: 1, models: 1, cloudflare: 1, oracleHosts: 4, codexProfiles: 1 });
  assert.equal(snapshot.accounts.gateway[0].label, "Primary MCP");
  assert.equal(snapshot.accounts.models[0].label, "Ollama primary");
  assert.equal(snapshot.accounts.cloudflare[0].label, "Edge models");
  assert.deepEqual(snapshot.oracle.hosts.map((host) => host.host), ["ora1", "ora3", "ora5", "ora9"]);
  assert.equal(snapshot.oracle.hosts[0].runningTasks, 2);
  assert.deepEqual(snapshot.oracle.hosts[2].models, ["tev1:0.8b", "custom-model"]);
  assert.equal(snapshot.codex.profiles[0].label, "<script>Profile</script>");
  assert.equal(snapshot.codex.profiles[0].state, "unknown");
  assert.equal(Object.hasOwn(snapshot.codex.profiles[0], "profileDir"), false);
  assert.ok(oracleReads[0].supervisorCwd.endsWith("/supervisor"));
  assert.match(oracleReads[0].configPath, /\.local\/state\/rotoxy\/oracle-pool\/config\.json$/);
  assert.match(oracleReads[0].dbPath, /\.local\/state\/rotoxy\/oracle-pool\/queue\.sqlite3$/);
  assert.deepEqual(snapshot.projects, [{ id: "project-a", state: "running", workers: 1, jobs: 1, activeTasks: 2 }]);
  assert.equal(JSON.stringify(snapshot).includes("secret-value"), false);
  assert.equal(JSON.stringify(snapshot).includes("private prompt"), false);
  assert.equal(JSON.stringify(snapshot).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(snapshot).includes("mock-codex-secret"), false);
  assert.equal(JSON.stringify(snapshot).includes("private oracle error"), false);
  assert.equal(JSON.stringify(snapshot).includes("custom-model"), true);
  assert.equal(JSON.stringify(snapshot).includes("ora9"), true);
  assert.deepEqual(reads, ["project-a"]);

  const response = await fetch(base + "/admin/workspace", { headers: { cookie } });
  const html = await response.text();
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy");
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(html, /data-node-type="gateway"/);
  assert.match(html, /data-node-type="pool"/);
  assert.match(html, /data-node-type="account"/);
  assert.match(html, /data-node-type="oracle"/);
  assert.match(html, /data-node-type="codex"/);
  assert.match(html, /href="\/token2oauth\/admin\/oracle"/);
  assert.match(html, /href="\/token2oauth\/admin\/codex"/);
  assert.match(html, /Running tasks 2/);
  assert.match(html, /Models unknown · Last seen unknown/);
  assert.match(html, /Profile&lt;\/script&gt;/);
  assert.match(html, /class="cw-split"/);
  assert.match(html, /@media\(max-width:390px\)/);
  assert.match(html, /id="rx-main-content"/);
  assert.match(html, /data-workspace-app/);
  assert.match(html, /aria-current="page">Workspace<\/a>/);
  assert.match(html, /Primary MCP/);
  assert.match(html, /Edge models/);
  assert.doesNotMatch(html, /mock-mcp-secret-value|mock-model-secret-value|mock-cloudflare-secret|private prompt|must-not-leak/);
  assert.match(html, /setInterval\(\(\)=>void tick\(\),10000\)/);
  assert.match(html, /visibilitychange/);
  assert.match(html, /prefers-reduced-motion:reduce/);
});

test("workspace marks absent registries and failed Oracle reads unavailable without launching workers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-command-workspace-missing-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  t.after(async () => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig; await rm(root, { recursive: true, force: true }); });
  const store = new StateStore();
  await store.init({ adminPassword: "test-only-admin" });
  let oracleReads = 0;
  const sessions = new AdminSessions();
  const app = express();
  app.use(createCommandWorkspaceRouter(store, sessions, undefined, { loadOracleSnapshot: async () => { oracleReads++; throw new Error("oracle unavailable"); } }));
  const server = createServer(app);
  const address = await listen(server);
  t.after(() => close(server));
  const session = sessions.create();
  const response = await fetch(`http://127.0.0.1:${address.port}/admin/api/v1/workspace/snapshot`, { headers: { cookie: `t2o_admin=${session}` } });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.deepEqual(snapshot.oracle, { available: false, hosts: [] });
  assert.equal(snapshot.counts.oracleHosts, null);
  assert.deepEqual(snapshot.codex, { state: "not_configured", profiles: [] });
  assert.equal(snapshot.counts.codexProfiles, 0);
  assert.equal(oracleReads, 1);
});

test("workspace rejects an unsafe Codex registry and keeps its profile count unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-command-workspace-invalid-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  t.after(async () => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig; await rm(root, { recursive: true, force: true }); });
  const store = new StateStore();
  await store.init({ adminPassword: "test-only-admin" });
  await writeFile(join(store.dir, "codex-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "unsafe", label: "bad", createdAt: 1, updatedAt: 1 }] }), { mode: 0o600 });
  const sessions = new AdminSessions();
  const app = express();
  app.use(createCommandWorkspaceRouter(store, sessions, undefined, { loadOracleSnapshot: async () => ({ available: false, hosts: [] }) }));
  const server = createServer(app);
  const address = await listen(server);
  t.after(() => close(server));
  const session = sessions.create();
  const response = await fetch(`http://127.0.0.1:${address.port}/admin/api/v1/workspace/snapshot`, { headers: { cookie: `t2o_admin=${session}` } });
  const snapshot = await response.json();
  assert.equal(snapshot.codex.state, "unavailable");
  assert.equal(snapshot.counts.codexProfiles, null);
  assert.deepEqual(snapshot.codex.profiles, []);
});
