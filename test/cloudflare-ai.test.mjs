import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { CloudflareAIAdapter, CloudflareAIError, CloudflareCredentialStore } from "../dist/cloudflare-ai.js";

test("Cloudflare catalog pages read-only metadata, preserves selection, and stops repeated pages visibly", async t => {
  const root = await mkdtemp(join(tmpdir(), "rx-cf-catalog-pages-"));
  const previous = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.TOKEN2OAUTH_CONFIG_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const store = new StateStore(); await store.init({ adminPassword: "synthetic-catalog-test-only" });
  const credentials = new CloudflareCredentialStore(store);
  const account = await credentials.addCredential({ label: "Catalog", accountId: "c".repeat(32), token: "synthetic-catalog-key", allowedModels: [] });
  const rows = Array.from({ length: 100 }, (_, i) => ({ name: `@cf/test/model-${i}` }));
  const calls = [];
  const adapter = new CloudflareAIAdapter(credentials, { fetch: async (url, init) => {
    assert.equal(init.method, "GET"); assert.equal(init.body, undefined);
    const parsed = new URL(url); calls.push(parsed);
    assert.equal(parsed.searchParams.get("per_page"), "100");
    return Response.json({ success: true, result: parsed.searchParams.get("page") === "1" ? rows : [{ name: "@cf/test/last" }], result_info: { total_pages: 2 } });
  } });
  const catalog = await adapter.listModels();
  assert.equal(catalog.result.length, 101); assert.equal(catalog.result_info.truncated, false);
  assert.deepEqual(calls.map(u => u.searchParams.get("page")), ["1", "2"]);
  assert.deepEqual((await credentials.listCredentials()).find(a => a.id === account.id).allowedModels, []);
  let repeatedCalls = 0;
  const repeated = new CloudflareAIAdapter(credentials, { fetch: async () => { repeatedCalls++; return Response.json({ success: true, result: rows }); } });
  const partial = await repeated.listModels();
  assert.equal(repeatedCalls, 2); assert.equal(partial.result.length, 100); assert.equal(partial.result_info.truncated, true);
});

