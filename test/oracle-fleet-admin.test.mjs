import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { AdminSessions, adminEpoch } from "../dist/admin-session.js";
import { createOracleFleetAdminRouter } from "../dist/oracle-fleet-admin.js";

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); });
const close = (server) => new Promise((resolve) => server.close(resolve));
const hosts = [
  { id: "ora1", ip: "100.65.151.42", ssh_host: "shh-ora1.ziopsyop.tech", enabled: true, allowedModels: ["qwen3.5:9b", "tev1:0.8b", "gpt-oss:20b"] },
  { id: "ora3", ip: "100.114.191.111", ssh_host: "shh-ora3.ziopsyop.tech", enabled: true, allowedModels: ["qwen3.5:9b", "tev1:0.8b", "gpt-oss:20b"] },
  { id: "ora5", ip: "100.112.7.115", ssh_host: "shh-ora5.ziopsyop.tech", enabled: true, allowedModels: ["qwen3.5:9b", "tev1:0.8b", "gpt-oss:20b"] },
];

test("Oracle fleet admin authenticates, checks origin/CSRF and exposes only the trusted host config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-oracle-fleet-admin-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home"); process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "gateway");
  const store = new StateStore();
  await store.init({ adminPassword: "synthetic-admin-only", publicBaseUrl: "http://127.0.0.1:2030/token2oauth" });
  const sessions = new AdminSessions();
  const session = sessions.create(60_000, adminEpoch(await store.load()));
  let current = { revision: "A".repeat(24), version: 1, default_model: "qwen3.5:9b", hosts: structuredClone(hosts) };
  const calls = [];
  const runner = async (command, args, request, input) => {
    calls.push({ command, args, request, input });
    assert.equal(command, "/usr/bin/python3");
    assert.deepEqual(args.slice(0, 2), ["-m", "snooze.oracle_fleet_config"]);
    assert.equal(args[2], "--config");
    assert.equal(args[3], join(root, "trusted-oracle", "config.json"));
    const payload = JSON.parse(input);
    if (payload.action === "read") return JSON.stringify(current);
    assert.equal(payload.revision, current.revision);
    if (payload.action === "add") current.hosts.push(payload.host);
    else if (payload.action === "update") current.hosts[current.hosts.findIndex((host) => host.id === payload.targetId)] = payload.host;
    else if (payload.action === "remove") current.hosts = current.hosts.filter((host) => host.id !== payload.targetId);
    current.version = 2; current.revision = String.fromCharCode(current.revision.charCodeAt(0) + 1).repeat(24);
    return JSON.stringify(current);
  };
  const app = express();
  app.use("/token2oauth", createOracleFleetAdminRouter(store, sessions, {
    configPath: join(root, "trusted-oracle", "config.json"), supervisorCwd: join(root, "supervisor"), commandRunner: runner,
  }).router);
  const server = createServer(app);
  const address = await listen(server);
  await store.setConfig("publicBaseUrl", `http://127.0.0.1:${address.port}/token2oauth`);
  const base = `http://127.0.0.1:${address.port}/token2oauth`;
  const cookie = `t2o_admin=${encodeURIComponent(session)}`;
  const csrf = sessions.csrfToken(session);
  const post = (fields, { origin = `http://127.0.0.1:${address.port}`, includeCsrf = true } = {}) => fetch(`${base}/admin/oracle/fleet`, {
    method: "POST", redirect: "manual", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, ...(includeCsrf ? { _csrf: csrf } : {}) }),
  });
  t.after(async () => {
    await close(server); await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });

  const denied = await fetch(`${base}/admin/oracle/fleet`, { redirect: "manual" });
  assert.equal(denied.status, 302);
  const unauthorizedCalls = calls.length;
  const missingCsrf = await post({ action: "add", revision: current.revision, id: "ora7", ip: "100.68.1.7", ssh_host: "shh-ora7.test", enabled: "1", allowedModels: "qwen3.5:9b" }, { includeCsrf: false });
  assert.equal(missingCsrf.status, 403); assert.equal(calls.length, unauthorizedCalls);
  const wrongOrigin = await post({ action: "add", revision: current.revision }, { origin: "https://attacker.invalid" });
  assert.equal(wrongOrigin.status, 403); assert.equal(calls.length, unauthorizedCalls);

  const page = await fetch(`${base}/admin/oracle/fleet`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Configured hosts/); assert.match(html, /Changes apply after the pool restarts/);
  assert.match(html, /installation is not checked/); assert.match(html, /name="_csrf"/);
  assert.match(html, /\/token2oauth\/admin\/oracle\/fleet/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(calls.at(-1).input, JSON.stringify({ action: "read" }));

  let response = await post({ action: "add", revision: current.revision, id: "ora7", ip: "100.68.1.7", ssh_host: "shh-ora7.ziopsyop.tech", enabled: "1", allowedModels: "qwen3.5:9b" });
  assert.equal(response.status, 303);
  assert.equal(JSON.parse(calls.at(-1).input).action, "add");
  response = await post({ action: "update", revision: current.revision, targetId: "ora7", id: "ora8", ip: "100.69.1.8", ssh_host: "shh-ora8.ziopsyop.tech", enabled: "1", allowedModels: "gpt-oss:20b" });
  assert.equal(response.status, 303); assert.equal(JSON.parse(calls.at(-1).input).host.id, "ora8");
  response = await post({ action: "remove", revision: current.revision, targetId: "ora8" });
  assert.equal(response.status, 303); assert.equal(JSON.parse(calls.at(-1).input).action, "remove");
  assert.equal(calls.every((call) => !call.input.includes("synthetic-admin-only")), true);
});
