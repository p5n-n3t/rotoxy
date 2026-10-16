import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { InferenceProviderError, InferenceProviderStore, INFERENCE_PROVIDER_PRESETS, OpenAICompatibleInferenceAdapter } from "../dist/inference-providers.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "t2o-inference-provider-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  const state = new StateStore();
  await state.init({ adminPassword: "synthetic-test-admin-password" });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });
  return { root, state, accounts: new InferenceProviderStore(state) };
}

test("encrypted preset accounts enforce model allowlists and rotate fairly across fixed origins", async t => {
  const { state, accounts } = await fixture(t);
  const first = await accounts.addAccount({ provider: "openai", label: "OpenAI primary", token: "synthetic-openai-token-111", allowedModels: ["gpt-4.1-mini"] });
  const second = await accounts.addAccount({ provider: "openai", label: "OpenAI secondary", token: "synthetic-openai-token-222", allowedModels: ["gpt-4.1-mini"] });
  await accounts.addAccount({ provider: "openrouter", label: "No models", token: "synthetic-openrouter-token", allowedModels: [] });
  const calls = [];
  const adapter = new OpenAICompatibleInferenceAdapter(accounts, { fetch: async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.authorization, redirect: init.redirect, body: JSON.parse(init.body) });
    return Response.json({ id: "chatcmpl-synthetic", choices: [{ message: { role: "assistant", content: "ok" } }] });
  } });
  const body = { messages: [{ role: "user", content: "hello" }] };
  assert.deepEqual(await adapter.complete({ provider: "openai", model: "gpt-4.1-mini", body }), { id: "chatcmpl-synthetic", choices: [{ message: { role: "assistant", content: "ok" } }] });
  await adapter.complete({ provider: "openai", model: "gpt-4.1-mini", body });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.authorization), ["Bearer synthetic-openai-token-111", "Bearer synthetic-openai-token-222"]);
  assert.deepEqual(calls.map(call => call.url), ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions"]);
  assert.ok(calls.every(call => call.redirect === "error"));
  assert.equal(calls[0].body.model, "gpt-4.1-mini");
  await assert.rejects(adapter.complete({ provider: "openrouter", model: "anthropic/claude-3.7-sonnet", body }), error => error instanceof InferenceProviderError && error.code === "model_not_allowed");
  await assert.rejects(accounts.addAccount({ provider: "https://evil.example", label: "bad", token: "synthetic-openai-token" }), /invalid/);

  const views = await accounts.listAccounts();
  assert.equal(views.length, 3);
  assert.ok(views.every(view => !Object.hasOwn(view, "token") && !Object.hasOwn(view, "secret")));
  const file = await readFile(join(state.dir, "inference-providers.json"), "utf8");
  assert.doesNotMatch(file, /synthetic-openai-token-111|synthetic-openrouter-token/);
  assert.equal((await stat(join(state.dir, "inference-providers.json"))).mode & 0o777, 0o600);
  assert.equal((await accounts.credentialForRequest(first.id)).token, "synthetic-openai-token-111");
  await accounts.updateAccount(first.id, { token: "synthetic-openai-token-rotated", allowedModels: [] });
  assert.deepEqual((await accounts.listAccounts()).find(view => view.id === first.id).allowedModels, []);
  assert.equal(INFERENCE_PROVIDER_PRESETS.openrouter.origin, "https://openrouter.ai/api/v1");
  assert.equal(second.provider, "openai");
});

test("adapter bounds requests and responses, blocks redirects, and never retries ambiguous inference", async t => {
  const { accounts } = await fixture(t);
  await accounts.addAccount({ provider: "openrouter", label: "OpenRouter", token: "synthetic-openrouter-token", allowedModels: ["anthropic/claude-3.7-sonnet"] });
  const body = { messages: [{ role: "user", content: "hello" }] };
  let calls = 0;
  let mode = "ambiguous";
  const adapter = new OpenAICompatibleInferenceAdapter(accounts, { fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init.redirect, "error");
    if (mode === "ambiguous") throw new Error("synthetic socket loss");
    if (mode === "redirect") return new Response("", { status: 302, headers: { location: "https://evil.example/collect" } });
    return new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 });
  } });
  await assert.rejects(adapter.complete({ provider: "openrouter", model: "anthropic/claude-3.7-sonnet", body }), error => error.code === "upstream_ambiguous");
  assert.equal(calls, 1);
  mode = "redirect";
  await assert.rejects(adapter.complete({ provider: "openrouter", model: "anthropic/claude-3.7-sonnet", body }), error => error.code === "upstream_rejected");
  assert.equal(calls, 2);
  mode = "large";
  await assert.rejects(adapter.complete({ provider: "openrouter", model: "anthropic/claude-3.7-sonnet", body }), error => error.code === "response_too_large");
  assert.equal(calls, 3);
  await assert.rejects(adapter.complete({ provider: "openrouter", model: "anthropic/claude-3.7-sonnet", body: { messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] } }), error => error.code === "invalid_request");
  assert.equal(calls, 3, "oversized input is rejected before a provider request");
});

