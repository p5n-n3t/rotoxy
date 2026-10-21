import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { StateStore } from "../dist/store.js";
import { createProviderPathApi } from "../dist/provider-paths.js";
import { createUnifiedModelApi } from "../dist/unified-model-api.js";
import { InferenceProviderStore } from "../dist/inference-providers.js";
import { buildApp } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-provider-paths-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  const store = new StateStore();
  await store.init({ adminPassword: "synthetic-only-provider-path-password" });
  const calls = [];
  const mockExternalFetch = async (url, init) => {
    const hostname = new URL(String(url)).hostname;
    calls.push({ provider: hostname === "api.openai.com" ? "openai" : hostname === "openrouter.ai" ? "openrouter" : "custom", url: String(url), body: init.body, authorization: init.headers.authorization });
    return Response.json({ choices: [{ message: { content: "external" } }] });
  };
  const liveFetch = globalThis.fetch;
  globalThis.fetch = mockExternalFetch;
  let unified;
  try { unified = createUnifiedModelApi(store, {
    ollamaFetch: async (_url, init) => {
      calls.push({ provider: "ollama", body: init.body, authorization: init.headers.authorization });
      return Response.json({ data: [{ id: "qwen-test" }] });
    },
    fetch: mockExternalFetch,
    externalPublicFetch: mockExternalFetch,
    cloudflareAdapter: { run: async input => { calls.push({ provider: "cloudflare", model: input.model }); return { result: { response: "cf" } }; } },
  }); } finally { globalThis.fetch = liveFetch; }
  const app = express();
  app.use(createProviderPathApi(unified.router));
  app.use(unified.router);
  app.use((req, res) => {
    calls.push({ provider: "legacy", path: req.path, body: Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body });
    res.json({ passedToLegacyGateway: true });
  });
  const server = createServer(app);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });
  return { store, api: unified, calls, base: `http://127.0.0.1:${server.address().port}` };
}

test("provider directory distinguishes direct inference from workspace and unavailable adapters", async t => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/providers`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.providers.find(provider => provider.id === "ollama").path, "/providers/ollama/v1");
  assert.equal(body.providers.find(provider => provider.id === "claude").protocol, "Anthropic Messages");
  assert.equal(body.providers.find(provider => provider.id === "claude").availability, "separate-opt-in-adapter");
  assert.equal(body.providers.find(provider => provider.id === "lightsprint").availability, "unavailable");
});

test("direct model catalogs expose only models from the named provider and keep read scope", async t => {
  const { store, api, base } = await fixture(t);
  const inference = new InferenceProviderStore(store);
  await inference.addAccount({ provider: "openai", label: "OpenAI", token: "synthetic-openai-key-123", allowedModels: ["gpt-test"] });
  await inference.addAccount({ provider: "openrouter", label: "OpenRouter", token: "synthetic-openrouter-key-123", allowedModels: ["vendor/model-test"] });
  await api.cloudflareCredentials.addCredential({ label: "CF", accountId: "0123456789abcdef0123456789abcdef", token: "synthetic-cf-key-123", allowedModels: ["@cf/meta/model-test"] });
  await api.modelCredentials.addCredential("Ollama", "synthetic-ollama-key-123");
  const token = await api.modelCredentials.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const catalog = async provider => fetch(`${base}/providers/${provider}/v1/models`, { headers: { authorization: `Bearer ${token.token}` } });
  for (const [provider, expected] of [["openai", ["openai/gpt-test"]], ["openrouter", ["openrouter/vendor/model-test"]], ["cloudflare", ["cloudflare/@cf/meta/model-test"]], ["ollama", ["ollama/qwen-test"]]]) {
    const response = await catalog(provider);
    assert.equal(response.status, 200, provider);
    assert.deepEqual((await response.json()).data.map(item => item.id), expected, provider);
    assert.equal(response.headers.get("x-rotoxy-provider-path"), provider);
  }
  const noRead = await fetch(`${base}/providers/openai/v1/models`);
  assert.equal(noRead.status, 401);
});

test("provider path rejects cross-provider model selection before dispatch", async t => {
  const { store, api, calls, base } = await fixture(t);
  const inference = new InferenceProviderStore(store);
  await inference.addAccount({ provider: "openai", label: "OpenAI", token: "synthetic-openai-key-123", allowedModels: ["gpt-test"] });
  const token = await api.modelCredentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const response = await fetch(`${base}/providers/openai/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "openrouter/vendor/model-test", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "provider_model_mismatch");
  assert.deepEqual(calls, []);
});

