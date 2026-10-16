import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { AdminSessions, adminEpoch } from "../dist/admin-session.js";
import { createResourceRoutingAdminRouter } from "../dist/resource-routing-admin.js";
import { CloudflareAIAdapter, CloudflareCredentialStore } from "../dist/cloudflare-ai.js";
import { createModelGateway } from "../dist/model-gateway.js";

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); });
const close = (server) => new Promise((resolve) => server.listening ? server.close(resolve) : resolve());

test("routing editor enforces admin CSRF and rules alter real Cloudflare/Ollama selection without exceeding hard caps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-routing-controls-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home"); process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  const store = new StateStore(); // Environment is isolated before state construction.
  await store.init({ adminPassword: "synthetic-routing-admin-password" });
  const sessions = new AdminSessions(), state = await store.load(), session = sessions.create(60_000, adminEpoch(state));
  const app = express();
  app.use(createResourceRoutingAdminRouter(store, sessions).router);
  const server = createServer(app), address = await listen(server), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await close(server); await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });
  const cookie = `t2o_admin=${encodeURIComponent(session)}`;
  const csrf = sessions.csrfToken(session);
  assert.equal((await fetch(base + "/admin/routing", { redirect: "manual" })).status, 302, "page requires an admin session");
  const page = await fetch(base + "/admin/routing", { headers: { cookie } });
  assert.equal(page.status, 200); const pageHtml = await page.text(); assert.match(pageHtml, /planner metadata only/); assert.match(pageHtml, /exact model IDs/);
  const submit = (rules, token = csrf) => fetch(base + "/admin/routing", { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ _csrf: token ?? "", rules }) });
  assert.equal((await submit("{}", "")).status, 403, "POST requires synchronizer CSRF");
  assert.equal((await submit("{bad json")).status, 400, "invalid documents do not persist");

  const cloudCredentials = new CloudflareCredentialStore(store);
  const model = "@cf/meta/llama-3.1-8b-instruct";
  const otherCfModel = "@cf/meta/llama-3.1-8b-instruct-fast";
  const cfA = await cloudCredentials.addCredential({ label: "CF account A", accountId: "a".repeat(32), token: "synthetic-cf-key-aaaa", allowedModels: [model] });
  const cfB = await cloudCredentials.addCredential({ label: "CF account B", accountId: "b".repeat(32), token: "synthetic-cf-key-bbbb", allowedModels: [model, otherCfModel] });
  const cfCalls = [];
  let holdCf = false, releaseCf;
  const cfAdapter = new CloudflareAIAdapter(cloudCredentials, { maxInflightPerAccount: 1, fetch: async (_url, init) => {
    cfCalls.push(init.headers.authorization);
    if (holdCf) await new Promise((resolve) => { releaseCf = resolve; });
    return Response.json({ success: true, result: { response: "ok" } });
  } });
  await cfAdapter.run({ model, input: { prompt: "before 1" } }); await cfAdapter.run({ model, input: { prompt: "before 2" } });
  assert.deepEqual(cfCalls.slice(0, 2), ["Bearer synthetic-cf-key-aaaa", "Bearer synthetic-cf-key-bbbb"], "no rules retain round robin");

  const gateway = createModelGateway(store, { maxInflightPerAccount: 1, fetch: async (_url, init) => {
    if (holdOllama) await new Promise((resolve) => { releaseOllama = resolve; });
    ollamaCalls.push(init.headers.authorization);
    return Response.json({ object: "list", data: [] });
  } });
  const modelA = await gateway.credentials.addCredential("Ollama A", "synthetic-ollama-key-aaaa");
  const modelB = await gateway.credentials.addCredential("Ollama B", "synthetic-ollama-key-bbbb");
  const readToken = await gateway.credentials.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const invokeToken = await gateway.credentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  app.use(gateway.router);
  const ollamaCalls = [];
  let holdOllama = false, releaseOllama;
  const getModels = () => fetch(base + "/v1/models", { headers: { authorization: `Bearer ${readToken.token}` } });
  const invokeModel = (requestedModel) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${invokeToken.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: requestedModel, messages: [{ role: "user", content: "synthetic" }] }) });
  assert.equal((await getModels()).status, 200); assert.equal((await getModels()).status, 200);
  assert.deepEqual(ollamaCalls.slice(0, 2), ["Bearer synthetic-ollama-key-aaaa", "Bearer synthetic-ollama-key-bbbb"], "Ollama no-rule behavior remains round robin");
  assert.equal((await invokeModel("gpt-oss:20b")).status, 200, "absent allowedModels preserves current inference behavior");

  const rules = { version: 1, unknownCapacity: 1, providerCaps: { inference: 9 }, resources: {
    [cfA.id]: { enabled: true, weight: 1, allowedModels: [otherCfModel] }, [cfB.id]: { enabled: true, weight: 3, capacity: 99, allowedModels: [model] },
    [modelA.id]: { enabled: true, weight: 1, allowedModels: [] }, [modelB.id]: { enabled: true, weight: 3, capacity: 99, allowedModels: ["gpt-oss:20b"] },
  } };
  const saved = await submit(JSON.stringify(rules));
  assert.equal(saved.status, 303, await saved.text());
  const wildcardRules = { version: 1, resources: { [cfA.id]: { allowedModels: ["*"] } } };
  assert.equal((await submit(JSON.stringify(wildcardRules))).status, 400, "wildcard model policy is rejected");
  await cfAdapter.run({ model, input: { prompt: "after" } });
  assert.equal(cfCalls.at(-1), "Bearer synthetic-cf-key-bbbb", "Cloudflare honors exact account model rule");
  const beforeDeniedCf = cfCalls.length;
  await assert.rejects(cfAdapter.run({ model: otherCfModel, input: { prompt: "policy deny" } }), (error) => error.code === "model_not_allowed");
  assert.equal(cfCalls.length, beforeDeniedCf, "routing rules intersect, and cannot broaden, the credential allowlist");
  holdCf = true;
  const heldCf = cfAdapter.run({ model, input: { prompt: "held" } });
  for (let i = 0; i < 100 && !releaseCf; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(releaseCf, "Cloudflare request reached fake provider");
  await assert.rejects(cfAdapter.run({ model, input: { prompt: "over cap" } }), (error) => error.code === "no_eligible_account");
  releaseCf(); holdCf = false; await heldCf;

  assert.equal((await getModels()).status, 200, "model catalog requests remain available despite inference model filters");
  const allowedOllama = await invokeModel("gpt-oss:20b");
  assert.equal(allowedOllama.status, 200);
  assert.equal(ollamaCalls.at(-1), "Bearer synthetic-ollama-key-bbbb", "Ollama skips account with explicit empty model list");
  const beforeDeniedOllama = ollamaCalls.length;
  assert.equal((await invokeModel("gpt-oss:20b-extra")).status, 503, "Ollama model match is exact");
  assert.equal(ollamaCalls.length, beforeDeniedOllama, "Ollama model mismatch is rejected before provider I/O");
  holdOllama = true;
  const heldOllama = invokeModel("gpt-oss:20b");
  for (let i = 0; i < 100 && !releaseOllama; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(releaseOllama, "Ollama request reached fake provider");
  const overCap = await invokeModel("gpt-oss:20b");
  assert.equal(overCap.status, 503, "configured capacity 99 cannot raise the adapter hard cap of one");
  releaseOllama(); holdOllama = false; assert.equal((await heldOllama).status, 200);

  const weightedRules = { version: 1, unknownCapacity: 1, providerCaps: {}, resources: {
    [cfA.id]: { enabled: true, weight: 3 }, [cfB.id]: { enabled: true, weight: 1 },
    [modelA.id]: { enabled: true, weight: 3 }, [modelB.id]: { enabled: true, weight: 1 },
  } };
  assert.equal((await submit(JSON.stringify(weightedRules))).status, 303);
  assert.equal((await invokeModel("gpt-oss:unlisted")).status, 200, "omitting allowedModels on a rule preserves provider behavior");
  const cfStart = cfCalls.length, ollamaStart = ollamaCalls.length;
  for (let i = 0; i < 40; i++) { await cfAdapter.run({ model, input: { prompt: "weighted" } }); await getModels(); }
  const countA = (list, start, key) => list.slice(start).filter((value) => value === key).length;
  const cfAWeight = countA(cfCalls, cfStart, "Bearer synthetic-cf-key-aaaa");
  const ollamaAWeight = countA(ollamaCalls, ollamaStart, "Bearer synthetic-ollama-key-aaaa");
  assert.ok(cfAWeight >= 28 && cfAWeight <= 32, `Cloudflare weight 3:1 share was ${cfAWeight}/40`);
  assert.ok(ollamaAWeight >= 28 && ollamaAWeight <= 32, `Ollama weight 3:1 share was ${ollamaAWeight}/40`);
});
