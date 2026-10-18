import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { ModelCredentialStore } from "../dist/model-credentials.js";
import { createBedrockMessagesRouter, resolveBedrockMessagesConfiguration } from "../dist/bedrock-messages.js";

async function harness(t, options = {}, fakeCreate = async () => ({ id: "msg_1", type: "message", role: "assistant", model: "anthropic.claude-sonnet-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })) {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-bedrock-messages-"));
  const oldHome = process.env.HOME;
  const oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  const oldBearer = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const oldBase = process.env.ANTHROPIC_BEDROCK_MANTLE_BASE_URL;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  delete process.env.ANTHROPIC_BEDROCK_MANTLE_BASE_URL;
  const store = new StateStore();
  await store.init({ adminPassword: "temporary-bedrock-test-admin-password" });
  const credentials = new ModelCredentialStore(store);
  const invoke = await credentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const readOnly = await credentials.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const created = [];
  const router = createBedrockMessagesRouter(store, {
    region: "eu-north-1",
    models: ["anthropic.claude-sonnet-5"],
    clientFactory: config => {
      created.push(config);
      return { messages: { create: fakeCreate } };
    },
    ...options,
  });
  const app = express();
  app.use(router);
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
    if (oldBearer === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK; else process.env.AWS_BEARER_TOKEN_BEDROCK = oldBearer;
    if (oldBase === undefined) delete process.env.ANTHROPIC_BEDROCK_MANTLE_BASE_URL; else process.env.ANTHROPIC_BEDROCK_MANTLE_BASE_URL = oldBase;
  });
  return { base, store, credentials, invoke, readOnly, created };
}

const path = "/providers/claude/v1/messages";
const requestBody = { model: "anthropic.claude-sonnet-5", max_tokens: 64, messages: [{ role: "user", content: "hello" }] };

test("resolves only an explicit region and model allowlist into the fixed AWS Bedrock Mantle URL", () => {
  assert.deepEqual(resolveBedrockMessagesConfiguration({ region: "eu-north-1", models: "anthropic.claude-opus-5-5, anthropic.claude-haiku-5-5" }), {
    region: "eu-north-1", models: ["anthropic.claude-opus-5-5", "anthropic.claude-haiku-5-5"],
    baseURL: "https://bedrock-mantle.eu-north-1.api.aws/anthropic",
  });
  assert.equal(resolveBedrockMessagesConfiguration({ region: "eu-north-1", models: [] }), undefined);
  assert.equal(resolveBedrockMessagesConfiguration({ region: "https://attacker.test", models: ["model"] }), undefined);
  assert.equal(resolveBedrockMessagesConfiguration({ region: "us-east-1", models: ["*", "bad value"] }), undefined);
});