test("provider path retains scoped bearer authorization and dispatches only through its own adapter", async t => {
  const { store, api, calls, base } = await fixture(t);
  const inference = new InferenceProviderStore(store);
  await inference.addAccount({ provider: "openai", label: "OpenAI", token: "synthetic-openai-key-123", allowedModels: ["gpt-test"] });
  const token = await api.modelCredentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const response = await fetch(`${base}/providers/openai/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-test", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "external");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "openai");
  assert.equal(calls[0].authorization, "Bearer synthetic-openai-key-123");

  const unauthorized = await fetch(`${base}/providers/openai/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-test", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(calls.length, 1);
});

test("Cloudflare direct path preserves its model namespace and dispatches to the Cloudflare adapter", async t => {
  const { api, calls, base } = await fixture(t);
  await api.cloudflareCredentials.addCredential({ label: "Cloudflare", accountId: "0123456789abcdef0123456789abcdef", token: "synthetic-cloudflare-key-123", allowedModels: ["@cf/meta/model-test"] });
  const token = await api.modelCredentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const response = await fetch(`${base}/providers/cloudflare/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "cloudflare/@cf/meta/model-test", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "cf");
  assert.deepEqual(calls, [{ provider: "cloudflare", model: "@cf/meta/model-test" }]);
});

test("OpenRouter and Ollama direct aliases stay in their own unified handlers", async t => {
  const { store, api, calls, base } = await fixture(t);
  const inference = new InferenceProviderStore(store);
  await inference.addAccount({ provider: "openrouter", label: "OpenRouter", token: "synthetic-openrouter-key-123", allowedModels: ["vendor/model-test"] });
  await api.modelCredentials.addCredential("Ollama", "synthetic-ollama-key-123");
  const token = await api.modelCredentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
  const messages = [{ role: "user", content: "hello" }];
  const openrouter = await fetch(`${base}/providers/openrouter/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "openrouter/vendor/model-test", messages }) });
  assert.equal(openrouter.status, 200);
  assert.equal(calls[0].provider, "openrouter");
  assert.equal(calls[0].authorization, "Bearer synthetic-openrouter-key-123");

  const ollama = await fetch(`${base}/providers/ollama/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "ollama/qwen-test", messages }) });
  assert.equal(ollama.status, 200);
  assert.deepEqual(await ollama.json(), { passedToLegacyGateway: true });
  const legacy = calls.find(call => call.provider === "legacy");
  assert.deepEqual(legacy.body, { model: "qwen-test", messages });
  assert.equal(calls.filter(call => call.provider === "openrouter").length, 1);
});

test("configured custom providers receive automatic case-preserving paths without cross-provider fallback", async t => {
  const { store, api, calls, base } = await fixture(t);
  const inference = new InferenceProviderStore(store);
  const customA = await inference.addCustomProvider("Custom A", "https://custom-a.example/v1");
  const customB = await inference.addCustomProvider("Custom B", "https://custom-b.example/v1");
  await inference.addAccount({ provider: customA.id, label: "Account A", token: "synthetic-custom-a-key-123", allowedModels: ["model-test"] });
  await inference.addAccount({ provider: customB.id, label: "Account B", token: "synthetic-custom-b-key-123", allowedModels: ["model-test"] });
  const read = await api.modelCredentials.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const invoke = await api.modelCredentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });

  const catalog = await fetch(`${base}/providers/${customA.id}/v1/models`, { headers: { authorization: `Bearer ${read.token}` } });
  assert.equal(catalog.status, 200);
  assert.deepEqual((await catalog.json()).data.map(item => item.id), [`${customA.id}/model-test`]);

  const send = (provider, model) => fetch(`${base}/providers/${provider}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${invoke.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
  });
  const mismatched = await send(customA.id, `${customB.id}/model-test`);
  assert.equal(mismatched.status, 400);
  assert.equal((await mismatched.json()).error.code, "provider_model_mismatch");
  assert.deepEqual(calls, []);

  const valid = await send(customA.id, `${customA.id}/model-test`);
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).choices[0].message.content, "external");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "custom");
  assert.equal(calls[0].url, "https://custom-a.example/v1/chat/completions");
  assert.equal(calls[0].authorization, "Bearer synthetic-custom-a-key-123");

  const suffix = customA.id.slice("custom-".length);
  const caseChangedId = "custom-" + suffix.replace(/[A-Za-z]/, character => character === character.toUpperCase() ? character.toLowerCase() : character.toUpperCase());
  assert.notEqual(caseChangedId, customA.id);
  const caseChanged = await send(caseChangedId, `${caseChangedId}/model-test`);
  assert.equal(caseChanged.status, 403, "opaque custom IDs are not normalized to a different provider");
  assert.equal((await caseChanged.json()).error.code, "model_not_allowed");
  assert.equal(calls.length, 1);

  const unknownId = `custom-${"0".repeat(24)}`;
  const unknown = await send(unknownId, `${unknownId}/model-test`);
  assert.equal(unknown.status, 403);
  assert.equal((await unknown.json()).error.code, "model_not_allowed");
  assert.equal(calls.length, 1, "unknown opaque provider ID never reaches a fallback adapter");
});

