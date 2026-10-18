import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

test("profile admin controls enforce session and CSRF, scope removals, and keep Ollama secrets private", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-profile-ui-"));
  const priorHome = process.env.HOME;
  const priorConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  await mkdir(process.env.HOME, { recursive: true, mode: 0o700 });

  let server;
  let codex;
  try {
    const [{ StateStore }, { AdminSessions, adminEpoch }, { ModelCredentialStore }, { CodexProfiles }, { createControlPlaneAdminRouter }] = await Promise.all([
      import("../dist/store.js"), import("../dist/admin-session.js"), import("../dist/model-credentials.js"),
      import("../dist/codex-profiles.js"), import("../dist/control-plane-admin.js"),
    ]);
    const store = new StateStore();
    await store.init({ adminPassword: "synthetic-admin-password", publicBaseUrl: "http://localhost/t2o" });
    const sessions = new AdminSessions();
    const session = sessions.create(60_000, adminEpoch(await store.load()));
    const csrf = sessions.csrfToken(session);
    const models = new ModelCredentialStore(store);
    const removed = await models.addCredential("Synthetic remove", "synthetic-ollama-secret-remove");
    const survivor = await models.addCredential("Synthetic survivor", "synthetic-ollama-secret-survive");
    const codexBin = join(root, "codex");
    await writeFile(codexBin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(codexBin, 0o700);
    codex = new CodexProfiles({ codexBinary: codexBin, configDir: store.dir });
    const profile = await codex.registerProfile("Synthetic profile");
    const sibling = await codex.registerProfile("Synthetic sibling");

    const app = express();
    app.use(createControlPlaneAdminRouter(store, sessions, models, root, codex));
    app.use("/without-adapter", createControlPlaneAdminRouter(store, sessions, models, root));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookie = `t2o_admin=${session}`;
    const post = (path, fields, authenticated = true) => fetch(base + path, {
      method: "POST", redirect: "manual",
      headers: { ...(authenticated ? { cookie } : {}), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });

    assert.equal((await fetch(base + "/admin/models", { redirect: "manual" })).status, 302);
    assert.equal((await fetch(base + "/admin/codex", { redirect: "manual" })).status, 302);
    assert.equal((await post("/admin/models/remove", { id: removed.id }, false)).status, 302);
    assert.equal((await post("/admin/models/remove", { id: removed.id })).status, 403);
    assert.equal((await post("/admin/codex/action", { action: "remove", id: profile.id })).status, 403);

    const modelsHtml = await (await fetch(base + "/admin/models", { headers: { cookie } })).text();
    assert.match(modelsHtml, /\/t2o\/admin\/cloudflare/);
    assert.match(modelsHtml, /\/t2o\/admin\/models\/remove/);
    assert.doesNotMatch(modelsHtml, /synthetic-ollama-secret/);
    assert.equal((await readFile(join(store.dir, "model-credentials.json"), "utf8")).includes("synthetic-ollama-secret"), false);

    assert.equal((await post("/admin/models/remove", { _csrf: csrf, id: "unknown-model-id" })).status, 400);
    assert.equal((await post("/admin/models/remove", { _csrf: csrf, id: removed.id })).status, 303);
    assert.deepEqual((await models.listCredentials()).map((account) => account.id), [survivor.id]);
    assert.equal((await models.credentialForRequest(removed.id)), undefined);
    assert.equal((await models.credentialForRequest(survivor.id)).apiKey, "synthetic-ollama-secret-survive");

    const codexHtml = await (await fetch(base + "/admin/codex", { headers: { cookie } })).text();
    assert.match(codexHtml, /<title>ChatGPT &amp; Codex accounts · ROTOXY<\/title>/);
    assert.match(codexHtml, /<h1>ChatGPT &amp; Codex accounts<\/h1>/);
    assert.match(codexHtml, /ChatGPT &amp; Codex<\/a>/);
    assert.equal((codexHtml.match(/href="\/t2o\/admin\/codex"/g) || []).length, 2, "each responsive navigation renders one Codex route");
    assert.match(codexHtml, /Start ChatGPT device-code sign-in/);
    assert.match(codexHtml, /learn\.chatgpt\.com\/docs\/app-server#auth-endpoints/);
    assert.match(codexHtml, /developers\.openai\.com\/siwc/);
    assert.match(codexHtml, /does not start work, select an account, or promise available plan capacity/);
    assert.match(codexHtml, /No Claude account provider is implemented/);
    assert.match(codexHtml, /action="\/t2o\/admin\/codex\/action"/);
    assert.match(codexHtml, /name="action" value="rename"/);
    assert.match(codexHtml, /name="action" value="remove"/);
    const emptyCodexHtml = await (await fetch(base + "/without-adapter/admin/codex", { headers: { cookie } })).text();
    assert.match(emptyCodexHtml, /Local Codex adapter unavailable/);
    assert.match(emptyCodexHtml, /ROTOXY_CODEX_BINARY/);
    assert.match(emptyCodexHtml, /https:\/\/developers\.openai\.com\/siwc/);
    assert.equal((await post("/admin/codex/action", { _csrf: csrf, action: "rename", id: profile.id, label: "Renamed profile" })).status, 303);
    assert.equal((await codex.listProfiles()).find((entry) => entry.id === profile.id).label, "Renamed profile");
    assert.equal((await post("/admin/codex/action", { _csrf: csrf, action: "remove", id: "not-a-profile" })).status, 400);
    assert.equal((await post("/admin/codex/action", { _csrf: csrf, action: "remove", id: profile.id })).status, 303);
    assert.deepEqual((await codex.listProfiles()).map((entry) => entry.id), [sibling.id]);
    assert.equal((await stat(join(root, "config", "codex-profiles", profile.id))).isDirectory(), true, "removal retains CODEX_HOME");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (codex) await codex.close();
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = priorConfig;
    await rm(root, { recursive: true, force: true });
  }
});
