import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate HOME/config before constructing any stateful application object.
const isolatedHome = await mkdtemp(join(tmpdir(), "t2o-codex-profile-home-"));
process.env.HOME = isolatedHome;
process.env.TOKEN2OAUTH_CONFIG_DIR = join(isolatedHome, "config");
const { CodexProfiles, StdioCodexTransport, CODEX_APP_SERVER_ARGS, renderCodexProfilesPage } = await import("../dist/codex-profiles.js");

async function harness(t, responder = () => ({}), configure = () => ({})) {
  const root = await mkdtemp(join(tmpdir(), "t2o-codex-profile-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "codex");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(binary, 0o700);
  const calls = [], transports = [];
  const profiles = new CodexProfiles({ codexBinary: binary, configDir: join(root, "config"), maxInFlight: 2, ...configure(root), transportFactory: (_binary, dir) => {
    const transport = {
      async request(method, params = {}) { calls.push({ id: dir.split("/").at(-1), method, params }); return responder(dir.split("/").at(-1), method, params, this); },
      notify(method, params) { calls.push({ method, params, notification: true }); },
      onNotification(listener) { this.listener = listener; return () => {}; },
      onServerRequest(listener) { this.serverListener = listener; return () => {}; },
      async respond(id, result) { this.responses ??= []; this.responses.push({ id, result }); },
      async close() { this.closed = true; },
    };
    transports.push(transport); return transport;
  } });
  t.after(() => profiles.close());
  return { profiles, root, calls, transports };
}

test.after(async () => { await rm(isolatedHome, { recursive: true, force: true }); });

test("registers isolated private CODEX_HOME profiles and persists only non-secret metadata", async (t) => {
  const h = await harness(t);
  const a = await h.profiles.registerProfile("Work <one>");
  const b = await h.profiles.registerProfile("Personal");
  assert.notEqual(a.profileDir, b.profileDir);
  assert.equal((await readdir(a.profileDir)).length, 0);
  assert.equal((await (await import("node:fs/promises")).stat(a.profileDir)).mode & 0o777, 0o700);
  const raw = await readFile(join(h.root, "config", "codex-profiles.json"), "utf8");
  assert.deepEqual(Object.keys(JSON.parse(raw).profiles[0]).sort(), ["createdAt", "id", "label", "profileDir", "updatedAt"]);
  assert.doesNotMatch(raw, /auth\.json|accessToken|refreshToken|secret/i);
  assert.match(renderCodexProfilesPage([a]), /Work &lt;one&gt;/);
  assert.match(renderCodexProfilesPage([a]), /Not checked/);
  assert.match(renderCodexProfilesPage([a]), /Sign-in &amp; reported plan/);
  assert.doesNotMatch(renderCodexProfilesPage([a]), /Work <one>/);
});

test("uses official app-server methods, filters snapshots and only reports the user-mediated device code", async (t) => {
  const h = await harness(t, (_id, method) => {
    if (method === "account/login/start") return { type: "chatgptDeviceCode", loginId: "login-123", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234", accessToken: "must-not-leak" };
    if (method === "account/read") return { account: { type: "chatgpt", planType: "plus", email: "private@example.test" }, accessToken: "never-return" };
    if (method === "model/list") return { data: [{ id: "gpt-6-luna", name: "Luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }, { id: "hidden", hidden: true }] };
    if (method === "account/rateLimits/read") return { rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: null } } };
    return {};
  });
  const profile = await h.profiles.registerProfile("Subscription");
  const prompt = await h.profiles.startDeviceLogin(profile.id);
  assert.deepEqual(prompt, { verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });
  assert.equal(h.profiles.getDeviceLoginState(profile.id), "pending");
  const snapshot = await h.profiles.refreshProfile(profile.id);
  assert.equal(snapshot.authMode, "chatgpt"); assert.equal(snapshot.planType, "plus");
  assert.deepEqual(snapshot.models.map((model) => model.id), ["gpt-6-luna"]);
  assert.deepEqual(snapshot.rateWindows.map(({ limitId, slot, windowDurationMins, usedPercent }) => ({ limitId, slot, windowDurationMins, usedPercent })), [{ limitId: "codex", slot: "primary", windowDurationMins: 300, usedPercent: 25 }]);
  assert.deepEqual(await h.profiles.eligibleProfiles("gpt-6-luna"), [profile.id]);
  assert.equal(JSON.stringify({ prompt, snapshot }).includes("never-return"), false);
  assert.equal(JSON.stringify({ prompt, snapshot }).includes("private@example.test"), false);
  assert.deepEqual(h.calls.filter((c) => ["initialize", "account/login/start", "account/read", "model/list", "account/rateLimits/read"].includes(c.method)).map((c) => c.method), ["initialize", "account/login/start", "account/read", "model/list", "account/rateLimits/read"]);
  assert.deepEqual(h.calls.find((c) => c.method === "account/login/start").params, { type: "chatgptDeviceCode" });
  assert.ok(h.calls.some((c) => c.notification && c.method === "initialized"));
  assert.deepEqual([...CODEX_APP_SERVER_ARGS], ["app-server", "--stdio"]);
});

test("unknown quota, API-key auth, absent model, and stale snapshots are not candidates", async (t) => {
  const h = await harness(t, (id, method) => {
    if (method === "account/read") return { authMode: id === hIds.api ? "apikey" : "chatgpt" };
    if (method === "model/list") return { data: [{ id: "model-a" }] };
    if (method === "account/rateLimits/read") return id === hIds.unknown ? { rateLimits: {} } : { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 } } };
    return {};
  });
  const unknown = await h.profiles.registerProfile("Unknown quota");
  const exhausted = await h.profiles.registerProfile("Exhausted");
  const api = await h.profiles.registerProfile("API key");
  const [u, e, a] = [unknown, exhausted, api];
  hIds.unknown = u.id; hIds.api = a.id;
  await Promise.all([u, e, a].map((p) => h.profiles.refreshProfile(p.id)));
  assert.deepEqual(await h.profiles.eligibleProfiles("model-a"), []);
  assert.deepEqual(await h.profiles.eligibleProfiles("missing-model"), []);
  assert.deepEqual(await h.profiles.eligibleProfiles("model-a", -1), []);
});

const hIds = {};

test("ranks new-session candidates by the most-used window without changing existing ownership", async (t) => {
  const usage = new Map();
  const h = await harness(t, (id, method) => {
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "model/list") return { data: [{ id: "model-a" }] };
    if (method === "account/rateLimits/read") {
      const [primary, secondary] = usage.get(id);
      return { rateLimits: { primary: { usedPercent: primary }, secondary: { usedPercent: secondary } } };
    }
    return {};
  });
  const nearlyWeeklyLimited = await h.profiles.registerProfile("Low five-hour usage, high weekly usage");
  const healthy = await h.profiles.registerProfile("More headroom");
  const equallyHealthy = await h.profiles.registerProfile("Same headroom");
  usage.set(nearlyWeeklyLimited.id, [1, 95]);
  usage.set(healthy.id, [30, 40]);
  usage.set(equallyHealthy.id, [40, 30]);
  for (const p of [nearlyWeeklyLimited, healthy, equallyHealthy]) await h.profiles.refreshProfile(p.id);
  await h.profiles.bindThread("existing-thread", nearlyWeeklyLimited.id);
  assert.deepEqual(await h.profiles.eligibleProfiles("model-a"), [...[healthy.id, equallyHealthy.id].sort(), nearlyWeeklyLimited.id]);
  assert.equal(await h.profiles.profileForThread("existing-thread"), nearlyWeeklyLimited.id);
  assert.deepEqual(await h.profiles.eligibleProfiles("model-a", NaN), []);
  assert.deepEqual(await h.profiles.eligibleProfiles("model-a", Infinity), []);
  assert.equal(h.calls.some(c => c.method === "thread/start" || c.method === "turn/start"), false);
});

test("persists thread ownership and refuses cross-profile resume; never chooses a profile implicitly", async (t) => {
  const h = await harness(t); const first = await h.profiles.registerProfile("One"); const second = await h.profiles.registerProfile("Two");
  assert.deepEqual(await h.profiles.eligibleProfiles("any-model"), []);
  await h.profiles.bindThread("thread-123", first.id);
  await assert.rejects(h.profiles.bindThread("thread-123", second.id), /belongs to another profile/);
  const reopened = new CodexProfiles({ codexBinary: join(h.root, "codex"), configDir: join(h.root, "config"), transportFactory: () => { throw new Error("must not start"); } });
  assert.equal(await reopened.profileForThread("thread-123"), first.id);
  assert.equal((await reopened.listProfiles()).length, 2);
  await reopened.close();
});

test("Codex execution pins an eligible profile, persists ownership before turn start, and leaves approvals pending", async (t) => {
  let ownerProfileId, expectedCwd;
  const h = await harness(t, async (_id, method, params, transport) => {
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "model/list") return { data: [{ id: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] };
    if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } };
    if (method === "thread/start") return { model: "model-a", thread: { id: "thread-exec-1" } };
    if (method === "turn/start") {
      const owners = JSON.parse(await readFile(join(h.root, "config", "codex-thread-owners.json"), "utf8")).owners;
      assert.equal(owners[params.threadId], ownerProfileId, "thread/profile binding is durable before turn launch");
      assert.equal(params.effort, "medium");
      assert.equal(params.model, "model-a");
      assert.equal(params.cwd, expectedCwd);
      assert.equal(params.approvalPolicy, "on-request");
      assert.deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: false });
      assert.deepEqual(params.input, [{ type: "text", text: "Make the bounded change." }]);
      transport.serverListener({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: params.threadId, turnId: "turn-exec-1", command: "npm test" } });
      transport.listener("item/agentMessage/delta", { threadId: params.threadId, turnId: "turn-exec-1", delta: "Work " });
      transport.listener("item/agentMessage/delta", { threadId: params.threadId, turnId: "turn-exec-1", delta: "completed." });
      transport.listener("turn/completed", { threadId: params.threadId, turn: { id: "turn-exec-1", status: "completed" } });
      return { turn: { id: "turn-exec-1" } };
    }
    return {};
  }, root => ({ allowedExecutionCwds: [join(root, "project")] }));
  const profile = await h.profiles.registerProfile("Execution target");
  const originProfile = await h.profiles.registerProfile("Caller origin");
  ownerProfileId = profile.id;
  const cwd = join(h.root, "project"); await (await import("node:fs/promises")).mkdir(cwd);
  expectedCwd = cwd;
  const handle = h.profiles.startExecution({
    profileId: profile.id, cwd, modelId: "model-a", reasoningEffort: "medium", prompt: "Make the bounded change.",
    origin: { callerId: "mcp-client-1", protectedProfileIds: [originProfile.id] }, timeoutMs: 5000,
  });
  const result = await handle.promise;
  assert.equal(result.profileId, profile.id);
  assert.equal(result.threadId, "thread-exec-1");
  assert.equal(result.turnId, "turn-exec-1");
  assert.equal(result.text, "Work completed.");
  assert.equal(result.status, "completed");
  assert.deepEqual(handle.pendingRequests.map(({ id, method }) => ({ id, method })), [{ id: "approval-1", method: "item/commandExecution/requestApproval" }]);
  assert.equal(h.transports[0].responses, undefined, "execution groundwork does not approve or deny server requests");
  const start = h.calls.find(call => call.method === "thread/start");
  assert.equal(start.params.approvalPolicy, "on-request");
  assert.equal(start.params.sandbox, "read-only");
  assert.equal(h.calls.some(call => call.method === "turn/interrupt"), false);
});

