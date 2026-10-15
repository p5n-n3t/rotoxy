import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { StateStore } from "../dist/store.js";
import { CloudflareAIError } from "../dist/cloudflare-ai.js";
import { createUnifiedModelApi } from "../dist/unified-model-api.js";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "t2o-unified-api-"));
  const oldHome = process.env.HOME;
  const oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  const store = new StateStore();
  await store.init({ adminPassword: "synthetic-only-admin-password" });
  const api = createUnifiedModelApi(store, options);
  const app = express();
  app.use(api.router);
  const forwarded = [];
  app.use((req, res) => {
    forwarded.push({ method: req.method, path: req.path, body: Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body, authorization: req.header("authorization") });
    res.json({ passedToLegacyGateway: true });
  });
  const server = createServer(app);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });
  return { store, api, base, forwarded };
}

test("catalog requires model:read and merges enabled Cloudflare allowlists with authenticated Ollama models and aliases", async t => {
  const calls = [];
  const { api, base } = await fixture(t, { ollamaFetch: async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.authorization });
    return Response.json({ object: "list", data: [{ id: "qwen3:8b" }, { id: "raw/legacy-model" }] });
  } });
  await api.cloudflareCredentials.addCredential({ label: "test cf", accountId: "0123456789abcdef0123456789abcdef", token: "synthetic-cf-token-123", allowedModels: ["@cf/meta/llama-3.1-8b-instruct"] });
  await api.modelCredentials.addCredential("test ollama", "synthetic-ollama-token-123");
  const read = await api.modelCredentials.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const invoke = await api.modelCredentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const denied = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${invoke.token}` } });
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 0);
  const response = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${read.token}` } });
  assert.equal(response.status, 200);
  const ids = (await response.json()).data.map(item => item.id);
  assert.deepEqual(ids, ["cloudflare/@cf/meta/llama-3.1-8b-instruct", "ollama/qwen3:8b", "qwen3:8b", "ollama/raw/legacy-model", "raw/legacy-model"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ollama.com/v1/models");
  assert.equal(calls[0].authorization, "Bearer synthetic-ollama-token-123");
});

test("Cloudflare chat maps a bounded nonstream response and rejects read scope and streaming without duplicate inference", async t => {
  const calls = [];
  const cloudflareAdapter = { run: async input => {
    calls.push(input);
    return { result: { response: input.input.messages[0].content === "large" ? "x".repeat(128 * 1024 + 1) : "hello from workers ai", usage: { prompt_tokens: 4, completion_tokens: 3 } } };
  } };
  const { api, base } = await fixture(t, { cloudflareAdapter });
  await api.cloudflareCredentials.addCredential({ label: "test cf", accountId: "0123456789abcdef0123456789abcdef", token: "synthetic-cf-token-123", allowedModels: ["@cf/meta/llama-3.1-8b-instruct"] });
  const read = await api.modelCredentials.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const invoke = await api.modelCredentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const payload = { model: "cloudflare/@cf/meta/llama-3.1-8b-instruct", messages: [{ role: "user", content: "hello" }] };
  const denied = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${read.token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 0);
  const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${invoke.token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  const completion = await response.json();
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.model, payload.model);
  assert.deepEqual(completion.choices[0].message, { role: "assistant", content: "hello from workers ai" });
  assert.deepEqual(completion.usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
  assert.deepEqual(calls[0], { model: "@cf/meta/llama-3.1-8b-instruct", input: { messages: [{ role: "user", content: "hello" }] } });
  const streamed = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${invoke.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...payload, stream: true }) });
  assert.equal(streamed.status, 400);
  assert.equal((await streamed.json()).error.code, "streaming_not_supported");
  const oversized = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${invoke.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...payload, messages: [{ role: "user", content: "large" }] }) });
  assert.equal(oversized.status, 502);
  assert.equal((await oversized.json()).error.code, "invalid_provider_response");
  assert.equal(calls.length, 2);
});

test("Ollama namespaced and raw models pass once to the existing gateway; Cloudflare failures are sanitized and not replayed", async t => {
  let calls = 0;
  const cloudflareAdapter = { run: async () => { calls++; throw new CloudflareAIError("upstream_ambiguous"); } };
  const { api, base, forwarded } = await fixture(t, { cloudflareAdapter });
  const invoke = await api.modelCredentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const send = async model => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${invoke.token}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) });
  assert.equal((await (await send("ollama/qwen3:8b")).json()).passedToLegacyGateway, true);
  assert.equal((await (await send("qwen3:8b")).json()).passedToLegacyGateway, true);
  assert.equal(forwarded[0].body.model, "qwen3:8b");
  assert.equal(forwarded[1].body.model, "qwen3:8b");
  assert.equal(forwarded[0].authorization, `Bearer ${invoke.token}`);
  const ambiguous = await send("cloudflare/@cf/meta/llama-3.1-8b-instruct");
  assert.equal(ambiguous.status, 503);
  assert.doesNotMatch(await ambiguous.text(), /synthetic|authorization|token/i);
  assert.equal(calls, 1);
});
