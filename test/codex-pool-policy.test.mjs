import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedHome = await mkdtemp(join(tmpdir(), "rotoxy-codex-policy-home-"));
process.env.HOME = isolatedHome;
process.env.ROTOXY_CONFIG_DIR = join(isolatedHome, "config");
const [{ StateStore }, { CodexPoolPolicyStore, CODEX_POOL_POLICY_FILE, codexProfileFitsTask }] = await Promise.all([
  import("../dist/store.js"), import("../dist/codex-pool-policy.js"),
]);

const externalOrigin = { resolved: true, protectedProfileIds: [] };

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function harness(t, ids = [id(1), id(2), id(3)]) {
  const home = await mkdtemp(join(tmpdir(), "rotoxy-codex-policy-case-"));
  const previous = { HOME: process.env.HOME, config: process.env.ROTOXY_CONFIG_DIR };
  process.env.HOME = home;
  process.env.ROTOXY_CONFIG_DIR = join(home, "config");
  const store = new StateStore();
  await store.init({ adminPassword: "test-only-password" });
  await writeFile(join(store.dir, "codex-profiles.json"), JSON.stringify({ version: 1, profiles: ids.map((id) => ({ id })) }), { mode: 0o600 });
  const policy = new CodexPoolPolicyStore(store);
  t.after(async () => {
    process.env.HOME = previous.HOME;
    process.env.ROTOXY_CONFIG_DIR = previous.config;
    await rm(home, { recursive: true, force: true });
  });
  return { home, store, policy, ids };
}

test.after(async () => { await rm(isolatedHome, { recursive: true, force: true }); });

test("Free workers are economical routine candidates, and all workers require fresh quota and exact effort support", () => {
  const now = Date.now();
  const snapshot = { profileId:id(1), capturedAt:now, authMode:'chatgpt', planType:'free',
    models:[{id:'gpt-6-luna',reasoningEfforts:['medium']},{id:'gpt-6-astra',reasoningEfforts:['high']}],
    rateWindows:[{limitId:'codex',slot:'primary',usedPercent:0,exhausted:false}] };
  assert.equal(codexProfileFitsTask(snapshot,{modelId:'gpt-6-luna',complexity:'routine'},now),true);
  assert.equal(codexProfileFitsTask(snapshot,{modelId:'gpt-6-astra',complexity:'complex'},now),false);
  assert.equal(codexProfileFitsTask(snapshot,{modelId:'gpt-6-luna',complexity:'complex'},now),false);
  assert.equal(codexProfileFitsTask({...snapshot,planType:'plus'},{modelId:'gpt-6-astra',complexity:'complex',reasoningEffort:'high'},now),true);
  assert.equal(codexProfileFitsTask({...snapshot,planType:'plus'},{modelId:'gpt-6-astra',complexity:'complex',reasoningEffort:'max'},now),false);
  assert.equal(codexProfileFitsTask({...snapshot,capturedAt:now-300001},{modelId:'gpt-6-luna',complexity:'routine'},now),false);
  assert.equal(codexProfileFitsTask({...snapshot,rateWindows:[{...snapshot.rateWindows[0],usedPercent:100,exhausted:true}]},{modelId:'gpt-6-luna',complexity:'routine'},now),false);
});

test("defaults to globally disabled dispatch and private per-profile limits", async (t) => {
  const h = await harness(t);
  const initial = await h.policy.read();
  assert.equal(initial.dispatchEnabled, false);
  assert.equal(initial.protectInitiatingAccount, true);
  assert.deepEqual(initial.profiles, h.ids.map((profileId) => ({ profileId, enabled: true, maxConcurrent: 1 })));
  assert.deepEqual(await h.policy.eligibleCandidates(h.ids, { [h.ids[0]]: 0, [h.ids[1]]: 0, [h.ids[2]]: 0 }, externalOrigin), []);
  const file = join(h.store.dir, CODEX_POOL_POLICY_FILE);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const serialized = await readFile(file, "utf8");
  assert.doesNotMatch(serialized, /accessToken|refreshToken|secret|credential/i);
});

test("excludes the protected orchestrator profile and preserves quota-ranked order", async (t) => {
  const h = await harness(t);
  await h.policy.configure({
    version: 1,
    dispatchEnabled: true,
    protectInitiatingAccount: true,
    profiles: h.ids.map((profileId) => ({ profileId, enabled: true, maxConcurrent: 1 })),
  });
  const ranked = [h.ids[2], h.ids[1], h.ids[0]];
  assert.deepEqual(await h.policy.eligibleCandidates(ranked, { [h.ids[0]]: 0, [h.ids[1]]: 0, [h.ids[2]]: 0 }, { resolved: true, protectedProfileIds: [h.ids[1]] }), [h.ids[2], h.ids[0]]);
  assert.deepEqual(await h.policy.eligibleCandidates(ranked, {}, { resolved: true, protectedProfileIds: [h.ids[2]] }), [h.ids[1], h.ids[0]]);
  assert.deepEqual(await h.policy.eligibleCandidates(ranked, {}, { resolved: false, protectedProfileIds: [] }), []);
  await assert.rejects(h.policy.eligibleCandidates(ranked, {}, undefined), /origin_context_invalid/);
  await assert.rejects(h.policy.eligibleCandidates(ranked, {}, { resolved: true, protectedProfileIds: [id(99)] }), /origin_profile_stale/);
});