test("Codex execution rejects protected-origin target and unowned thread without starting a turn", async (t) => {
  const h = await harness(t, (_id, method) => {
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "model/list") return { data: [{ id: "model-a", supportedReasoningEfforts: ["medium"] }] };
    if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 1 } } };
    return {};
  }, root => ({ allowedExecutionCwds: [join(root, "project")] }));
  const profile = await h.profiles.registerProfile("Target");
  const cwd = join(h.root, "project"); await (await import("node:fs/promises")).mkdir(cwd);
  const base = { profileId: profile.id, cwd, modelId: "model-a", reasoningEffort: "medium", prompt: "Run", origin: { callerId: "caller-a", protectedProfileIds: [profile.id] } };
  await assert.rejects(h.profiles.startExecution(base).promise, /invalid_request/);
  await assert.rejects(h.profiles.startExecution({ ...base, origin: { callerId: "caller-a", protectedProfileIds: ["11111111-1111-4111-8111-111111111111"] }, threadId: "foreign-thread" }).promise, /thread_ownership/);
  assert.equal(h.calls.some(call => call.method === "turn/start"), false);
});

test("Codex cancellation interrupts only the profile-owned active turn and reports ambiguity", async (t) => {
  const h = await harness(t, (_id, method, params) => {
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "model/list") return { data: [{ id: "model-a", supportedReasoningEfforts: ["medium"] }] };
    if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 1 } } };
    if (method === "thread/resume") return { model: "model-a", thread: { id: params.threadId } };
    if (method === "turn/start") return { turn: { id: "turn-owned" } };
    if (method === "turn/interrupt") return { turn: { id: params.turnId, status: "interrupted" } };
    return {};
  }, root => ({ allowedExecutionCwds: [join(root, "project")] }));
  const profile = await h.profiles.registerProfile("Target");
  const cwd = join(h.root, "project"); await (await import("node:fs/promises")).mkdir(cwd);
  await h.profiles.bindThread("owned-thread", profile.id);
  const handle = h.profiles.startExecution({
    profileId: profile.id, cwd, modelId: "model-a", reasoningEffort: "medium", prompt: "Wait",
    threadId: "owned-thread", origin: { callerId: "caller-a", protectedProfileIds: ["11111111-1111-4111-8111-111111111111"] }, timeoutMs: 5000,
  });
  for (let i = 0; i < 50 && !h.calls.some(call => call.method === "turn/start"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  await handle.cancel();
  await assert.rejects(handle.promise, /turn_outcome_ambiguous/);
  const resumed = h.calls.find(call => call.method === "thread/resume");
  assert.deepEqual(resumed.params, { threadId: "owned-thread", model: "model-a", cwd, approvalPolicy: "on-request", sandbox: "read-only" });
  assert.deepEqual(h.calls.filter(call => call.method === "turn/interrupt").map(call => call.params), [{ threadId: "owned-thread", turnId: "turn-owned" }]);
});

