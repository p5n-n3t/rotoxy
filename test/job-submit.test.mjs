import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pkceS256 } from "../dist/crypto.js";
import { StateStore } from "../dist/store.js";
import { buildApp } from "../dist/server.js";
import { JobInputError, requiredJobScope, validateJobSubmission, validateJobToolArguments } from "../dist/job-submit.js";

const ADMIN = "correct-horse-battery-staple";
const names = ["job_submit", "job_status", "job_workers", "job_results", "job_control", "job_inbox", "job_inbox_ack"];

function validJob() {
  return {
    schemaVersion: 1, jobId: "job-1", idempotencyKey: "idem-1", projectId: "project-1",
    eligibleAccountIds: ["account-a"],
    tasks: [{ taskId: "task-1", dependsOn: [], scopeKeys: ["path:src/result.txt"], instructions: "Write a short result", execution: { mode: "existing-session" }, output: { kind: "text", maxBytes: 1024, format: "plain text", expectedMarker: "DONE-1" } }],
  };
}

test("job submission validates bounded DAGs and permits a single eligible account and ordinary text output", () => {
  const accepted = validateJobSubmission(validJob());
  assert.equal(accepted.eligibleAccountIds.length, 1);
  assert.equal(accepted.tasks[0].output.kind, "text");
  const cyclic = validJob();
  cyclic.tasks[0].dependsOn = ["task-1"];
  assert.throws(() => validateJobSubmission(cyclic), JobInputError);
  const tooManyDeps = validJob();
  tooManyDeps.tasks[0].dependsOn = Array.from({ length: 9 }, (_, i) => `task-${i}`);
  assert.throws(() => validateJobSubmission(tooManyDeps), /at most 8/);
  const badPaths = validJob();
  badPaths.tasks[0].output = { kind: "coding-artifact", repositoryId: "repo", allowedPaths: [42] };
  assert.throws(() => validateJobSubmission(badPaths), /bounded text output only/);
  const noMarker = validJob();
  delete noMarker.tasks[0].output.expectedMarker;
  assert.throws(() => validateJobSubmission(noMarker), /expectedMarker/);
});

test("job scopes remain separate", () => {
  assert.equal(requiredJobScope("job_submit"), "jobs:write");
  assert.equal(requiredJobScope("job_control"), "jobs:write");
  for (const name of names.filter((name) => !["job_submit", "job_control", "job_inbox_ack"].includes(name))) assert.equal(requiredJobScope(name), "jobs:read");
  assert.equal(requiredJobScope("job_inbox_ack"), "jobs:write");
  assert.deepEqual(validateJobToolArguments("job_inbox", { projectId: "project-1", after: "opaque_cursor-A9", limit: 100 }),
    { projectId: "project-1", after: "opaque_cursor-A9", limit: 100 });
  assert.throws(() => validateJobToolArguments("job_inbox", { projectId: "project-1", after: 12 }), /opaque cursor/);
  assert.throws(() => validateJobToolArguments("job_inbox", { projectId: "project-1", after: "x".repeat(129) }), /opaque cursor/);
  assert.throws(() => validateJobToolArguments("job_inbox_ack", { projectId: "project-1", eventId: "repo:0" }), /event ID/);
});

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

async function oauthToken(base, scope) {
  const registration = await (await fetch(base + "/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "job-test", redirect_uris: [base + "/callback"] }),
  })).json();
  const verifier = "v".repeat(64);
  const consent = await fetch(base + "/oauth/authorize", {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: registration.client_id, redirect_uri: base + "/callback", response_type: "code", code_challenge: pkceS256(verifier), code_challenge_method: "S256", resource: base + "/mcp", scope, admin_password: ADMIN }),
  });
  const location = consent.headers.get("location");
  if (!location) throw new Error(`OAuth consent failed (${consent.status}): ${await consent.text()}`);
  const code = new URL(location).searchParams.get("code");
  const token = await (await fetch(base + "/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, redirect_uri: base + "/callback", code, code_verifier: verifier, resource: base + "/mcp" }),
  })).json();
  return token.access_token;
}

function mcp(base, token, message) {
  return fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(message) });
}