test("accepts only scoped ROTOXY API key or bearer credentials; rejects conflicts and admin password", async t => {
  const h = await harness(t);
  const body = JSON.stringify(requestBody);
  const endpoint = (headers = {}) => fetch(h.base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  assert.equal((await endpoint({ "x-api-key": h.invoke.token })).status, 200);
  assert.equal((await endpoint({ authorization: `Bearer ${h.invoke.token}` })).status, 200);
  assert.equal((await endpoint({ "x-api-key": h.readOnly.token })).status, 401);
  assert.equal((await endpoint({ "x-api-key": "temporary-bedrock-test-admin-password" })).status, 401);
  const conflict = await endpoint({ "x-api-key": h.invoke.token, authorization: `Bearer ${h.invoke.token}` });
  assert.equal(conflict.status, 401);
  assert.equal(await conflict.text(), JSON.stringify({ type: "error", error: { type: "authentication_error", message: "unauthorized" } }));
});

test("honors the exact configured model allowlist and passes tools content blocks intact", async t => {
  let received;
  const h = await harness(t, {}, async (input, options) => {
    received = { input, options };
    return { id: "msg_tools", type: "message", content: [{ type: "tool_use", id: "call_1", name: "weather", input: { city: "Paris" } }], stop_reason: "tool_use" };
  });
  const body = { ...requestBody, tools: [{ name: "weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }] };
  const response = await fetch(h.base + path, { method: "POST", headers: { "x-api-key": h.invoke.token, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.deepEqual(received.input, body);
  assert.equal(received.options.signal instanceof AbortSignal, true);
  assert.deepEqual((await response.json()).content[0], { type: "tool_use", id: "call_1", name: "weather", input: { city: "Paris" } });

  const denied = await fetch(h.base + path, { method: "POST", headers: { authorization: `Bearer ${h.invoke.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...requestBody, model: "anthropic.claude-opus-5-5" }) });
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error.message, "model_not_allowed");
});

test("uses a bounded one-shot SDK call and sanitizes upstream errors", async t => {
  let calls = 0;
  const h = await harness(t, { timeoutMs: 2000 }, async () => { calls++; throw new Error("AWS secret/credentials/private-prompt must not leak"); });
  assert.deepEqual(h.created, [{ region: "eu-north-1", baseURL: "https://bedrock-mantle.eu-north-1.api.aws/anthropic", timeoutMs: 2000, maxRetries: 0 }]);
  const response = await fetch(h.base + path, { method: "POST", headers: { authorization: `Bearer ${h.invoke.token}`, "content-type": "application/json" }, body: JSON.stringify(requestBody) });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.equal(calls, 1);
  assert.match(text, /upstream_failure/);
  assert.doesNotMatch(text, /secret|credentials|private-prompt/);
});

test("returns an explicit 503 when Bedrock is unconfigured or AWS bearer-token mode is present", async t => {
  const h = await harness(t);
  const disabled = createBedrockMessagesRouter(h.store, { clientFactory: () => { throw new Error("must not construct"); } });
  const app = express(); app.use(disabled);
  const server = createServer(app); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", headers: { authorization: `Bearer ${h.invoke.token}`, "content-type": "application/json" }, body: JSON.stringify(requestBody) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.message, "bedrock_not_configured");

  process.env.AWS_BEARER_TOKEN_BEDROCK = "must-not-be-forwarded";
  const rejected = createBedrockMessagesRouter(h.store, { region: "eu-north-1", models: [requestBody.model], clientFactory: () => { throw new Error("must not construct"); } });
  const app2 = express(); app2.use(rejected);
  const server2 = createServer(app2); await new Promise(resolve => server2.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server2.close(resolve)));
  const response2 = await fetch(`http://127.0.0.1:${server2.address().port}${path}`, { method: "POST", headers: { "x-api-key": h.invoke.token, "content-type": "application/json" }, body: JSON.stringify(requestBody) });
  assert.equal(response2.status, 503);
  assert.equal((await response2.json()).error.message, "bedrock_not_configured");
});

test("streams native Anthropic SSE event names and cancels upstream when the client disconnects", async t => {
  let upstreamSignal;
  const h = await harness(t, {}, async (_input, options) => {
    upstreamSignal = options.signal;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { id: "msg_stream", type: "message" } };
        await new Promise(resolve => upstreamSignal.addEventListener("abort", resolve, { once: true }));
      },
    };
  });
  const controller = new AbortController();
  const responsePromise = fetch(h.base + path, { method: "POST", signal: controller.signal, headers: { authorization: `Bearer ${h.invoke.token}`, "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ ...requestBody, stream: true }) });
  const response = await responsePromise;
  assert.equal(response.headers.get("content-type").split(";")[0], "text/event-stream");
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /^event: message_start\ndata: /);
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(upstreamSignal.aborted, true);
  await reader.cancel().catch(() => undefined);
});

test("closes an SSE response with a sanitized timeout error when the upstream iterator ends after abort", async t => {
  const h = await harness(t, { timeoutMs: 100 }, async (_input, options) => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message: { id: "msg_timeout", type: "message" } };
      await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
      // Some stream implementations end normally when cancelled.
    },
  }));
  const response = await fetch(h.base + path, { method: "POST", headers: { authorization: `Bearer ${h.invoke.token}`, "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ ...requestBody, stream: true }) });
  const payload = await response.text();
  assert.equal(response.status, 200, "SSE status is committed when stream headers are sent");
  assert.match(payload, /event: message_start/);
  assert.match(payload, /event: error\ndata: .*upstream_timeout/);
  assert.match(payload, /upstream_timeout/);
});

test("does not return a late non-stream success after the end-to-end deadline aborts", async t => {
  const h = await harness(t, { timeoutMs: 100 }, async (_input, options) => new Promise(resolve => {
    options.signal.addEventListener("abort", () => resolve({ id: "late", type: "message", content: [] }), { once: true });
  }));
  const response = await fetch(h.base + path, { method: "POST", headers: { authorization: `Bearer ${h.invoke.token}`, "content-type": "application/json" }, body: JSON.stringify(requestBody) });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.message, "upstream_timeout");
});

test("bounds request bodies and concurrent active Messages requests", async t => {
  let release;
  let calls = 0;
  const h = await harness(t, { maxConcurrency: 1, maxBodyBytes: 4096 }, async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return { id: "msg_wait", type: "message", content: [] };
  });
  const first = fetch(h.base + path, { method: "POST", headers: { authorization: `Bearer ${h.invoke.token}`, "content-type": "application/json" }, body: JSON.stringify(requestBody) });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const second = await fetch(h.base + path, { method: "POST", headers: { authorization: `Bearer ${h.invoke.token}`, "content-type": "application/json" }, body: JSON.stringify(requestBody) });
  assert.equal(second.status, 503);
  release();
  assert.equal((await (await first).json()).id, "msg_wait");
  assert.equal(calls, 1);
  const oversized = await fetch(h.base + path, { method: "POST", headers: { authorization: `Bearer ${h.invoke.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...requestBody, messages: [{ role: "user", content: "x".repeat(5000) }] }) });
  assert.equal(oversized.status, 413);
});

test("rejects output-token requests above the trusted operator cap before invoking Bedrock", async t => {
  let calls = 0;
  const h = await harness(t, { maxOutputTokens: 128 }, async () => { calls++; return {}; });
  const response = await fetch(h.base + path, { method: "POST", headers: { authorization: `Bearer ${h.invoke.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...requestBody, max_tokens: 129 }) });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});