test("Codex turn timeout interrupts the owned turn and never retries an ambiguous launch", async (t) => {
  const h = await harness(t, (_id, method, params) => {
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "model/list") return { data: [{ id: "model-a", supportedReasoningEfforts: ["medium"] }] };
    if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 1 } } };
    if (method === "thread/start") return { model: "model-a", thread: { id: "timeout-thread" } };
    if (method === "turn/start") return { turn: { id: "timeout-turn" } };
    if (method === "turn/interrupt") return { turn: { id: params.turnId, status: "interrupted" } };
    return {};
  }, root => ({ allowedExecutionCwds: [join(root, "project")] }));
  const profile = await h.profiles.registerProfile("Target");
  const cwd = join(h.root, "project"); await (await import("node:fs/promises")).mkdir(cwd);
  const handle = h.profiles.startExecution({
    profileId: profile.id, cwd, modelId: "model-a", reasoningEffort: "medium", prompt: "Wait",
    origin: { callerId: "caller-a", protectedProfileIds: ["11111111-1111-4111-8111-111111111111"] }, timeoutMs: 1000,
  });
  await assert.rejects(handle.promise, /turn_outcome_ambiguous/);
  assert.equal(h.calls.filter(call => call.method === "turn/start").length, 1);
  assert.deepEqual(h.calls.filter(call => call.method === "turn/interrupt").map(call => call.params), [{ threadId: "timeout-thread", turnId: "timeout-turn" }]);
});