test("job tools are scope-filtered and intercepted before upstream while ordinary MCP calls still proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-jobs-"));
  const upstreamCalls = [];
  const upstream = createHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString());
      upstreamCalls.push(message);
      const result = message.method === "tools/list" ? { tools: [{ name: "ordinary", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: "ordinary upstream result" }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  let gateway;
  const previousConfigDir = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;
  try {
    const upstreamAddress = await listen(upstream);
    const store = new StateStore();
    await store.init({ adminPassword: ADMIN });
    let delegated;
    let delegateCalls = 0;
    const backend = { callTool: async (name, args, caller) => { delegateCalls++; delegated = { name, args, caller }; return { jobId: args.jobId, state: "queued", taskCount: args.tasks.length, revision: 1 }; } };
    const built = await buildApp(store, { supervisorBackend: backend });
    gateway = createHttpServer(built.app);
    const address = await listen(gateway);
    const base = `http://127.0.0.1:${address.port}`;
    await store.update((state) => {
      state.config.publicBaseUrl = base;
      state.config.basePath = "";
      state.config.upstreamUrl = "";
    });
    await store.addAccount({ label: "Test account", token: "test-secret" });
    const legacy = await oauthToken(base, "mcp");
    const readOnly = await oauthToken(base, "mcp jobs:read");
    const writer = await oauthToken(base, "mcp jobs:read jobs:write");

    const beforeDenied = upstreamCalls.length;
    const denied = await mcp(base, legacy, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "job_submit", arguments: validJob() } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.data.requiredScope, "jobs:write");
    assert.equal(upstreamCalls.length, beforeDenied, "unauthorized local tool calls never fall through");
    const deniedAck = await mcp(base, readOnly, { jsonrpc: "2.0", id: 9, method: "tools/call",
      params: { name: "job_inbox_ack", arguments: { projectId: "project-1", eventId: "repo:1" } } });
    assert.equal(deniedAck.status, 403, "read-only job scope cannot acknowledge inbox events");
    assert.equal((await deniedAck.json()).error.data.requiredScope, "jobs:write");
    const legacyListing = await mcp(base, legacy, { jsonrpc: "2.0", id: 5, method: "tools/list" });
    assert.equal(legacyListing.status, 503, "clients without job scopes still need a configured upstream");
    assert.deepEqual(upstreamCalls, [], "unconfigured gateway makes no upstream network request");

    const initialized = await mcp(base, readOnly, { jsonrpc: "2.0", id: "init", method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    assert.equal(initialized.status, 200);
    const initResult = (await initialized.json()).result;
    assert.equal(initResult.protocolVersion, "2025-03-26");
    assert.deepEqual(initResult.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(initResult.serverInfo, { name: "ROTOXY", version: "0.2.0" });
    const initializedNotice = await mcp(base, readOnly, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(initializedNotice.status, 204);

    const listing = await mcp(base, readOnly, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = (await listing.json()).result.tools.map((tool) => tool.name);
    assert.deepEqual(listed, ["job_status", "job_workers", "job_results", "job_inbox"]);
    assert.ok(!listed.includes("job_submit") && !listed.includes("job_control") && !listed.includes("job_inbox_ack"));
    const writerListing = await mcp(base, writer, { jsonrpc: "2.0", id: 6, method: "tools/list" });
    assert.deepEqual((await writerListing.json()).result.tools.map((tool) => tool.name), names);

    const accepted = await mcp(base, writer, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "job_submit", arguments: validJob() } });
    assert.equal(accepted.status, 200);
    assert.equal(delegated.name, "job_submit");
    assert.equal(delegated.args.eligibleAccountIds[0], "account-a");
    assert.equal(delegated.args.idempotencyKey, "idem-1");
    assert.equal(delegateCalls, 1, "the local gateway delegates exactly once");
    assert.match(JSON.parse((await accepted.json()).result.content[0].text).state, /queued/);
    assert.equal(upstreamCalls.filter((message) => message.method === "tools/call").length, 0);

    const ordinaryWithoutUpstream = await mcp(base, writer, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ordinary", arguments: {} } });
    assert.equal(ordinaryWithoutUpstream.status, 503);
    assert.deepEqual(upstreamCalls, [], "local discovery and job calls never touch upstream");

    await store.update((state) => { state.config.upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}/mcp`; });
    const legacyWithUpstream = await mcp(base, legacy, { jsonrpc: "2.0", id: 8, method: "tools/list" });
    assert.deepEqual((await legacyWithUpstream.json()).result.tools.map((tool) => tool.name), ["ordinary"], "legacy consent gains no job scopes");

    const ordinary = await mcp(base, writer, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ordinary", arguments: {} } });
    assert.match((await ordinary.json()).result.content[0].text, /ordinary upstream result/);
    assert.equal(upstreamCalls.at(-1).params.name, "ordinary");
  } finally {
    if (gateway) await close(gateway);
    await close(upstream);
    if (previousConfigDir === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR;
    else process.env.TOKEN2OAUTH_CONFIG_DIR = previousConfigDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Oracle tools require explicit opt-in, enforce scopes, and pass the authenticated caller", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-oracle-gateway-"));
  const previous = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.TOKEN2OAUTH_CONFIG_DIR = dir;
  const calls = [];
  const store = new StateStore();
  await store.init({ adminPassword: ADMIN });
  const built = await buildApp(store, { oracleTools: { call: async (name, args, caller) => { calls.push({name, args, caller}); return { jobId: args.jobId, state: "queued" }; } } });
  const server = createHttpServer(built.app);
  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await close(server); await rm(dir, {recursive:true,force:true}); if(previous===undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR=previous; });
  await store.update(state => { state.config.publicBaseUrl=base; state.config.basePath=""; state.config.upstreamUrl=""; });
  const reader = await oauthToken(base, "mcp jobs:read");
  const writer = await oauthToken(base, "mcp jobs:read jobs:write");
  const list = await (await mcp(base, reader, {jsonrpc:"2.0",id:1,method:"tools/list"})).json();
  assert.ok(list.result.tools.some(tool => tool.name === "oracle_catalog"));
  assert.ok(!list.result.tools.some(tool => tool.name === "oracle_submit"));
  const message = {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"oracle_submit",arguments:{jobId:"sample",prompt:"Return OK"}}};
  assert.equal((await mcp(base,reader,message)).status,403);
  assert.equal(calls.length,0);
  const response = await mcp(base,writer,message);
  assert.equal(response.status,200);
  assert.equal(calls[0].name,"oracle_submit");
  assert.ok(calls[0].caller);
  assert.equal(JSON.parse((await response.json()).result.content[0].text).state,"queued");
});
