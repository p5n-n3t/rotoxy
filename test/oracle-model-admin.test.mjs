import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { AdminSessions, adminEpoch } from "../dist/admin-session.js";
import { createOracleModelAdminRouter } from "../dist/oracle-model-admin.js";

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); });
const close = (server) => new Promise((resolve) => server.close(resolve));

test("Oracle model page is authenticated, explicit-refresh and preview-only under CSRF", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-oracle-model-admin-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home"); process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "gateway");
  const store = new StateStore();
  await store.init({ adminPassword: "synthetic-admin-only", publicBaseUrl: "http://127.0.0.1:2030/oracle" });
  const sessions = new AdminSessions(), session = sessions.create(60_000, adminEpoch(await store.load()));
  const revision = "A".repeat(24), configRevision = "B".repeat(24);
  const view = { cacheRevision: revision, configRevision, cacheUpdatedAt: null,
    hosts: [{ id: "ora3", enabled: true, allowedModels: ["qwen3.5:9b"], hostStatus: "unknown", models: [], observedAt: null, load: { running: 0, assigned: 1 } }],
    queue: { available: true, reason: null, statuses: { queued: 1 }, hosts: { ora3: { running: 0, assigned: 1 } } },
    apply: { mode: "previewOnly", blockedReason: "Pool dispatch has no shared maintenance fence; queue state can change after this snapshot." } };
  const calls = [];
  const runner = async (command, args, request, input) => {
    calls.push({ command, args, request, input });
    assert.equal(command, "/usr/bin/python3"); assert.deepEqual(args.slice(0, 2), ["-m", "snooze.oracle_model_admin"]);
    assert.equal(request.cwd, join(root, "supervisor")); assert.equal(request.timeoutMs, 10_000);
    return JSON.stringify(view);
  };
  const app = express();
  app.use("/oracle", createOracleModelAdminRouter(store, sessions, {
    configPath: join(root, "runtime", "config.json"), dbPath: join(root, "runtime", "queue.sqlite3"), cachePath: join(root, "state", "models.json"), supervisorCwd: join(root, "supervisor"), commandRunner: runner,
  }).router);
  const server = createServer(app), address = await listen(server);
  await store.setConfig("publicBaseUrl", `http://127.0.0.1:${address.port}/oracle`);
  const base = `http://127.0.0.1:${address.port}/oracle`, cookie = `t2o_admin=${encodeURIComponent(session)}`, csrf = sessions.csrfToken(session);
  const post = (fields, { withCsrf = true, origin = `http://127.0.0.1:${address.port}` } = {}) => fetch(`${base}/admin/oracle/models`, { method: "POST", redirect: "manual", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, ...(withCsrf ? { _csrf: csrf } : {}) }) });
  t.after(async () => { await close(server); await rm(root, { recursive: true, force: true }); if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig; });

  assert.equal((await fetch(`${base}/admin/oracle/models`, { redirect: "manual" })).status, 302);
  assert.equal(calls.length, 0);
  const denied = await post({ action: "refresh", revision }, { withCsrf: false }); assert.equal(denied.status, 403); assert.equal(calls.length, 0);
  const response = await fetch(`${base}/admin/oracle/models`, { headers: { cookie } });
  assert.equal(response.status, 200); const html = await response.text();
  assert.match(html, /Installed model names come from the last explicit/); assert.match(html, /shared maintenance fence/); assert.match(html, /name="_csrf"/);
  assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0].input), { action: "read" });
  const badOrigin = await post({ action: "refresh", revision }, { origin: "https://attacker.invalid" });
  assert.equal(badOrigin.status, 403); assert.equal(calls.length, 1);
  const refreshed = await post({ action: "refresh", revision });
  assert.equal(refreshed.status, 303);
  assert.deepEqual(JSON.parse(calls.at(-1).input), { action: "refresh", expectedCacheRevision: revision });
  const preview = await post({ action: "apply", revision: configRevision });
  assert.equal(preview.status, 303); assert.deepEqual(JSON.parse(calls.at(-1).input), { action: "apply", expectedConfigRevision: configRevision });
  const invalid = await post({ action: "exec", command: "/usr/bin/systemctl restart", revision });
  assert.equal(invalid.status, 400); assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => !c.input.includes("systemctl") && !c.input.includes("synthetic-admin-only")));
});
