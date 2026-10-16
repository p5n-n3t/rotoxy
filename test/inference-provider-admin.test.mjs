import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { AdminSessions, adminEpoch } from "../dist/admin-session.js";
import { createInferenceProviderAdminRouter } from "../dist/inference-provider-admin.js";

test("inference account page requires admin session and CSRF, and never returns stored API tokens", async t => {
  const root = await mkdtemp(join(tmpdir(), "t2o-inference-admin-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  const store = new StateStore();
  await store.init({ adminPassword: "synthetic-only-admin-password", publicBaseUrl: "http://127.0.0.1:2030/token2oauth" });
  const sessions = new AdminSessions();
  const session = sessions.create(60_000, adminEpoch(await store.load()));
  const csrf = sessions.csrfToken(session);
  const admin = createInferenceProviderAdminRouter(store, sessions);
  const app = (await import("express")).default();
  app.use("/token2oauth", admin.router);
  const server = createServer(app);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `t2o_admin=${encodeURIComponent(session)}`;
  const post = (action, fields, withCsrf = true) => fetch(`${base}/token2oauth/admin/inference/${action}`, {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, ...(withCsrf ? { _csrf: csrf } : {}) }),
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });

  const unauthorized = await fetch(`${base}/token2oauth/admin/inference`, { redirect: "manual" });
  assert.equal(unauthorized.status, 302);
  assert.match(unauthorized.headers.get("location"), /admin\/login/);
  const deniedPost = await post("add", { provider: "openai", label: "Denied", token: "synthetic-openai-token", models: "gpt-4.1-mini" }, false);
  assert.equal(deniedPost.status, 403);
  assert.equal((await admin.accounts.listAccounts()).length, 0);

  const added = await post("add", { provider: "openrouter", label: "Primary OpenRouter", token: "synthetic-openrouter-token", models: "anthropic/claude-3.7-sonnet" });
  assert.equal(added.status, 303);
  const account = (await admin.accounts.listAccounts())[0];
  assert.equal(account.provider, "openrouter");
  const page = await fetch(`${base}/token2oauth/admin/inference`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Primary OpenRouter/);
  assert.match(html, /name="_csrf"/);
  assert.doesNotMatch(html, /synthetic-openrouter-token/);

  const custom = await post("custom-add", { label: "Vendor API", origin: "https://api.vendor.example" });
  assert.equal(custom.status, 303);
  const customProvider = (await admin.accounts.listCustomProviders())[0];
  assert.match((await (await fetch(`${base}/token2oauth/admin/inference`, { headers: { cookie } })).text()), /Vendor API/);
  const customAccount = await post("add", { provider: customProvider.id, label: "Vendor account", token: "synthetic-vendor-secret", models: "vendor-model" });
  assert.equal(customAccount.status, 303);
  const customPage = await fetch(`${base}/token2oauth/admin/inference`, { headers: { cookie } });
  assert.doesNotMatch(await customPage.text(), /synthetic-vendor-secret/);

  const update = await post("update", { id: account.id, label: "Primary OpenRouter", models: "", enabled: "1" });
  assert.equal(update.status, 303);
  assert.deepEqual((await admin.accounts.listAccounts())[0].allowedModels, [], "empty model allowlist is persisted and denies inference");
  const customEntry = (await admin.accounts.listAccounts()).find(x => x.provider === customProvider.id);
  await post("remove", { id: customEntry.id });
  await post("custom-remove", { id: customProvider.id });
  const removed = await post("remove", { id: account.id });
  assert.equal(removed.status, 303);
  assert.equal((await admin.accounts.listAccounts()).length, 0);
});
