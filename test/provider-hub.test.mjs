import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { AdminSessions, adminEpoch } from "../dist/admin-session.js";
import { InferenceProviderStore } from "../dist/inference-providers.js";
import { CloudflareCredentialStore } from "../dist/cloudflare-ai.js";
import { ModelCredentialStore } from "../dist/model-credentials.js";
import { createProviderHubRouter } from "../dist/provider-hub.js";

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); });
const close = (server) => new Promise((resolve) => server.close(resolve));

test("provider hub is admin-only, lists safe store views, and links to mounted account forms", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-provider-hub-"));
  const previousHome = process.env.HOME, previousConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = previousConfig;
    await rm(root, { recursive: true, force: true });
  });
  const store = new StateStore();
  await store.init({ adminPassword: "test-only", publicBaseUrl: "https://rotoxy.example/token2oauth" });
  await new InferenceProviderStore(store).addAccount({ provider: "openai", label: '<img src=x onerror="alert(1)">', token: "synthetic-test-openai-token", allowedModels: [] });
  await new CloudflareCredentialStore(store).addCredential({ label: "Cloudflare test", accountId: "0123456789abcdef0123456789abcdef", token: "synthetic-test-cloudflare-token" });
  await new ModelCredentialStore(store).addCredential("Ollama test", "synthetic-test-ollama-token");

  const sessions = new AdminSessions(), app = express();
  app.use(createProviderHubRouter(store, sessions));
  const server = createServer(app), address = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${address.port}`;

  const anonymous = await fetch(`${base}/admin/providers`, { redirect: "manual" });
  assert.equal(anonymous.status, 302);
  assert.match(anonymous.headers.get("location"), /^\/token2oauth\/admin\/login\?next=/);

  const session = sessions.create(60_000, adminEpoch(await store.load()));
  const response = await fetch(`${base}/admin/providers`, { headers: { cookie: `t2o_admin=${session}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await response.text();
  for (const href of ["/token2oauth/admin/inference", "/token2oauth/admin/cloudflare", "/token2oauth/admin/models", "/token2oauth/admin#accounts", "/token2oauth/admin/codex", "/token2oauth/admin/oracle"]) assert.ok(html.includes(`href="${href}"`), href);
  assert.match(html, /OpenAI-compatible providers/);
  assert.match(html, /OpenCode is an agent client/);
  assert.match(html, /Hermes is an agent\/client setup/);
  assert.match(html, /Manual setup/);
  assert.match(html, /Configuration/);
  assert.match(html, /No provider was contacted/);
  assert.match(html, /href="https:\/\/code\.claude\.com\/docs\/en\/mcp"/);
  assert.match(html, /href="https:\/\/opencode\.ai\/docs\/agents\/"/);
  assert.match(html, /href="https:\/\/hermesagent\.nousresearch\.com\/"/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x|synthetic-test-(?:openai|cloudflare|ollama)-token/);
  assert.match(html, /name="_csrf"/);
  assert.match(html, /<strong>1<\/strong><span>stored account/);
});
