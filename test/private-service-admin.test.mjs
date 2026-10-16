import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { AdminSessions, adminEpoch } from "../dist/admin-session.js";
import { createPrivateServiceAdminRouter } from "../dist/private-service-admin.js";

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); });
const close = (server) => new Promise((resolve) => server.close(resolve));

test("private services are owner-only, explicit-probe, CSRF protected and fixed to approved registry actions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-private-service-admin-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home"); process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "gateway");
  const store = new StateStore();
  await store.init({ adminPassword: "synthetic-admin-only", publicBaseUrl: "http://127.0.0.1:2030/private" });
  const sessions = new AdminSessions(), session = sessions.create(60_000, adminEpoch(await store.load()));
  const revision = (n) => String.fromCharCode(65 + n).repeat(24);
  let current = { revision: revision(0), registry: { version: 1, services: [
    { id: "litellm-ora3", kind: "litellm", label: "LiteLLM on ora3", hostId: "ora3", enabled: true, probe: { status: "unknown", checkedAt: null, aliases: [] } },
    { id: "desktop-loopback", kind: "loopback", label: "Desktop loopback", hostId: "desktop", enabled: true, probe: { status: "unknown", checkedAt: null, aliases: [] } },
  ] } };
  const calls = [];
  const runner = async (command, args, request, input) => {
    calls.push({ command, args, request, input });
    assert.equal(command, "/usr/bin/python3"); assert.deepEqual(args.slice(0, 2), ["-m", "snooze.private_services"]);
    assert.ok(request.timeoutMs <= 10_000); assert.equal(request.cwd, join(root, "supervisor"));
    const op = JSON.parse(input);
    if (op.action === "read") return JSON.stringify(current);
    assert.equal(op.revision, current.revision);
    if (op.action === "add") current.registry.services.push(op.service);
    else if (op.action === "update") current.registry.services[current.registry.services.findIndex((s) => s.id === op.targetId)] = op.service;
    else if (op.action === "remove") current.registry.services = current.registry.services.filter((s) => s.id !== op.targetId);
    else if (op.action === "probe") current.registry.services.find((s) => s.id === op.targetId).probe = { status: "healthy", checkedAt: 1_797_000_000_000, aliases: ["reported-alias"] };
    current.revision = revision(current.revision.charCodeAt(0) - 64); return JSON.stringify(current);
  };
  const app = express();
  app.use("/private", createPrivateServiceAdminRouter(store, sessions, {
    registryPath: join(root, "trusted", "private-services.json"), fleetConfigPath: join(root, "trusted", "fleet.json"),
    supervisorCwd: join(root, "supervisor"), commandRunner: runner,
  }).router);
  const server = createServer(app), address = await listen(server);
  await store.setConfig("publicBaseUrl", `http://127.0.0.1:${address.port}/private`);
  const base = `http://127.0.0.1:${address.port}/private`, cookie = `t2o_admin=${encodeURIComponent(session)}`, csrf = sessions.csrfToken(session);
  const post = (fields, includeCsrf = true) => fetch(`${base}/admin/services`, { method: "POST", redirect: "manual", headers: { cookie, origin: `http://127.0.0.1:${address.port}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, ...(includeCsrf ? { _csrf: csrf } : {}) }) });
  t.after(async () => { await close(server); await rm(root, { recursive: true, force: true }); if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig; });

  assert.equal((await fetch(`${base}/admin/services`, { redirect: "manual" })).status, 302);
  const noAuthCalls = calls.length;
  assert.equal((await post({ action: "add", revision: current.revision }, false)).status, 403); assert.equal(calls.length, noAuthCalls);
  const page = await fetch(`${base}/admin/services`, { headers: { cookie } });
  assert.equal(page.status, 200); const html = await page.text();
  assert.match(html, /inventory of known private gateways/); assert.match(html, /reported aliases/); assert.match(html, /name="_csrf"/);
  assert.equal(calls.length, noAuthCalls + 1); assert.deepEqual(JSON.parse(calls.at(-1).input), { action: "read" });

  let response = await post({ action: "add", revision: current.revision, id: "gateway-four", kind: "litellm", label: "Gateway four", hostId: "ora3", enabled: "1" });
  assert.equal(response.status, 303); assert.equal(JSON.parse(calls.at(-1).input).service.hostId, "ora3");
  const beforeInvalid = calls.length;
  response = await post({ action: "add", revision: current.revision, id: "bad", kind: "litellm", label: "Bad", hostId: "https://attacker.invalid", enabled: "1" });
  assert.equal(response.status, 400); assert.equal(calls.length, beforeInvalid);
  response = await post({ action: "probe", revision: current.revision, targetId: "litellm-ora3", url: "https://attacker.invalid" });
  assert.equal(response.status, 303); assert.deepEqual(JSON.parse(calls.at(-1).input), { action: "probe", revision: current.revision, targetId: "litellm-ora3" });
  assert.ok(calls.every((call) => !call.input.includes("synthetic-admin-only") && !call.input.includes("attacker.invalid")));
});