test("Cloudflare credentials stay encrypted and account-pinned requests honor allowlists, caps, cooldowns, and fair concurrency", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-cloudflare-ai-"));
  const oldHome = process.env.HOME;
  const oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  const store = new StateStore();
  await store.init({ adminPassword: "temporary-cloudflare-test-password" });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });

  const credentials = new CloudflareCredentialStore(store);
  const model = "@cf/meta/llama-3.1-8b-instruct";
  const a = await credentials.addCredential({ label: "CF A", accountId: "a".repeat(32), token: "secret-token-account-a", allowedModels: [model] });
  const b = await credentials.addCredential({ label: "CF B", accountId: "b".repeat(32), token: "secret-token-account-b", allowedModels: [model] });
  assert.equal("token" in a, false);
  await assert.rejects(credentials.addCredential({ label: "duplicate", accountId: "A".repeat(32), token: "secret-token-duplicate" }), /already exists/);
  await assert.rejects(credentials.addCredential({ label: "bad", accountId: "z".repeat(31), token: "secret-token-invalid" }), /invalid/);
  await assert.rejects(credentials.addCredential({ label: "bad", accountId: "c".repeat(32), token: "bad\ntoken" }), /invalid/);
  await assert.rejects(credentials.addCredential({ label: "empty", accountId: "c".repeat(32), token: "secret-token-empty", allowedModels: ["*"] }), /allowlist/);
  const credentialFile = join(store.dir, "cloudflare-ai-credentials.json");
  const persisted = await readFile(credentialFile, "utf8");
  assert.doesNotMatch(persisted, /secret-token-account-[ab]/);
  assert.match(persisted, /"secret"/);
  assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);

  let releaseFirst;
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "GET") return Response.json({ success: true, result: [] });
    if (calls.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    return new Response(JSON.stringify({ success: true, result: { response: "ok" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new CloudflareAIAdapter(credentials, { fetch: fakeFetch, maxTokens: 64, timeoutMs: 5000 });
  const first = adapter.run({ model, input: { prompt: "first", max_tokens: 1000 } });
  while (!releaseFirst) await new Promise((resolve) => setTimeout(resolve, 1));
  const second = adapter.run({ model, input: { prompt: "second", max_tokens: 16 } });
  while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(new URL(calls[0].url).pathname, `/client/v4/accounts/${"a".repeat(32)}/ai/run/%40cf/meta/llama-3.1-8b-instruct`);
  assert.equal(new URL(calls[1].url).pathname, `/client/v4/accounts/${"b".repeat(32)}/ai/run/%40cf/meta/llama-3.1-8b-instruct`);
  assert.equal(calls[0].init.headers.authorization, "Bearer secret-token-account-a");
  assert.equal(JSON.parse(calls[0].init.body).max_tokens, 64);
  assert.equal(JSON.parse(calls[1].init.body).max_tokens, 16);
  releaseFirst();
  await Promise.all([first, second]);
  await adapter.listModels();
  assert.equal(new URL(calls[2].url).pathname, `/client/v4/accounts/${"a".repeat(32)}/ai/models/search`);
  assert.equal(calls[2].init.method, "GET");

  const beforeDenied = calls.length;
  await assert.rejects(adapter.run({ model: "@cf/meta/not-allowed", input: { prompt: "no" } }), (error) => error instanceof CloudflareAIError && error.code === "model_not_allowed");
  await credentials.updateCredential(a.id, { enabled: false });
  await credentials.setCooldown(b.id, Date.now() + 60_000);
  await assert.rejects(adapter.listModels(), (error) => error instanceof CloudflareAIError && error.code === "no_eligible_account");
  assert.equal(calls.length, beforeDenied, "disabled/cooldown accounts are excluded without a request");
  await credentials.updateCredential(b.id, { enabled: false });
  await credentials.updateCredential(a.id, { enabled: true, allowedModels: [] });
  await credentials.updateCredential(a.id, { token: "rotated-secret-token" });
  assert.equal((await credentials.listCredentials()).find((item) => item.id === a.id).allowedModels.length, 0, "empty allowlist remains deny-all");
  await assert.rejects(adapter.run({ model, input: { prompt: "no" } }), (error) => error instanceof CloudflareAIError && error.code === "model_not_allowed");
  assert.equal(await credentials.deleteCredential(a.id), true);
  assert.equal(await credentials.deleteCredential(a.id), false);
});

test("Cloudflare inference makes one bounded attempt and reports ambiguous transport failures without exposing credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-cloudflare-timeout-"));
  const oldHome = process.env.HOME;
  const oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  const store = new StateStore();
  await store.init({ adminPassword: "temporary-cloudflare-test-password" });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });
  const credentials = new CloudflareCredentialStore(store);
  await credentials.addCredential({ label: "CF", accountId: "c".repeat(32), token: "secret-token-account-c", allowedModels: ["@cf/meta/llama-3.1-8b-instruct"] });
  let count = 0;
  const adapter = new CloudflareAIAdapter(credentials, { timeoutMs: 100, fetch: async () => { count++; throw new Error("secret-token-account-c network trace"); } });
  await assert.rejects(adapter.run({ model: "@cf/meta/llama-3.1-8b-instruct", input: { prompt: "hello" } }), (error) => {
    assert.equal(error.code, "upstream_ambiguous");
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  });
  assert.equal(count, 1, "ambiguous inference is never retried");

  const oversized = new CloudflareAIAdapter(credentials, { fetch: async () => new Response("{}", { status: 200, headers: { "content-length": "2000001" } }) });
  await assert.rejects(oversized.run({ model: "@cf/meta/llama-3.1-8b-instruct", input: { prompt: "hello" } }), (error) => error.code === "response_too_large");

  let quotaCalls = 0;
  const quota = new CloudflareAIAdapter(credentials, { fetch: async () => { quotaCalls++; return new Response("rate limited", { status: 429 }); } });
  await assert.rejects(quota.run({ model: "@cf/meta/llama-3.1-8b-instruct", input: { prompt: "hello" } }), (error) => error.code === "upstream_rejected" && error.status === 429);
  await assert.rejects(quota.run({ model: "@cf/meta/llama-3.1-8b-instruct", input: { prompt: "hello" } }), (error) => error.code === "no_eligible_account");
  assert.equal(quotaCalls, 1, "429 cools down the account and prevents another attempt");
});
