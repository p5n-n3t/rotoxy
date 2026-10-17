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

test("Oracle model page uses CSRF and epoch-fenced explicit apply controls", async (t) => {
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
    apply: { mode: "previewOnly", blockedReason: "Readiness check is read-only; no apply request was made." },
    applyStatus: { daemon: { available: true, instanceId: "worker-1", loadedRevision: "older-revision", heartbeatAt: 1_797_000_000, observedEpoch: 8, alive: true }, operation: null, maintenance: null, ready: true, reason: null },
    maintenance: { epoch: 7, paused: true, configRevision, acknowledged: false, blockers: { running: 1, ambiguous: 0, dispatching: 0 }, reason: "draining" } };
  const calls = [];
  let failApply = false;
  const runner = async (command, args, request, input) => {
    calls.push({ command, args, request, input });
    assert.equal(command, "/usr/bin/python3"); assert.deepEqual(args.slice(0, 2), ["-m", "snooze.oracle_model_admin"]);
    assert.equal(request.cwd, join(root, "supervisor")); assert.equal(request.timeoutMs, 40_000);
    const parsed = JSON.parse(input);
    if (parsed.action === "apply-config" && failApply) return JSON.stringify({ error: "apply_not_ready" });
    if (parsed.action === "apply-config") {
      view.applyStatus.daemon.loadedRevision = configRevision;
      view.applyStatus.operation = { applyId: "apply-done", epoch: 9, targetRevision: configRevision, previousInstance: "worker-1", status: "complete", error: null };
    }
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
  assert.match(html, /Installed model names come from the last explicit/); assert.match(html, /Paused; draining/); assert.match(html, /Pause prevents new claims/); assert.match(html, /without applying changes/); assert.match(html, /Readiness check is read-only/); assert.match(html, /Apply this configuration/); assert.match(html, /older-revision/); assert.match(html, /process identity alive/); assert.match(html, /last heartbeat timestamp/); assert.match(html, /worker-1/); assert.match(html, /Pause dispatch and drain/); assert.match(html, /Abort maintenance and resume dispatch/); assert.match(html, /epoch 7/); assert.match(html, /name="_csrf"/);
  assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0].input), { action: "read" });
  view.applyStatus.ready = false; view.applyStatus.reason = "apply_prepared"; view.applyStatus.operation = { applyId: "apply-1", epoch: 8, targetRevision: configRevision, previousInstance: "worker-1", status: "prepared", error: null };
  const fencedHtml = await (await fetch(`${base}/admin/oracle/models`, { headers: { cookie } })).text();
  assert.match(fencedHtml, /apply_prepared/); assert.match(fencedHtml, /Resume is disabled while apply reservation state is unavailable or prepared\/failed/);
  assert.match(fencedHtml, /name="action" value="apply-config"[\s\S]*?<button disabled>Apply this configuration/);
  view.applyStatus.ready = true; view.applyStatus.reason = null; view.applyStatus.operation = null;
  const badOrigin = await post({ action: "refresh", revision }, { origin: "https://attacker.invalid" });
  assert.equal(badOrigin.status, 403); assert.equal(calls.length, 2);
  const refreshed = await post({ action: "refresh", revision });
  assert.equal(refreshed.status, 303);
  assert.deepEqual(JSON.parse(calls.at(-1).input), { action: "refresh", expectedCacheRevision: revision });
  const preview = await post({ action: "apply", revision: configRevision });
  assert.equal(preview.status, 303); assert.deepEqual(JSON.parse(calls.at(-1).input), { action: "apply", expectedConfigRevision: configRevision });
  const applied = await post({ action: "apply-config", revision: configRevision, epoch: "8" });
  assert.equal(applied.status, 303); assert.deepEqual(JSON.parse(calls.at(-1).input), { action: "apply-config", expectedConfigRevision: configRevision, expectedEpoch: 8 });
  assert.match(applied.headers.get("location"), /applyProcessed=1/);
  const afterApply = await (await fetch(new URL(applied.headers.get("location"), base), { headers: { cookie } })).text();
  assert.match(afterApply, /Apply request processed; inspect the current operation and daemon status below/); assert.match(afterApply, /apply-done · complete/); assert.doesNotMatch(afterApply, /changes remain preview-only/);
  assert.match(afterApply, /name="action" value="apply-config"[\s\S]*?<button>Apply this configuration/);
  assert.match(afterApply, /name="action" value="maintenance-release"[\s\S]*?<button class="secondary">Abort maintenance/);
  failApply = true;
  const failedApply = await post({ action: "apply-config", revision: configRevision, epoch: "8" });
  assert.equal(failedApply.status, 400); assert.equal(await failedApply.text(), "apply_not_ready");
  failApply = false;
  view.applyStatus.operation = { applyId: "apply-failed", epoch: 9, targetRevision: configRevision, previousInstance: "worker-1", status: "failed", error: "restart_uncertain" };
  view.applyStatus.ready = true; view.applyStatus.reason = "reconcile_ready";
  const reconcileHtml = await (await fetch(`${base}/admin/oracle/models`, { headers: { cookie } })).text();
  assert.match(reconcileHtml, /Reconcile previous apply/); assert.doesNotMatch(reconcileHtml, /name="action" value="apply-config"[\s\S]*?<button disabled>Reconcile previous apply/);
  const pause = await post({ action: "maintenance-request", revision: configRevision, epoch: "7" });
  assert.equal(pause.status, 303); assert.deepEqual(JSON.parse(calls.at(-1).input), { action: "maintenance-request", expectedConfigRevision: configRevision, expectedEpoch: 7 });
  const resume = await post({ action: "maintenance-release", revision: configRevision, epoch: "8" });
  assert.equal(resume.status, 303); assert.deepEqual(JSON.parse(calls.at(-1).input), { action: "maintenance-release", expectedConfigRevision: configRevision, expectedEpoch: 8 });
  const invalid = await post({ action: "exec", command: "/usr/bin/systemctl restart", revision });
  assert.equal(invalid.status, 400); assert.equal(calls.length, 10);
  assert.ok(calls.every((c) => !c.input.includes("systemctl") && !c.input.includes("synthetic-admin-only")));
});
