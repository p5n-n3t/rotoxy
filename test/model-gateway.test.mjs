import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { createModelGateway } from "../dist/model-gateway.js";
import { migrateLegacyOllamaCredentials } from "../dist/model-credentials.js";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.listening ? server.close(resolve) : resolve());

test("Ollama gateway encrypts and rotates keys, enforces scoped tokens, balances accounts, and never replays", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-model-gateway-"));
  const previousConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  const previousHome = process.env.HOME;
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  process.env.HOME = join(root, "home");
  const store = new StateStore(); // Construct only after isolated config and HOME are set.
  await store.init({ adminPassword: "synthetic-admin-password" });
  const credentials = [];
  const calls = [];
  let rateLimitNext = false;
  let throwNext = false;
  let holdProvider = false;
  let holdPromise = Promise.resolve();
  let releaseHold;
  const gateway = createModelGateway(store, {
    maxInflightPerAccount: 1,
    fetch: async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.authorization, method: init.method, signal: init.signal });
      if (holdProvider) await holdPromise;
      if (throwNext) { throwNext = false; throw new Error("synthetic transport loss"); }
      if (rateLimitNext) { rateLimitNext = false; return new Response("secret-looking provider error", { status: 429 }); }
      if (String(url).endsWith("/v1/models")) return Response.json({ object: "list", data: [{ id: "gpt-oss:20b", object: "model" }] });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: {\"ok\":true}\n\n")); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "synthetic-request" } });
    },
  });
  credentials.push(await gateway.credentials.addCredential("synthetic A", "ollama-key-A-123456"));
  credentials.push(await gateway.credentials.addCredential("synthetic B", "ollama-key-B-123456"));
  const readToken = await gateway.credentials.issueToken({ scopes: ["model:read"], expiresInSeconds: 3600 });
  const invokeToken = await gateway.credentials.issueToken({ scopes: ["model:invoke"], expiresInSeconds: 3600 });
  const app = (await import("express")).default();
  app.use(gateway.router);
  const server = createServer(app);
  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await close(server);
    await rm(root, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = previousConfig;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  });

  const denied = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${readToken.token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 0, "read-only token cannot invoke the provider");

  const catalogA = await fetch(base + "/p/ollama/v1/models", { headers: { authorization: `Bearer ${readToken.token}` } });
  assert.equal(catalogA.status, 200);
  assert.equal(calls.at(-1).url, "https://ollama.com/v1/models");
  assert.equal(calls.at(-1).authorization, "Bearer ollama-key-A-123456");
  const chatB = await fetch(base + "/pool/ollama/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${invokeToken.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-oss:20b", stream: true, messages: [{ role: "user", content: "hello" }] }) });
  assert.equal(chatB.status, 200);
  assert.equal(calls.at(-1).authorization, "Bearer ollama-key-B-123456");
  assert.match(await chatB.text(), /data:/);
  assert.equal(chatB.headers.get("authorization"), null, "provider authorization is never reflected");

  holdProvider = true;
  holdPromise = new Promise((resolve) => { releaseHold = resolve; });
  const heldA = fetch(base + "/v1/models", { headers: { authorization: `Bearer ${readToken.token}` } });
  const heldB = fetch(base + "/v1/models", { headers: { authorization: `Bearer ${readToken.token}` } });
  for (let attempt = 0; attempt < 100 && calls.length < 4; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 4, "two accounts can each serve one concurrent request");
  const atCapacity = await fetch(base + "/v1/models", { headers: { authorization: `Bearer ${readToken.token}` } });
  assert.equal(atCapacity.status, 503, "local per-account cap blocks a third request while both are busy");
  holdProvider = false;
  releaseHold();
  assert.deepEqual((await Promise.all([heldA, heldB])).map((response) => response.status), [200, 200]);

  const file = await readFile(join(store.dir, "model-credentials.json"), "utf8");
  assert.equal(file.includes("ollama-key-A-123456"), false, "provider key is encrypted at rest");
  assert.equal((await stat(join(store.dir, "model-credentials.json"))).mode & 0o777, 0o600);
  await gateway.credentials.rotateCredential(credentials[0].id, "ollama-key-A-rotated-7890");
  rateLimitNext = true;
  const rateLimited = await fetch(base + "/v1/models", { headers: { authorization: `Bearer ${readToken.token}` } });
  assert.equal(rateLimited.status, 429);
  assert.equal(calls.at(-1).authorization, "Bearer ollama-key-A-rotated-7890", "rotated key takes effect without restarting");
  assert.doesNotMatch(await rateLimited.text(), /secret-looking/);
  const countAfterLimit = calls.length;
  const afterCooldown = await fetch(base + "/v1/models", { headers: { authorization: `Bearer ${readToken.token}` } });
  assert.equal(afterCooldown.status, 200);
  assert.equal(calls.length, countAfterLimit + 1, "no replay; next request selects the other eligible account");

  throwNext = true;
  const callCount = calls.length;
  const ambiguous = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${invokeToken.token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(ambiguous.status, 502);
  assert.equal(calls.length, callCount + 1, "ambiguous invocation is not retried");

  assert.equal(await gateway.credentials.authorizeToken(invokeToken.token, "model:read"), false);
  assert.equal(await gateway.credentials.authorizeToken(readToken.token, "model:read", readToken.expiresAt + 1), false, "expired model tokens are rejected");
  assert.equal(await gateway.credentials.revokeToken(invokeToken.id), true);
  assert.equal(await gateway.credentials.authorizeToken(invokeToken.token, "model:invoke"), false);
  assert.equal((await store.load()).accounts.length, 0, "Ollama keys never enter the MCP account list");
  const migrated = await migrateLegacyOllamaCredentials(gateway.credentials, { apiKeys: ["legacy-synthetic-api-key"] });
  assert.equal(migrated.imported, 1);
  assert.doesNotMatch(JSON.stringify(migrated), /legacy-synthetic-api-key/, "migration reports metadata only");
});