test("rejects command names, non-Codex binaries and path traversal IDs", async (t) => {
  const h = await harness(t);
  assert.throws(() => new CodexProfiles({ codexBinary: "codex", configDir: h.root }), /absolute path/);
  assert.throws(() => new CodexProfiles({ codexBinary: join(h.root, "evil"), configDir: h.root }), /Codex binary/);
  await assert.rejects(h.profiles.startDeviceLogin("../../outside"), /not found/);
});

test("real stdio launcher uses only fixed argv and a private CODEX_HOME without API-key environment leakage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-codex-stdio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "codex");
  const script = `#!/usr/bin/env node
const fs = require("node:fs"); const path = require("node:path"); const readline = require("node:readline");
fs.writeFileSync(path.join(process.env.CODEX_HOME, "launcher-check.json"), JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME, leakedKey: process.env.OPENAI_API_KEY || null }));
readline.createInterface({ input: process.stdin }).on("line", (line) => { const req = JSON.parse(line); if (req.id !== undefined) { const result = req.method === "account/login/start" ? { loginId: "l1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" } : {}; process.stdout.write(JSON.stringify({ id: req.id, result }) + "\\n"); } });
`;
  await writeFile(binary, script, { mode: 0o700 }); await chmod(binary, 0o700);
  const profiles = new CodexProfiles({ codexBinary: binary, configDir: join(root, "config") });
  t.after(() => profiles.close());
  const profile = await profiles.registerProfile("Launcher check");
  const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-only-secret-sentinel";
  try { assert.equal((await profiles.startDeviceLogin(profile.id)).userCode, "ABCD-1234"); }
  finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
  const childEnv = JSON.parse(await readFile(join(profile.profileDir, "launcher-check.json"), "utf8"));
  assert.deepEqual(childEnv.args, ["app-server", "--stdio"]);
  assert.equal(childEnv.home, profile.profileDir);
  assert.equal(childEnv.leakedKey, null);
});

