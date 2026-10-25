import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { AdminSessions, adminEpoch } from "../dist/admin-session.js";
import { createLightSprintSessionBindingsRouter } from "../dist/lightsprint-session-bindings.js";

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); });
const close = (server) => new Promise((resolve) => server.close(resolve));
const config = { version: 1, projects: [{ projectId: "shared-workspace", clientIds: [], accountIds: [], registeredSessions: [] }], sharedWorkspace: { projectId: "shared-workspace", membership: "authenticated_mcp" }, maxWorkers: 7, allowUnknownQuota: true, localLimits: { maxTasks: 20, maxJobBytes: 65536, maxOutputBytes: 16000 } };

async function setup(t, verifySession, verifyFreshBinding) {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-ls-session-bindings-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home"); process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "gateway");
  const store = new StateStore(); await store.init({ adminPassword: "test-only-password", publicBaseUrl: "http://127.0.0.1" });
  const account = await store.addAccount({ label: "LightSprint test account", token: "secret-test-token-123", provider: "lightsprint" });
  await store.update(state => { state.accounts.find(item => item.id === account.id).id = '_fixture-account'; });
  account.id = '_fixture-account';
  const configPath = join(root, "supervisor.json"); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); await chmod(configPath, 0o600);
  const sessions = new AdminSessions(), sid = sessions.create(60_000, adminEpoch(await store.load())), csrf = sessions.csrfToken(sid);
  const app = express(); app.use(createLightSprintSessionBindingsRouter(store, sessions, { configPath, verifySession, verifyFreshBinding }).router);
  const server = createServer(app), address = await listen(server), base = `http://127.0.0.1:${address.port}`;
  await store.setConfig("publicBaseUrl", base);
  t.after(async () => { await close(server); await rm(root, { recursive: true, force: true }); if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig; });
  return { root, store, account, configPath, sessions, sid, csrf, server, base };
}

test("session bindings require authenticated CSRF, exact provider status metadata, and revision-checked private writes", async (t) => {
  const calls = [];
  const ctx = await setup(t, async (accountId, sessionId) => { calls.push({ accountId, sessionId }); return { accountId, sessionId, workspaceId: "workspace-1", reportedModel: "claude-opus-5-5" }; });
  const cookie = `t2o_admin=${encodeURIComponent(ctx.sid)}`;
  const get = () => fetch(`${ctx.base}/admin/lightsprint/sessions`, { headers: { cookie } });
  const page = await get(), html = await page.text();
  assert.equal(page.status, 200); assert.match(html, /LightSprint bindings/); assert.doesNotMatch(html, /secret-test-token-123/);
  const revision = /name="expectedRevision" value="([a-f0-9]{64})"/.exec(html)?.[1]; assert.ok(revision);
  const post = (fields, { origin = ctx.base, csrf = ctx.csrf, auth = cookie } = {}) => fetch(`${ctx.base}/admin/lightsprint/sessions`, { method: "POST", redirect: "manual", headers: { cookie: auth, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, ...(csrf ? { _csrf: csrf } : {}) }) });
  assert.equal((await post({ action: "bind", expectedRevision: revision, projectId: "shared-workspace", accountId: ctx.account.id, workspaceId: "workspace-1", sessionId: "session-1", reportedModel: "claude-opus-5-5" }, { csrf: "" })).status, 403);
  assert.equal(calls.length, 0);
  const saved = await post({ action: "bind", expectedRevision: revision, projectId: "shared-workspace", accountId: ctx.account.id, workspaceId: "workspace-1", sessionId: "session-1", reportedModel: "claude-opus-5-5" });
  assert.equal(saved.status, 303); assert.equal(calls.length, 1);
  const parsed = JSON.parse(await readFile(ctx.configPath, "utf8"));
  assert.deepEqual(parsed.projects[0].registeredSessions, [{ sessionId: "session-1", accountId: ctx.account.id, workspaceId: "workspace-1", model: "claude-opus-5-5" }]);
  assert.deepEqual(parsed.projects[0].accountIds, [ctx.account.id]);
  const backup = await stat(`${ctx.configPath}.bak`); assert.equal(backup.mode & 0o077, 0);
  const stale = await post({ action: "unbind", expectedRevision: revision, projectId: "shared-workspace", sessionId: "session-1" });
  assert.equal(stale.status, 409);
  const after = await get(); assert.match(await after.text(), /session-1/);
  const currentRevision = /name="expectedRevision" value="([a-f0-9]{64})"/.exec(await (await get()).text())?.[1]; assert.ok(currentRevision);
  const unbound = await post({ action: "unbind", expectedRevision: currentRevision, projectId: "shared-workspace", sessionId: "session-1" });
  assert.equal(unbound.status, 303);
  const final = JSON.parse(await readFile(ctx.configPath, "utf8")); assert.deepEqual(final.projects[0].registeredSessions, []); assert.deepEqual(final.projects[0].accountIds, [ctx.account.id]);
});