test("adapter applies provider-specific default and clamped output caps and rejects duplicate cap fields before fetch", async t => {
  const { accounts } = await fixture(t);
  await accounts.addAccount({ provider: "openai", label: "OpenAI", token: "synthetic-openai-token", allowedModels: ["gpt-4.1-mini"] });
  await accounts.addAccount({ provider: "openrouter", label: "OpenRouter", token: "synthetic-openrouter-token", allowedModels: ["anthropic/claude-3.7-sonnet"] });
  const calls = [];
  const adapter = new OpenAICompatibleInferenceAdapter(accounts, { fetch: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return Response.json({ id: "chatcmpl-synthetic", choices: [] });
  } });
  const messages = [{ role: "user", content: "synthetic request" }];
  await adapter.complete({ provider: "openai", model: "gpt-4.1-mini", body: { messages } });
  await adapter.complete({ provider: "openai", model: "gpt-4.1-mini", body: { messages, max_completion_tokens: 9000 } });
  await adapter.complete({ provider: "openrouter", model: "anthropic/claude-3.7-sonnet", body: { messages } });
  await adapter.complete({ provider: "openrouter", model: "anthropic/claude-3.7-sonnet", body: { messages, max_tokens: 9000 } });
  assert.deepEqual(calls.map(body => [body.max_tokens, body.max_completion_tokens]), [
    [undefined, 4096], [undefined, 8192], [4096, undefined], [8192, undefined],
  ]);
  await assert.rejects(adapter.complete({ provider: "openai", model: "gpt-4.1-mini", body: { messages, max_tokens: 100, max_completion_tokens: 100 } }),
    error => error instanceof InferenceProviderError && error.code === "invalid_request");
  assert.equal(calls.length, 4, "invalid duplicate cap parameters must not call the provider");
});

test("custom credentials require origin-bound replacement and never expose origin binding", async t => {
  const { accounts } = await fixture(t);
  const provider = await accounts.addCustomProvider("Vendor", "https://api.vendor.example/v1");
  const account = await accounts.addAccount({ provider: provider.id, label: "Vendor key", token: "synthetic-vendor-token", allowedModels: ["chat-model"] });
  assert.equal(Object.hasOwn(account, "tokenOrigin"), false);
  assert.equal(Object.hasOwn((await accounts.listAccounts())[0], "tokenOrigin"), false);
  assert.equal((await accounts.credentialForRequest(account.id)).origin, "https://api.vendor.example/v1");
  await accounts.updateCustomProvider(provider.id, "Vendor", "https://new.vendor.example/v1");
  assert.equal(await accounts.credentialForRequest(account.id), undefined, "an endpoint change cannot move its old bearer token");
  await accounts.updateAccount(account.id, { token: "synthetic-vendor-token-replaced" });
  assert.equal((await accounts.credentialForRequest(account.id)).origin, "https://new.vendor.example/v1");
});

test("custom adapter uses pinned-public transport and rejects redirect without replay", async t => {
  const { accounts } = await fixture(t);
  const provider = await accounts.addCustomProvider("Vendor", "https://api.vendor.example/v1");
  await accounts.addAccount({ provider: provider.id, label: "Vendor account", token: "synthetic-vendor-token", allowedModels: ["chat-model"] });
  const calls = [];
  const adapter = new OpenAICompatibleInferenceAdapter(accounts, { publicFetch: async (url, init) => {
    calls.push([String(url), init.redirect, init.headers.authorization]);
    return new Response("", { status: 302, headers: { location: "https://evil.example/steal" } });
  } });
  await assert.rejects(adapter.complete({ provider: provider.id, model: "chat-model", body: { messages: [{ role: "user", content: "hi" }] } }), error => error.code === "upstream_rejected");
  assert.deepEqual(calls, [["https://api.vendor.example/v1/chat/completions", "error", "Bearer synthetic-vendor-token"]]);
});