test("App Server stdio distinguishes requests, responses, and notifications with one-shot opaque-ID replies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-codex-rpc-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "codex");
  const log = join(root, "stdin.jsonl");
  const script = `#!/usr/bin/env node
const fs=require("node:fs"); const readline=require("node:readline");
readline.createInterface({input:process.stdin}).on("line",line=>{
 const req=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)},line+"\\n");
 if(req.method==="initialize"){
  process.stdout.write(JSON.stringify({id:String(req.id),result:{wrongType:true}})+"\\n");
  process.stdout.write(JSON.stringify({method:"account/updated",params:{available:true}})+"\\n");
  process.stdout.write(JSON.stringify({id:"opaque/request:1",method:"item/commandExecution/requestApproval",params:{command:"npm test"}})+"\\n");
  process.stdout.write(JSON.stringify({id:"opaque/request:2",method:"item/fileChange/requestApproval",params:{path:"src/a.ts"}})+"\\n");
  process.stdout.write(JSON.stringify({id:req.id,result:{initialized:true}})+"\\n");
 }
});
`;
  await writeFile(binary, script, { mode: 0o700 }); await chmod(binary, 0o700);
  const transport = new StdioCodexTransport(binary, root, 1);
  t.after(() => transport.close());
  let notification;
  let serverRequest;
  const notified = new Promise(resolve => { notification = resolve; });
  const requested = new Promise(resolve => { serverRequest = resolve; });
  transport.onNotification((method, params) => notification({ method, params }));
  transport.onServerRequest((request) => serverRequest(request));
  assert.deepEqual(await transport.request("initialize"), { initialized: true }, "string response IDs do not resolve numeric client requests");
  assert.deepEqual(await notified, { method: "account/updated", params: { available: true } });
  const incoming = await requested;
  assert.equal(incoming.id, "opaque/request:1");
  assert.equal(incoming.method, "item/commandExecution/requestApproval");
  assert.deepEqual(incoming.params, { command: "npm test" });

  await transport.respond(incoming.id, { decision: "decline" });
  await assert.rejects(transport.respond(incoming.id, { decision: "accept" }), /unknown or already answered/);
  await assert.rejects(transport.respond({ unsafe: true }, {}), /ID is invalid/);
  await assert.rejects(transport.respond("not-pending", {}), /unknown or already answered/);
  const writes = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const replies = writes.filter(message => message.id === "opaque/request:1");
  assert.deepEqual(replies, [{ id: "opaque/request:1", result: { decision: "decline" } }]);
  assert.deepEqual(writes.find(message => message.id === "opaque/request:2"), {
    id: "opaque/request:2", error: { code: -32000, message: "Codex App Server request limit reached" },
  });
  assert.equal(writes.filter(message => message.method === "initialize").length, 1);
});
