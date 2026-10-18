import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { StateStore } from "../dist/store.js";
import { AdminSessions, adminEpoch } from "../dist/admin-session.js";
import { ModelCredentialStore } from "../dist/model-credentials.js";
import { CloudflareAIAdapter, CloudflareCredentialStore } from "../dist/cloudflare-ai.js";
import { createCloudflareRouter } from "../dist/cloudflare-admin.js";

test("Cloudflare account-scoped catalog uses saved credentials without inference and manual selections gate routing", async t => {
  const dir = await mkdtemp(join(tmpdir(), "rx-cf-onboarding-"));
  const prev = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;
  t.after(async () => {
    if (prev === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  const state = new StateStore();
  await state.init({ adminPassword: "synthetic-cf-admin", publicBaseUrl: "http://127.0.0.1" });
  const credentials = new CloudflareCredentialStore(state);
  const one = await credentials.addCredential({ label: "CF One", accountId: "a".repeat(32), token: "synthetic-cf-one-secret", enabled: false });
  const two = await credentials.addCredential({ label: "CF Two", accountId: "b".repeat(32), token: "synthetic-cf-two-secret", enabled: true });
  const calls = [];
  const adapter = new CloudflareAIAdapter(credentials, { fetch: async (url, options) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: options.method });
    assert.equal(options.redirect, "error");
    if (options.method === "GET") {
      assert.equal(options.body, undefined);
      return Response.json({ success: true, result: [{ name: u.pathname.includes("/" + one.accountId + "/") ? "@cf/vendor/first" : "@cf/vendor/second" }] });
    }
    return Response.json({ success: true, result: { response: "synthetic" } });
  } });
  const sessions = new AdminSessions(), session = sessions.create(60000, adminEpoch(await state.load()));
  const gateway = createCloudflareRouter(state, sessions, new ModelCredentialStore(state), adapter);
  const app = express();
  app.use(gateway.router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const cookie = "t2o_admin=" + encodeURIComponent(session), csrf = sessions.csrfToken(session);
  const post = (action, values) => fetch(base + "/admin/cloudflare/" + action, {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, ...values }),
  });
  assert.equal((await post("catalog", { id: one.id })).status, 303);
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /\/ai\/models\/search$/);
  assert.match(calls[0].path, new RegExp(one.accountId));
  assert.deepEqual((await credentials.listCredentials())[0].allowedModels, [], "catalog cannot opt models in");
  let html = await (await fetch(base + "/admin/cloudflare", { headers: { cookie } })).text();
  assert.match(html, /@cf\/vendor\/first/);
  assert.doesNotMatch(html, /@cf\/vendor\/second/);
  assert.match(html, /Select shown/);
  assert.match(html, /manualModels/);
  assert.match(html, /Refresh this account catalog/);
  assert.doesNotMatch(html, /synthetic-cf-one-secret/);
  assert.equal((await post("catalog", { id: two.id })).status, 303);
  html = await (await fetch(base + "/admin/cloudflare", { headers: { cookie } })).text();
  assert.match(html, /@cf\/vendor\/second/);
  assert.equal((await post("update", {
    id: one.id, label: "CF One", accountId: one.accountId, enabled: "1",
    manualModels: "@cf/vendor/manual\n@cf/vendor/first",
  })).status, 303);
  assert.deepEqual((await credentials.listCredentials())[0].allowedModels, ["@cf/vendor/manual", "@cf/vendor/first"]);
  const model = "@cf/vendor/manual";
  assert.equal((await adapter.run({ model, input: { prompt: "synthetic" } })).success, true);
  assert.equal(calls.filter(x => x.method === "POST").length, 1);
  assert.equal((await post("update", { id: one.id, label: "CF One", accountId: one.accountId, enabled: "1" })).status, 303);
  await assert.rejects(adapter.run({ model, input: { prompt: "synthetic" } }), error => error.code === "model_not_allowed");
  assert.equal(calls.filter(x => x.method === "POST").length, 1, "cleared selection blocks route before network");
  assert.equal((await post("update", { id: one.id, label: "CF One", accountId: one.accountId, enabled: "1", manualModels: "garbage id" })).status, 400);
  assert.deepEqual((await credentials.listCredentials())[0].allowedModels, []);
});