test("unverified or mismatched provider session metadata never changes supervisor config", async (t) => {
  const ctx = await setup(t, async (accountId, sessionId) => ({ accountId, sessionId, workspaceId: "other-workspace", reportedModel: "model-wrong" }));
  const cookie = `t2o_admin=${encodeURIComponent(ctx.sid)}`;
  const html = await (await fetch(`${ctx.base}/admin/lightsprint/sessions`, { headers: { cookie } })).text();
  const revision = /name="expectedRevision" value="([a-f0-9]{64})"/.exec(html)?.[1]; assert.ok(revision);
  const response = await fetch(`${ctx.base}/admin/lightsprint/sessions`, { method: "POST", headers: { cookie, origin: ctx.base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ _csrf: ctx.csrf, action: "bind", expectedRevision: revision, projectId: "shared-workspace", accountId: ctx.account.id, workspaceId: "workspace-1", sessionId: "session-1", reportedModel: "claude-opus-5-5" }) });
  assert.equal(response.status, 400); assert.match(await response.text(), /session_metadata_mismatch/);
  assert.deepEqual(JSON.parse(await readFile(ctx.configPath, "utf8")), config);
});

test("fresh bindings require an authenticated, revision-fenced exact workspace and stack verification", async (t) => {
  const calls = [];
  const ctx = await setup(t,
    async (accountId, sessionId) => ({ accountId, sessionId, workspaceId: "workspace-1", reportedModel: "claude-opus-5-5" }),
    async (binding) => { calls.push(binding); return binding; });
  const cookie = `t2o_admin=${encodeURIComponent(ctx.sid)}`;
  const get = () => fetch(`${ctx.base}/admin/lightsprint/sessions`, { headers: { cookie } });
  const page = await get(), html = await page.text();
  assert.match(html, /Fresh worker provisioning/);
  const revision = /name="expectedRevision" value="([a-f0-9]{64})"/.exec(html)?.[1]; assert.ok(revision);
  const post = (fields, { origin = ctx.base, csrf = ctx.csrf } = {}) => fetch(`${ctx.base}/admin/lightsprint/sessions`, { method: "POST", redirect: "manual", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, ...(csrf ? { _csrf: csrf } : {}) }) });
  assert.equal((await post({ action: "bind_fresh", expectedRevision: revision, projectId: "shared-workspace", accountId: ctx.account.id, workspaceId: "workspace-1", stackId: "stack-1", provider: "claude" }, { csrf: "" })).status, 403);
  assert.equal(calls.length, 0);
  const saved = await post({ action: "bind_fresh", expectedRevision: revision, projectId: "shared-workspace", accountId: ctx.account.id, workspaceId: "workspace-1", stackId: "stack-1", provider: "claude" });
  assert.equal(saved.status, 303); assert.deepEqual(calls, [{ accountId: ctx.account.id, workspaceId: "workspace-1", stackId: "stack-1", provider: "claude" }]);
  const parsed = JSON.parse(await readFile(ctx.configPath, "utf8"));
  assert.deepEqual(parsed.projects[0].freshProvisioningBindings, [{ accountId: ctx.account.id, workspaceId: "workspace-1", stackId: "stack-1", provider: "claude" }]);
  assert.deepEqual(parsed.projects[0].accountIds, [ctx.account.id]);
  const current = await get(); const currentHtml = await current.text();
  const currentRevision = /name="expectedRevision" value="([a-f0-9]{64})"/.exec(currentHtml)?.[1]; assert.ok(currentRevision);
  assert.equal((await post({ action: "bind_fresh", expectedRevision: currentRevision, projectId: "shared-workspace", accountId: ctx.account.id, workspaceId: "workspace-1", stackId: "stack-1", provider: "claude" })).status, 400);
  const noExtra = await post({ action: "bind_fresh", expectedRevision: currentRevision, projectId: "shared-workspace", accountId: ctx.account.id, workspaceId: "workspace-1", stackId: "stack-2", provider: "claude", unexpected: "no" });
  assert.equal(noExtra.status, 400);
  const removed = await post({ action: "unbind_fresh", expectedRevision: currentRevision, projectId: "shared-workspace", accountId: ctx.account.id });
  assert.equal(removed.status, 303);
  const final = JSON.parse(await readFile(ctx.configPath, "utf8")); assert.deepEqual(final.projects[0].freshProvisioningBindings, []);
});

test("a failed fresh verifier cannot mutate supervisor config", async (t) => {
  const ctx = await setup(t,
    async (accountId, sessionId) => ({ accountId, sessionId, workspaceId: "workspace-1", reportedModel: "claude-opus-5-5" }),
    async () => { throw new Error("stack_unverified"); });
  const cookie = `t2o_admin=${encodeURIComponent(ctx.sid)}`;
  const html = await (await fetch(`${ctx.base}/admin/lightsprint/sessions`, { headers: { cookie } })).text();
  const revision = /name="expectedRevision" value="([a-f0-9]{64})"/.exec(html)?.[1]; assert.ok(revision);
  const response = await fetch(`${ctx.base}/admin/lightsprint/sessions`, { method: "POST", headers: { cookie, origin: ctx.base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ _csrf: ctx.csrf, action: "bind_fresh", expectedRevision: revision, projectId: "shared-workspace", accountId: ctx.account.id, workspaceId: "workspace-1", stackId: "stack-1", provider: "claude" }) });
  assert.equal(response.status, 400); assert.match(await response.text(), /stack_unverified/);
  assert.deepEqual(JSON.parse(await readFile(ctx.configPath, "utf8")), config);
});
