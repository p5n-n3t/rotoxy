import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { StateStore } from "../dist/store.js";
import { CloudflareAIError } from "../dist/cloudflare-ai.js";
import { InferenceProviderStore } from "../dist/inference-providers.js";
import { ResourceRoutingRulesStore } from "../dist/resource-routing.js";
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
  const writes = [];
  app.use((req, res, next) => {
    const write = res.write.bind(res);
    res.write = (...args) => { writes.push({ destroyed: res.destroyed, writableEnded: res.writableEnded }); return write(...args); };
    next();
  });
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
  return { store, api, base, forwarded, writes };
}

test("catalog is scoped, singleflight-cached and invalidated by Ollama credential changes", async t => {
  const calls = [];
  let releaseCatalog;
  let markCatalogEntered;
  const catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
  const catalogEntered = new Promise(resolve => { markCatalogEntered = resolve; });
  const { api, base } = await fixture(t, { ollamaFetch: async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.authorization });
    markCatalogEntered();
    if (calls.length === 1) await catalogGate;
    return Response.json({ object: "list", data: [{ id: "qwen3:8b" }, { id: "raw/legacy-model" }] });
  } });
  await api.cloudflareCredentials.addCredential({ label: "test cf", accountId: "0123456789abcdef0123456789abcdef", token: "synthetic-cf-token-123", allowedModels: ["@cf/meta/llama-3.1-8b-instruct"] });
  const ollamaAccount = await api.modelCredentials.addCredential("test ollama", "synthetic-ollama-token-123");
  const read = await api.modelCredentials.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const invoke = await api.modelCredentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const denied = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${invoke.token}` } });
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 0);
  const catalogRequest = () => fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${read.token}` } });
  const first = catalogRequest();
  await catalogEntered;
  const concurrent = catalogRequest();
  await new Promise(resolve => setTimeout(resolve, 20));
  releaseCatalog();
  const [response, sharedResponse] = await Promise.all([first, concurrent]);
  assert.equal(response.status, 200);
  assert.equal(sharedResponse.status, 200);
  const ids = (await response.json()).data.map(item => item.id);
  assert.deepEqual(ids, ["cloudflare/@cf/meta/llama-3.1-8b-instruct", "ollama/qwen3:8b", "qwen3:8b", "ollama/raw/legacy-model", "raw/legacy-model"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ollama.com/v1/models");
  assert.equal(calls[0].authorization, "Bearer synthetic-ollama-token-123");
  assert.match(response.headers.get("x-model-catalog-provenance"), /ollama-live/);
  assert.match(sharedResponse.headers.get("x-model-catalog-provenance"), /cache-(shared|hit)/);
  const cached = await catalogRequest();
  assert.equal(cached.headers.get("x-model-catalog-provenance").split(";").at(-1).trim(), "cache-hit");
  assert.equal(calls.length, 1);

  await api.modelCredentials.rotateCredential(ollamaAccount.id, "synthetic-ollama-token-rotated");
  assert.equal((await catalogRequest()).status, 200);
  assert.equal(calls.length, 2, "key rotation changes store file metadata and invalidates cache");
  await api.modelCredentials.setCredentialEnabled(ollamaAccount.id, false);
  const disabled = await catalogRequest();
  assert.equal(disabled.status, 200, "Ollama errors/disabled accounts do not hide the Cloudflare catalog");
  assert.match(disabled.headers.get("x-model-catalog-provenance"), /ollama-not-eligible/);
  assert.equal((await disabled.json()).data[0].id, "cloudflare/@cf/meta/llama-3.1-8b-instruct");
  assert.equal(calls.length, 2);
  await api.modelCredentials.setCredentialEnabled(ollamaAccount.id, true);
  assert.equal((await catalogRequest()).status, 200);
  assert.equal(calls.length, 3);
  await api.modelCredentials.removeCredential(ollamaAccount.id);
  assert.equal((await catalogRequest()).status, 200);
  assert.equal(calls.length, 3);
});

