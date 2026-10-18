import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { StateStore } from "../dist/store.js";
import { AdminSessions, adminEpoch } from "../dist/admin-session.js";
import { InferenceProviderStore, OpenAICompatibleInferenceAdapter, validateCustomOrigin } from "../dist/inference-providers.js";
import { fetchProviderModelCatalog } from "../dist/provider-model-catalog.js";
import { createInferenceProviderAdminRouter } from "../dist/inference-provider-admin.js";

test("model-only connection check returns precise redacted failures and never enables inference", async t => {
  const root = await mkdtemp(join(tmpdir(), "rx-onboarding-"));
  const oldDir = process.env.TOKEN2OAUTH_CONFIG_DIR, oldHome = process.env.HOME;
  process.env.TOKEN2OAUTH_CONFIG_DIR = root;
  process.env.HOME = join(root, "home");
  t.after(async () => {
    if (oldDir === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldDir;
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  });
  const store = new StateStore();
  await store.init({ adminPassword: "synthetic-onboarding-admin", publicBaseUrl: "http://127.0.0.1:2930" });
  const sessions = new AdminSessions(), session = sessions.create(60000, adminEpoch(await store.load()));
  const csrf = sessions.csrfToken(session);
  let mode = "ok", requests = 0, lastPath;
  const admin = createInferenceProviderAdminRouter(store, sessions, { fetch: async (url, init) => {
    requests++;
    lastPath = new URL(url).pathname;
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.match(init.headers.authorization, /^Bearer synthetic-/);
    if (mode === "offline") throw Error("synthetic-private-host-socket-error-and-token");
    if (mode === "bad-auth") return Response.json({ error: "synthetic private upstream secret" }, { status: 401 });
    if (mode === "missing") return Response.json({}, { status: 404 });
    if (mode === "broken") return Response.json({ nope: true });
    if (mode === "empty") return Response.json({ data: [] });
    return Response.json({ data: [{ id: "allowed/chat", name: "Chat" }, { id: "not valid" }] });
  } });
  const app = express();
  app.use(admin.router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const cookie = "t2o_admin=" + encodeURIComponent(session);
  const post = (action, fields, authorized = true) => fetch(base + "/admin/inference/" + action, {
    method: "POST", redirect: "manual", headers: {
      "content-type": "application/x-www-form-urlencoded", ...(authorized ? { cookie } : {}),
    }, body: new URLSearchParams(fields),
  });
  assert.equal((await post("connection", { id: "missing_123", _csrf: csrf }, false)).status, 302);
  assert.equal((await post("connection", { id: "missing_123" })).status, 403);
  assert.equal((await post("custom-add", { _csrf: csrf, label: "Vendor", origin: "https://api.vendor.example/v1" })).status, 303);
  const provider = (await admin.accounts.listCustomProviders())[0];
  assert.equal((await post("add", { _csrf: csrf, provider: provider.id, label: "Vendor account", token: "synthetic-vendor-token", models: "allowed/chat" })).status, 303);
  const account = (await admin.accounts.listAccounts())[0];
  assert.deepEqual(account.allowedModels, ["allowed/chat"]);
  const check = await post("connection", { _csrf: csrf, id: account.id });
  assert.equal(check.status, 200);
  assert.deepEqual(Object.keys(await check.json()).sort(), ["checkedAt", "inferenceVerified", "modelCount", "ok"]);
  assert.equal(lastPath, "/v1/models");
  assert.equal(requests, 1);
  mode = "empty";
  const empty = await post("catalog", { _csrf: csrf, id: account.id });
  assert.equal((await empty.json()).models.length, 0);
  assert.deepEqual((await admin.accounts.listAccounts())[0].allowedModels, ["allowed/chat"]);
  for (const [next, code] of [["bad-auth", "authentication_rejected"], ["missing", "models_endpoint_missing"], ["broken", "catalog_invalid"], ["offline", "catalog_unavailable"]]) {
    mode = next;
    const res = await post("connection", { _csrf: csrf, id: account.id });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.equal(JSON.parse(body).error, code);
    assert.doesNotMatch(body, /synthetic-|private-host|token/i);
  }
  const html = await (await fetch(base + "/admin/inference", { headers: { cookie } })).text();
  assert.match(html, /data-test-connection/);
  assert.match(html, /Clear entire allowlist/);
  assert.match(html, /unverified until tested/);
  assert.doesNotMatch(html, /synthetic-vendor-token/);
  assert.equal((await post("update", { _csrf: csrf, id: account.id, label: "Vendor account", models: "", enabled: "1" })).status, 303);
  assert.deepEqual((await admin.accounts.listAccounts())[0].allowedModels, []);
  const adapter = new OpenAICompatibleInferenceAdapter(admin.accounts, { publicFetch: async () => { requests++; return Response.json({ choices: [] }); } });
  await assert.rejects(adapter.complete({ provider: provider.id, model: "allowed/chat", body: { messages: [] } }), error => error.code === "model_not_allowed");
  const before = requests;
  assert.equal(requests, before);
  assert.equal((await post("custom-update", { _csrf: csrf, id: provider.id, label: "Vendor", origin: "https://different.vendor.example/v1" })).status, 303);
  assert.equal((await post("connection", { _csrf: csrf, id: account.id }).then(r => r.json())).error, "credential_replacement_required");
  assert.equal((await post("update", { _csrf: csrf, id: account.id, label: "Vendor account", models: "allowed/chat", enabled: "1", token: "synthetic-new-token" })).status, 303);
  mode = "ok";
  assert.equal((await post("connection", { _csrf: csrf, id: account.id })).status, 200);
  assert.equal((await post("custom-remove", { _csrf: csrf, id: provider.id })).status, 400, "referenced provider cannot be removed");
  assert.equal((await post("remove", { _csrf: csrf, id: account.id })).status, 303);
  assert.equal((await post("custom-remove", { _csrf: csrf, id: provider.id })).status, 303);
});

test("custom endpoint policy rejects local/private URL tricks before credentials are stored", () => {
  for (const value of ["http://api.example.com/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://10.1.2.3/v1",
    "https://[::1]/v1", "https://host.internal/v1", "https://user:pass@api.example.com/v1",
    "https://api.example.com:8443/v1", "https://api.example.com/v1?token=x", "https://api.example.com/v1#fragment"]) {
    assert.throws(() => validateCustomOrigin(value), /invalid/, value);
  }
  assert.equal(validateCustomOrigin("https://api.example.com/v1/"), "https://api.example.com/v1");
});

test("model-list discovery never implies enabled state or protocol correctness", async () => {
  const account = { id: "account_123456", provider: "openai", enabled: false, allowedModels: [] };
  const accounts = { credentialForRequest: async () => ({ view: account, token: "synthetic-secret", origin: "https://api.openai.com/v1" }) };
  await assert.rejects(fetchProviderModelCatalog(accounts, account.id, { fetch: async () => { throw Error("must not fetch"); } }), /account_disabled/);
  const rows = await fetchProviderModelCatalog(accounts, account.id, { allowDisabled: true, fetch: async () => Response.json({ data: [{ id: "name/unknown" }] }) });
  assert.equal(rows[0].free, null, "unknown pricing never implies free");
  assert.deepEqual(account.allowedModels, [], "discovery cannot mutate saved routing policy");
});