test("Claude adapter paths pass through to separately mounted provider-specific handlers", async t => {
  const { base, calls } = await fixture(t);
  const app = express();
  app.use(createProviderPathApi(express.Router()));
  app.post("/providers/claude/v1/messages", (_req, res) => res.json({ owner: "bedrock-adapter" }));
  const server = createServer(app);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/providers/claude/v1/messages`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { owner: "bedrock-adapter" });
  assert.deepEqual(calls, []);
});

test("production buildApp wiring serves provider directory and rejects unauthenticated direct calls", async t => {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-provider-app-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  const store = new StateStore();
  await store.init({ adminPassword: "synthetic-only-provider-app-password" });
  const built = await buildApp(store);
  const server = createServer(built.app);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const directory = await fetch(`${base}/providers`);
  assert.equal(directory.status, 200);
  assert.ok((await directory.json()).providers.some(provider => provider.id === "openrouter"));
  const unauthorized = await fetch(`${base}/providers/openai/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-test", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(unauthorized.status, 401);
});


test("/pools provider aliases retain provider pinning, catalog auth, and no cross-provider spillover", async t => {
  const { store, api, calls, base } = await fixture(t);
  const inference = new InferenceProviderStore(store);
  await inference.addAccount({ provider: "openai", label: "OpenAI", token: "synthetic-openai-pool-token", allowedModels: ["gpt-test"] });
  const invoke = await api.modelCredentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const read = await api.modelCredentials.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const directory = await fetch(base + "/pools");
  assert.equal(directory.status, 200);
  assert.ok((await directory.json()).providers.some(p => p.id === "openai"));
  const listed = await fetch(base + "/pools/openai/v1/models", { headers: { authorization: "Bearer " + read.token } });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).data.map(row => row.id), ["openai/gpt-test"]);
  assert.equal((await fetch(base + "/pools/openai/v1/models")).status, 401);
  const headers = { authorization: "Bearer " + invoke.token, "content-type": "application/json" };
  const mismatched = await fetch(base + "/pools/openai/v1/chat/completions", {
    method: "POST", headers, body: JSON.stringify({ model: "openrouter/vendor/model-test", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(mismatched.status, 400);
  assert.equal(calls.length, 0);
  const allowed = await fetch(base + "/pools/openai/v1/chat/completions", {
    method: "POST", headers, body: JSON.stringify({ model: "openai/gpt-test", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "openai");
});
