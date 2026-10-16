import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminSessions, adminEpoch } from "../dist/admin-session.js";
import { createAgentWorkspaceAccessRouter } from "../dist/agent-workspace-access.js";
import { SupervisorRuntime, readSupervisorRuntimeConfig } from "../dist/supervisor-runtime.js";

const config = {
  version: 1,
  projects: [
    { projectId: "project-a", clientIds: ["client-a"], accountIds: ["acct-a"], registeredSessions: [{ sessionId: "session-a", accountId: "acct-a", model: "gpt-6-luna", workspaceId: "workspace-a" }] },
    { projectId: "project-b", clientIds: ["client-b"], accountIds: ["acct-b"], registeredSessions: [{ sessionId: "session-b", accountId: "acct-b", model: "gpt-6-luna", workspaceId: "workspace-b" }] },
  ],
  maxWorkers: 2, allowUnknownQuota: true,
  localLimits: { maxTasks: 10, maxJobBytes: 8192, maxOutputBytes: 1024 },
};

test("workspace membership edits persist narrowly, reauthorize immediately, and reject stale or unknown clients", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rotoxy-access-runtime-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "runtime.json");
  const original = JSON.stringify(config, null, 2) + "\n";
  await writeFile(configPath, original, { mode: 0o600 });
  const store = { async load() { return { oauthClients: [
    { clientId: "client-a", clientName: "A" }, { clientId: "client-b", clientName: "B" },
    { clientId: "client-c", clientName: "Normal sk-abcdefghijklmnop-secret" },
  ] }; } };
  const options = { configPath, configDir: dir, store, supervisionDbPath: join(dir, "inbox.sqlite"), recoveryDbPath: join(dir, "recovery.sqlite"), oracleConfigPath: join(dir, "oracle.json"), oracleDbPath: join(dir, "oracle.sqlite") };
  const runtime = new SupervisorRuntime(await readSupervisorRuntimeConfig(configPath), options);
  t.after(() => runtime.close());
  assert.deepEqual(await runtime.workspaceProjects("client-c"), []);
  const before = await runtime.workspaceAccessAdmin();
  assert.equal(before.editable, true);
  assert.equal(before.clients.find((client) => client.clientId === "client-c").label.includes("abcdefghijklmnop"), false);
  await assert.rejects(runtime.updateWorkspaceAccessAdmin({ projectId: "project-a", clientIds: ["unregistered"], expectedRevision: before.revision }), /workspace_access_unknown_client/);
  await assert.rejects(runtime.updateWorkspaceAccessAdmin({ projectId: "project-bad", clientIds: ["client-c"], expectedRevision: before.revision }), /workspace_access_unknown_project/);

  const changes = { projectId: "project-a", clientIds: ["client-a", "client-c"], expectedRevision: before.revision };
  const concurrent = await Promise.allSettled([runtime.updateWorkspaceAccessAdmin(changes), runtime.updateWorkspaceAccessAdmin(changes)]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
  const granted = concurrent.find((result) => result.status === "fulfilled").value;
  assert.deepEqual(await runtime.workspaceProjects("client-c"), [{ projectId: "project-a" }]);
  assert.doesNotThrow(() => runtime.authorizeWorkspace("project-a", "client-c"));
  assert.throws(() => runtime.authorizeWorkspace("project-b", "client-c"));
  await assert.rejects(runtime.updateWorkspaceAccessAdmin({ projectId: "project-a", clientIds: ["client-a"], expectedRevision: before.revision }), /workspace_access_conflict/);
  const savedText = await readFile(configPath, "utf8");
  const saved = JSON.parse(savedText);
  assert.deepEqual(saved.projects[0].clientIds, ["client-a", "client-c"]);
  assert.deepEqual(saved.projects[0].accountIds, config.projects[0].accountIds);
  assert.deepEqual(saved.projects[0].registeredSessions, config.projects[0].registeredSessions);
  assert.deepEqual(saved.projects[1], config.projects[1]);
  assert.equal(saved.maxWorkers, config.maxWorkers);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(`${configPath}.bak`)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(`${configPath}.bak`, "utf8")).projects[0].clientIds[0], "client-a");

  const restarted = new SupervisorRuntime(await readSupervisorRuntimeConfig(configPath), options);
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.workspaceProjects("client-c"), [{ projectId: "project-a" }]);
  await restarted.updateWorkspaceAccessAdmin({ projectId: "project-a", clientIds: ["client-a"], expectedRevision: granted.revision });
  assert.deepEqual(await restarted.workspaceProjects("client-c"), []);
  assert.throws(() => restarted.authorizeWorkspace("project-a", "client-c"));
  const revokeAll = await restarted.workspaceAccessAdmin();
  await restarted.updateWorkspaceAccessAdmin({ projectId: "project-a", clientIds: [], expectedRevision: revokeAll.revision });
  const reload = await readSupervisorRuntimeConfig(configPath);
  assert.deepEqual(reload.projects[0].clientIds, []);
});