test("Ollama catalog failure preserves the enabled Cloudflare catalog", async t => {
  const { api, base } = await fixture(t, { ollamaFetch: async () => new Response("synthetic private provider body", { status: 503 }) });
  await api.cloudflareCredentials.addCredential({ label: "test cf", accountId: "0123456789abcdef0123456789abcdef", token: "synthetic-cf-token-123", allowedModels: ["@cf/meta/llama-3.1-8b-instruct"] });
  await api.modelCredentials.addCredential("test ollama", "synthetic-ollama-token-123");
  const read = await api.modelCredentials.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const response = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${read.token}` } });
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.deepEqual(catalog.data.map(model => model.id), ["cloudflare/@cf/meta/llama-3.1-8b-instruct"]);
  assert.match(response.headers.get("x-model-catalog-provenance"), /ollama-unavailable/);
  assert.doesNotMatch(JSON.stringify(catalog), /synthetic private provider body/);
});

test("Ollama catalog applies each account's exact routing allowlist; absent allows provider catalog and empty denies it", async t => {
  const { store, api, base } = await fixture(t, { ollamaFetch: async (_url, init) => {
    const model = init.headers.authorization.endsWith("account-a-token") ? "qwen3:8b" : "raw/legacy-model";
    return Response.json({ object: "list", data: [{ id: model }, { id: "not-an-exact-match" }] });
  } });
  const accountA = await api.modelCredentials.addCredential("account A", "synthetic-account-a-token");
  const accountB = await api.modelCredentials.addCredential("account B", "synthetic-account-b-token");
  const rules = new ResourceRoutingRulesStore(store);
  await rules.replace({ version: 1, resources: {
    [accountA.id]: { allowedModels: ["qwen3:8b"], enabled: true, weight: 1 },
    [accountB.id]: { allowedModels: [], enabled: true, weight: 1 },
  } });
  const read = await api.modelCredentials.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const request = () => fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${read.token}` } });
  const filtered = await request();
  assert.equal(filtered.status, 200);
  assert.deepEqual((await filtered.json()).data.map(item => item.id), ["ollama/qwen3:8b", "qwen3:8b"]);

  await rules.replace({ version: 1, resources: { [accountA.id]: { enabled: true, weight: 1 } } });
  const unfiltered = await request();
  assert.equal(unfiltered.status, 200);
  assert.deepEqual((await unfiltered.json()).data.map(item => item.id), [
    "ollama/qwen3:8b", "qwen3:8b", "ollama/not-an-exact-match", "not-an-exact-match",
    "ollama/raw/legacy-model", "raw/legacy-model",
  ]);
  assert.equal(unfiltered.headers.get("x-model-catalog-provenance").split(";").at(-1).trim(), "cache-miss", "routing edits invalidate the catalog cache");
});

