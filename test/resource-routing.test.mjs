import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("routing rules validate strictly, persist under StateStore's lock, and never store secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-routing-rules-"));
  const oldHome = process.env.HOME;
  const oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  await mkdir(process.env.HOME, { recursive: true, mode: 0o700 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });

  const [{ StateStore }, { ResourceRoutingRulesStore, validateResourceRoutingRules }] = await Promise.all([
    import("../dist/store.js"), import("../dist/resource-routing.js"),
  ]);
  const state = new StateStore();
  await state.init({ adminPassword: "synthetic-routing-test-password" });
  const rules = new ResourceRoutingRulesStore(state);
  assert.deepEqual(JSON.parse(JSON.stringify(await rules.read())), { version: 1, unknownCapacity: 1, providerCaps: {}, resources: {} });
  assert.match(rules.template(), /"version": 1/);
  assert.throws(() => validateResourceRoutingRules({ version: 1, unknownCapacity: 1, surprise: true }), /unsupported field/);
  assert.throws(() => validateResourceRoutingRules({ version: 1, providerCaps: { untrusted: 4 } }), /unknown provider family/);
  assert.throws(() => validateResourceRoutingRules({ version: 1, resources: { acct: { weight: 0 } } }), /weight is invalid/);
  assert.throws(() => validateResourceRoutingRules({ version: 1, resources: { acct: { weight: 1, extra: true } } }), /unsupported field/);
  assert.throws(() => validateResourceRoutingRules({ version: 1, resources: { acct: { allowedModels: ["*"] } } }), /wildcards are not supported/);
  assert.deepEqual(validateResourceRoutingRules({ version: 1, resources: { acct: { allowedModels: [] } } }).resources.acct.allowedModels, [], "an explicit empty list is retained as deny-all policy");

  const lock = await open(state.lockPath, "wx", 0o600);
  let finished = false;
  const write = rules.replace({ version: 1, unknownCapacity: 2, providerCaps: { search: 4 }, resources: { searchA: { weight: 2, capacity: 3 } } }).then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(finished, false, "rule write waits for the cross-process StateStore lock");
  await lock.close(); await unlink(state.lockPath);
  await write;
  assert.deepEqual(JSON.parse(JSON.stringify(await rules.read())), { version: 1, unknownCapacity: 2, providerCaps: { search: 4 }, resources: { searchA: { enabled: true, weight: 2, capacity: 3 } } });
  assert.equal((await readFile(rules.path, "utf8")).includes("synthetic-routing-test-password"), false);
});

test("planner rejects unsafe capabilities, treats expired quota as unknown, and preserves sticky ownership", async () => {
  const { planResourceRouting, validateResourceRoutingRules } = await import("../dist/resource-routing.js");
  const mk = (id, change = {}) => ({ id, providerFamily: "workspace", enabled: true, auth: "valid", health: "healthy", models: ["model-x"], capabilities: ["chat"], maxContextTokens: 2048, capacity: 2, ...change });
  const resources = [
    mk("available", { quota: { state: "available", observedAt: 900, expiresAt: 2000 } }),
    mk("expired", { quota: { state: "available", observedAt: 10, expiresAt: 900 } }),
    mk("depleted", { quota: { state: "depleted", observedAt: 1000, expiresAt: 2000 } }),
    mk("disabled", { enabled: false }), mk("unauthenticated", { auth: "unknown" }),
    mk("unhealthy", { health: "unknown" }), mk("wrong-model", { models: ["other"] }),
    mk("small-context", { maxContextTokens: 20 }),
  ];
  const rules = validateResourceRoutingRules({ version: 1, unknownCapacity: 1, providerCaps: { workspace: 2 } });
  const plan = planResourceRouting({ resources, task: { id: "task-1", model: "model-x", requiredCapabilities: ["chat"], contextTokens: 512 }, rules, now: 1000 });
  assert.deepEqual(plan.assignments, [{ workId: "task-1", resourceId: "available" }]);
  assert.equal(plan.eligible.some((x) => x.resourceId === "expired" && x.quota === "unknown"), true, "expired quota is never reported available");
  assert.ok(plan.rejected.find((x) => x.resourceId === "depleted")?.reasons.includes("quota_depleted"));
  assert.ok(plan.rejected.find((x) => x.resourceId === "disabled")?.reasons.includes("disabled"));
  assert.ok(plan.rejected.find((x) => x.resourceId === "unauthenticated")?.reasons.includes("auth_unknown"));
  assert.ok(plan.rejected.find((x) => x.resourceId === "unhealthy")?.reasons.includes("health_unknown"));
  assert.ok(plan.rejected.find((x) => x.resourceId === "wrong-model")?.reasons.includes("model_unsupported"));
  assert.ok(plan.rejected.find((x) => x.resourceId === "small-context")?.reasons.includes("context_too_small"));
  assert.ok(plan.explanation.some((line) => line.includes("expired snapshots are not treated as available")));

  const sticky = planResourceRouting({ resources: [mk("pinned", { quota: { state: "depleted" } }), mk("other")], task: { id: "followup", stickyResourceId: "pinned" }, rules });
  assert.deepEqual(sticky.assignments, []);
  assert.ok(sticky.explanation.some((line) => line.includes("will not move")));
});