test("an in-memory runtime exposes membership read-only and rejects edits without persisted config", async (t) => {
  const runtime = new SupervisorRuntime(config, { configDir: "/tmp", store: { async load() { return { oauthClients: [] }; } } });
  t.after(() => runtime.close());
  const snapshot = await runtime.workspaceAccessAdmin();
  assert.equal(snapshot.editable, false);
  assert.deepEqual(await runtime.workspaceProjects("client-a"), [{ projectId: "project-a" }]);
  await assert.rejects(runtime.updateWorkspaceAccessAdmin({ projectId: "project-a", clientIds: [], expectedRevision: snapshot.revision }), /workspace_access_not_persisted/);
});

test("admin access page requires session, CSRF and same-origin; exposes no credentials", async (t) => {
  const store = { async load() { return { config: { publicBaseUrl: "http://127.0.0.1" }, security: { adminEpoch: 0 } }; } };
  const sessions = new AdminSessions();
  const token = sessions.create(undefined, adminEpoch(await store.load()));
  const csrf = sessions.csrfToken(token);
  const revision = "a".repeat(64);
  const snapshot = { editable: true, revision, projects: [{ projectId: "project-a", clientIds: ["client-a"] }],
    clients: [{ clientId: "client-a", label: "Claude Code" }, { clientId: "client-b", label: "Bearer abcdef1234567890" }] };
  let update;
  const backend = { async workspaceAccessAdmin() { return snapshot; }, async updateWorkspaceAccessAdmin(value) { update = value; return snapshot; } };
  const app = express();
  app.use(createAgentWorkspaceAccessRouter(store, sessions, backend));
  const server = createServer(app);
  const address = await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${address.port}`;
  const anonymous = await fetch(`${base}/admin/agents/access`, { redirect: "manual" });
  assert.equal(anonymous.status, 302);
  const response = await fetch(`${base}/admin/agents/access`, { headers: { cookie: `t2o_admin=${token}` } });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  assert.match(html, /Agent workspace access/);
  assert.match(html, /no project access until an administrator grants it/);
  assert.doesNotMatch(html, /abcdef1234567890/);
  assert.match(html, /&lt;\/|Bearer \[REDACTED\]/);

  const url = `${base}/admin/agents/access`;
  const form = new URLSearchParams({ _csrf: csrf, expectedRevision: revision, projectId: "project-a", clientIds: "client-a" });
  assert.equal((await fetch(url, { method: "POST", headers: { cookie: `t2o_admin=${token}`, "content-type": "application/x-www-form-urlencoded", origin: "null" }, body: form })).status, 403);
  const withoutCsrf = new URLSearchParams({ expectedRevision: revision, projectId: "project-a", clientIds: "client-a" });
  assert.equal((await fetch(url, { method: "POST", headers: { cookie: `t2o_admin=${token}`, "content-type": "application/x-www-form-urlencoded", origin: base }, body: withoutCsrf })).status, 403);
  const accepted = await fetch(url, { method: "POST", redirect: "manual", headers: { cookie: `t2o_admin=${token}`, "content-type": "application/x-www-form-urlencoded", origin: base }, body: form });
  assert.equal(accepted.status, 303);
  assert.deepEqual(update, { projectId: "project-a", expectedRevision: revision, clientIds: ["client-a"] });
});
