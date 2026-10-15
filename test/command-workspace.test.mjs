import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
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

  const reads = [];
  const backend = {
    callTool: async () => ({}),
    listProjects: () => ["project-a", "<script>bad</script>"],
    readAdmin: async (id) => { reads.push(id); return { projectControl: { projectId: id, state: "running", revision: 1, maxConcurrency: 4, activeTaskCount: 2 }, workers: [{ id: "worker-a", prompt: "private prompt", status: "active" }], jobs: [{ id: "job-a", status: "queued" }], api_key: "must-not-leak" }; },
  };
  const sessions = new AdminSessions();
  const app = express();
  app.use(createCommandWorkspaceRouter(store, sessions, backend));
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
  assert.deepEqual(snapshot.counts, { gateway: 1, models: 1, cloudflare: 1 });
  assert.equal(snapshot.accounts.gateway[0].label, "Primary MCP");
  assert.equal(snapshot.accounts.models[0].label, "Ollama primary");
  assert.equal(snapshot.accounts.cloudflare[0].label, "Edge models");
  assert.deepEqual(snapshot.projects, [{ id: "project-a", state: "running", workers: 1, jobs: 1, activeTasks: 2 }]);
  assert.equal(JSON.stringify(snapshot).includes("secret-value"), false);
  assert.equal(JSON.stringify(snapshot).includes("private prompt"), false);
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
