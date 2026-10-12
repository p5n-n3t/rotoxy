import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate HOME/config before constructing any stateful application object.
const isolatedHome = await mkdtemp(join(tmpdir(), "t2o-codex-profile-home-"));
process.env.HOME = isolatedHome;
process.env.TOKEN2OAUTH_CONFIG_DIR = join(isolatedHome, "config");
const { CodexProfiles, CODEX_APP_SERVER_ARGS, renderCodexProfilesPage } = await import("../dist/codex-profiles.js");

async function harness(t, responder = () => ({})) {
  const root = await mkdtemp(join(tmpdir(), "t2o-codex-profile-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "codex");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(binary, 0o700);
  const calls = [], transports = [];
  const profiles = new CodexProfiles({ codexBinary: binary, configDir: join(root, "config"), maxInFlight: 2, transportFactory: (_binary, dir) => {
    const transport = {
      async request(method, params = {}) { calls.push({ id: dir.split("/").at(-1), method, params }); return responder(dir.split("/").at(-1), method, params); },
      notify(method, params) { calls.push({ method, params, notification: true }); },
      onNotification(listener) { this.listener = listener; return () => {}; },
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