test("weighted fair planning fills idle slots with unique, non-running work and honors provider caps", async () => {
  const { planResourceRouting } = await import("../dist/resource-routing.js");
  const mk = (id) => ({ id, providerFamily: "search", enabled: true, auth: "valid", health: "healthy", capacity: 8, models: ["search-v1"], completedTasks: 0 });
  const resources = [mk("small"), mk("large")];
  const rules = { version: 1, unknownCapacity: 1, providerCaps: { search: 8 }, resources: { small: { weight: 1 }, large: { weight: 2 } } };
  const workItems = ["w1", "w1", "already-running", "w2", "w3", "w4", "w5", "w6"];
  const plan = planResourceRouting({ resources, task: { id: "root" }, workItems, inProgressWorkIds: ["already-running"], maxFanout: 6, rules, cursor: 0 });
  assert.equal(plan.assignments.length, 6);
  assert.equal(new Set(plan.assignments.map((x) => x.workId)).size, 6);
  assert.equal(plan.assignments.some((x) => x.workId === "already-running"), false);
  assert.equal(plan.assignments.filter((x) => x.resourceId === "large").length, 4);
  assert.equal(plan.assignments.filter((x) => x.resourceId === "small").length, 2);

  const capped = planResourceRouting({ resources, task: { id: "batch" }, workItems: ["a", "b", "c", "d"], maxFanout: 4, rules: { ...rules, providerCaps: { search: 2 } } });
  assert.equal(capped.assignments.length, 2);
  assert.ok(capped.explanation.some((line) => line.includes("No idle eligible capacity remains")));

  const unknownCapacity = planResourceRouting({ resources: [{ ...mk("unknown-cap"), capacity: undefined }], task: { id: "unknown-cap-task" }, workItems: ["one", "two"], maxFanout: 2 });
  assert.equal(unknownCapacity.assignments.length, 1, "unknown account and provider capacity default conservatively to one");
  assert.ok(unknownCapacity.explanation.some((line) => line.includes("conservative unknown capacity 1")));
  assert.ok(unknownCapacity.explanation.some((line) => line.includes("provider cap is unknown")));
});

test("inference planning intersects exact allowedModels while absent model rules remain unrestricted", async () => {
  const { planResourceRouting, validateResourceRoutingRules } = await import("../dist/resource-routing.js");
  const resource = { id: "ollama-a", providerFamily: "inference", enabled: true, auth: "valid", health: "healthy", models: ["gpt-oss:20b"] };
  const task = { id: "invoke-1", model: "gpt-oss:20b" };
  const deny = planResourceRouting({ resources: [resource], task, rules: validateResourceRoutingRules({ version: 1, resources: { "ollama-a": { allowedModels: [] } } }) });
  assert.equal(deny.assignments.length, 0);
  assert.ok(deny.rejected[0].reasons.includes("model_not_allowed_by_rule"));
  const allow = planResourceRouting({ resources: [resource], task, rules: validateResourceRoutingRules({ version: 1, resources: { "ollama-a": { allowedModels: ["gpt-oss:20b"] } } }) });
  assert.equal(allow.assignments[0].resourceId, "ollama-a");
  const legacy = planResourceRouting({ resources: [resource], task });
  assert.equal(legacy.assignments[0].resourceId, "ollama-a");
});

test("routing accepts credential IDs with every URL-safe base64 leading character", async () => {
  const { validateResourceRoutingRules } = await import("../dist/resource-routing.js");
  for (const id of ["_account123", "-account123"]) {
    const rules = validateResourceRoutingRules({ version: 1, resources: { [id]: { enabled: true, weight: 1 } } });
    assert.equal(rules.resources[id].enabled, true);
  }
  assert.throws(() => validateResourceRoutingRules({ version: 1, resources: { "../account": { enabled: true, weight: 1 } } }));
});

test('pool dispatch switches preserve account policy and are revision checked', async()=>{
 const {StateStore}=await import('../dist/store.js');const {ResourceRoutingRulesStore}=await import('../dist/resource-routing.js');
 const root=await mkdtemp(join(tmpdir(),'rx-pool-policy-'));
 const previous=process.env.TOKEN2OAUTH_CONFIG_DIR;process.env.TOKEN2OAUTH_CONFIG_DIR=root;
 try{
  const state=new StateStore();await state.init({adminPassword:'pool-test-only'});
  const store=new ResourceRoutingRulesStore(state),before=await store.read();
  const updated=await store.patchControls({pool:'lightsprint',enabled:false,expected:JSON.stringify(before)});
  assert.equal(updated.pools.lightsprint.enabled,false);
  await assert.rejects(store.patchControls({pool:'ollama',enabled:false,expected:JSON.stringify(before)}),/revision/);
  const capped=await store.patchControls({accountId:'account-a',enabled:true,capacity:2,expected:JSON.stringify(updated)});
  assert.equal(capped.resources['account-a'].capacity,2);assert.equal(capped.pools.lightsprint.enabled,false);
 }finally{if(previous===undefined)delete process.env.TOKEN2OAUTH_CONFIG_DIR;else process.env.TOKEN2OAUTH_CONFIG_DIR=previous;await rm(root,{recursive:true,force:true});}
});