test("disabled profiles and profiles at their configured concurrency are excluded", async (t) => {
  const h = await harness(t);
  await h.policy.configure({
    version: 1,
    dispatchEnabled: true,
    protectInitiatingAccount: true,
    profiles: [
      { profileId: h.ids[0], enabled: false, maxConcurrent: 2 },
      { profileId: h.ids[1], enabled: true, maxConcurrent: 2 },
      { profileId: h.ids[2], enabled: true, maxConcurrent: 1 },
    ],
  });
  assert.deepEqual(await h.policy.eligibleCandidates(h.ids, { [h.ids[0]]: 0, [h.ids[1]]: 1, [h.ids[2]]: 1 }, externalOrigin), [h.ids[1]]);
  await assert.rejects(h.policy.eligibleCandidates(h.ids, undefined, externalOrigin), /capacity_required/);
});

test("rejects stale profile identifiers in policy and candidate input", async (t) => {
  const h = await harness(t, [id(1)]);
  await assert.rejects(h.policy.configure({
    version: 1, dispatchEnabled: true, protectInitiatingAccount: true,
    profiles: [{ profileId: id(99), enabled: true, maxConcurrent: 1 }],
  }), /stale_profile/);
  await assert.rejects(h.policy.eligibleCandidates([id(99)], { [id(1)]: 0 }, externalOrigin), /candidate_profile_invalid/);
  const file = join(h.store.dir, CODEX_POOL_POLICY_FILE);
  await writeFile(file, JSON.stringify({
    version: 1, dispatchEnabled: true, protectInitiatingAccount: true,
    profiles: [{ profileId: id(99), enabled: true, maxConcurrent: 1 }],
  }), { mode: 0o600 });
  await assert.rejects(h.policy.read(), /stale_profile/);
});

test("validates profile concurrency limits and strict policy fields", async (t) => {
  const h = await harness(t, [id(1)]);
  const configure = (maxConcurrent) => h.policy.configure({
    version: 1, dispatchEnabled: true, protectInitiatingAccount: true,
    profiles: [{ profileId: id(1), enabled: true, maxConcurrent }],
  });
  for (const invalid of [0, -1, 1.5, 17, true, "2"]) await assert.rejects(configure(invalid), /policy_invalid/);
  await assert.rejects(h.policy.configure({ version: 1, dispatchEnabled: true, protectInitiatingAccount: true, profiles: [{ profileId: id(1), enabled: true, maxConcurrent: 1, token: "unexpected" }] }), /policy_invalid/);
  await assert.rejects(h.policy.configure({ version: 1, dispatchEnabled: true, protectInitiatingAccount: true, profiles: [] }), /profiles_incomplete/);
});

test("persists settings and fills safe defaults for newly registered profiles", async (t) => {
  const h = await harness(t, [id(1)]);
  await h.policy.configure({
    version: 1, dispatchEnabled: true, protectInitiatingAccount: true,
    profiles: [{ profileId: id(1), enabled: false, maxConcurrent: 3 }],
  });
  await writeFile(join(h.store.dir, "codex-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: id(1) }, { id: id(2) }] }), { mode: 0o600 });
  const reloaded = await h.policy.read();
  assert.equal(reloaded.dispatchEnabled, true);
  assert.deepEqual(reloaded.profiles, [
    { profileId: id(1), enabled: false, maxConcurrent: 3 },
    { profileId: id(2), enabled: true, maxConcurrent: 1 },
  ]);
  assert.equal(JSON.parse(await readFile(join(h.store.dir, CODEX_POOL_POLICY_FILE), "utf8")).profiles.length, 2);
});

test("validates scheduler activity counts instead of treating missing capacity as free", async (t) => {
  const h = await harness(t, [id(1)]);
  await h.policy.configure({
    version: 1, dispatchEnabled: true, protectInitiatingAccount: true,
    profiles: [{ profileId: id(1), enabled: true, maxConcurrent: 2 }],
  });
  await assert.rejects(h.policy.eligibleCandidates([id(1)], { [id(99)]: 0 }, externalOrigin), /capacity_invalid/);
  await assert.rejects(h.policy.eligibleCandidates([id(1)], { [id(1)]: -1 }, externalOrigin), /capacity_invalid/);
  assert.deepEqual(await h.policy.eligibleCandidates([id(1)], { [id(1)]: 2 }, externalOrigin), []);
});