test("OpenAI and OpenRouter configured allowlist edits invalidate the merged catalog cache", async t => {
  const { store, api, base } = await fixture(t);
  const providers = new InferenceProviderStore(store);
  const openai = await providers.addAccount({ provider: "openai", label: "OpenAI", token: "synthetic-openai-token", allowedModels: ["gpt-4.1-mini"] });
  const openrouter = await providers.addAccount({ provider: "openrouter", label: "OpenRouter", token: "synthetic-openrouter-token", allowedModels: ["anthropic/claude-3.7-sonnet"] });
  const read = await api.modelCredentials.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const request = () => fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${read.token}` } });
  const first = await request();
  assert.deepEqual((await first.json()).data.map(item => item.id), ["openai/gpt-4.1-mini", "openrouter/anthropic/claude-3.7-sonnet"]);
  assert.match(first.headers.get("x-model-catalog-provenance"), /cache-miss/);
  const cached = await request();
  assert.match(cached.headers.get("x-model-catalog-provenance"), /cache-hit/);
  await providers.updateAccount(openai.id, { allowedModels: ["gpt-4.1"] });
  await providers.updateAccount(openrouter.id, { allowedModels: [] });
  const refreshed = await request();
  assert.deepEqual((await refreshed.json()).data.map(item => item.id), ["openai/gpt-4.1"]);
  assert.match(refreshed.headers.get("x-model-catalog-provenance"), /cache-miss/);
});

test("Cloudflare chat maps a bounded nonstream response, enforces scopes and rejects oversized output without replay", async t => {
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
  const oversized = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${invoke.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...payload, messages: [{ role: "user", content: "large" }] }) });
  assert.equal(oversized.status, 502);
  assert.equal((await oversized.json()).error.code, "invalid_provider_response");
  assert.equal(calls.length, 2);
});

test("Cloudflare stream:true emits escaped OpenAI SSE frames from one buffered inference and validates unsupported input", async t => {
  const calls = [];
  const { api, base } = await fixture(t, { cloudflareAdapter: { run: async input => {
    calls.push(input);
    return { result: { response: "line one\nquote: \"ok\"", usage: { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 } } };
  } } });
  await api.cloudflareCredentials.addCredential({ label: "test cf", accountId: "0123456789abcdef0123456789abcdef", token: "synthetic-cf-token-123", allowedModels: ["@cf/meta/llama-3.1-8b-instruct"] });
  const invoke = await api.modelCredentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const headers = { authorization: `Bearer ${invoke.token}`, "content-type": "application/json" };
  const payload = { model: "cloudflare/@cf/meta/llama-3.1-8b-instruct", messages: [{ role: "user", content: "hello" }], stream: true, stream_options: { include_usage: true } };
  const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(payload) });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const raw = await response.text();
  const frames = raw.split("\n\n").filter(frame => frame.startsWith("data: ")).map(frame => frame.slice(6));
  assert.equal(frames.at(-1), "[DONE]");
  const chunks = frames.slice(0, -1).map(frame => JSON.parse(frame));
  assert.deepEqual(chunks.map(chunk => chunk.choices?.[0]?.delta?.role ?? (chunk.choices?.[0]?.delta?.content !== undefined ? "content" : chunk.choices?.[0]?.finish_reason ?? ("usage" in chunk ? "usage" : "other"))), ["assistant", "content", "stop", "usage"]);
  assert.equal(chunks[1].choices[0].delta.content, "line one\nquote: \"ok\"");
  assert.deepEqual(chunks[3].usage, { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 });
  assert.deepEqual(calls[0], { model: "@cf/meta/llama-3.1-8b-instruct", input: { messages: [{ role: "user", content: "hello" }] } }, "streaming is buffered; adapter receives no stream flag");

  const invalidOptions = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ ...payload, stream_options: { include_usage: "yes" } }) });
  assert.equal(invalidOptions.status, 400);
  const tools = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ ...payload, tools: [] }) });
  assert.equal(tools.status, 400);
  assert.equal((await tools.json()).error.code, "unsupported_parameter");
  const toolMessage = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ ...payload, messages: [{ role: "assistant", content: "", tool_calls: [] }] }) });
  assert.equal(toolMessage.status, 400);
  assert.equal((await toolMessage.json()).error.code, "unsupported_parameter");
  const multimodal = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ ...payload, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }) });
  assert.equal(multimodal.status, 400);
  assert.equal((await multimodal.json()).error.code, "unsupported_parameter");
  const oversizedRequest = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ ...payload, messages: [{ role: "user", content: "x".repeat(70_000) }] }) });
  assert.equal(oversizedRequest.status, 413);
  assert.equal(calls.length, 1);
});

test("Cloudflare SSE does not write after the client closes while buffered inference is pending", async t => {
  let entered;
  let release;
  const inferenceEntered = new Promise(resolve => { entered = resolve; });
  const pendingInference = new Promise(resolve => { release = resolve; });
  const { api, base, writes } = await fixture(t, { cloudflareAdapter: { run: async () => { entered(); return pendingInference; } } });
  await api.cloudflareCredentials.addCredential({ label: "test cf", accountId: "0123456789abcdef0123456789abcdef", token: "synthetic-cf-token-123", allowedModels: ["@cf/meta/llama-3.1-8b-instruct"] });
  const invoke = await api.modelCredentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const controller = new AbortController();
  const request = fetch(`${base}/v1/chat/completions`, { method: "POST", signal: controller.signal, headers: { authorization: `Bearer ${invoke.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "cloudflare/@cf/meta/llama-3.1-8b-instruct", messages: [{ role: "user", content: "hello" }], stream: true }) }).catch(error => error);
  await inferenceEntered;
  controller.abort();
  await request;
  await new Promise(resolve => setTimeout(resolve, 25));
  release({ result: { response: "late response" } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(writes, [], "closed client receives no SSE writes");
});

test("Ollama namespaced and raw models pass once to the existing gateway; Cloudflare failures are sanitized and not replayed", async t => {
  let calls = 0;
  const cloudflareAdapter = { run: async () => { calls++; throw new CloudflareAIError("upstream_ambiguous"); } };
  const { api, base, forwarded } = await fixture(t, { cloudflareAdapter });
  assert.equal((await fetch(`${base}/v1/chat/completions`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"ollama/qwen3:8b",messages:[{role:"user",content:"hi"}]})})).status,401);
  assert.equal(forwarded.length,0);
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
