import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisorRuntime, readSupervisorRuntimeConfig } from "../dist/supervisor-runtime.js";
import { isAllowedSupervisorRoute } from "../dist/supervisor-bridge.js";

const config = {
  version: 1,
  projects: [
    { projectId: "project-a", clientIds: ["client-a", "client-b"], accountIds: ["acct-a", "acct-b"], registeredSessions: [
    { sessionId: "session-a", accountId: "acct-a", model: "gpt-6-luna", workspaceId: "workspace-a" },
    { sessionId: "session-b", accountId: "acct-b", model: "gpt-6-luna", workspaceId: "workspace-b" },
    ] },
    { projectId: "project-b", clientIds: ["client-a"], accountIds: ["acct-c"], registeredSessions: [
      { sessionId: "session-c", accountId: "acct-c", model: "gpt-6-luna", workspaceId: "workspace-c" },
    ] },
  ],
  maxWorkers: 2,
  allowUnknownQuota: true,
  localLimits: { maxTasks: 100, maxJobBytes: 1048576, maxOutputBytes: 32768 },
};
const currentState = {
  config: { upstreamUrl: "https://app.lightsprint.ai/mcp" },
  accounts: ["acct-a", "acct-b", "acct-c"].map((id) => ({ id, provider: "lightsprint", enabled: true, stats: { state: "healthy" } })),
};
const store = { async load() { return currentState; } };
const caller = { clientId: "client-a", projectId: "project-a" };

test("expired transient cooldown restores eligibility without clearing auth or quota blocks", async t=>{
  const dir=await mkdtemp(join(tmpdir(),"rx-expired-cooldown-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const state=structuredClone(currentState);
  const runtime=new SupervisorRuntime(config,{configDir:dir,supervisorCwd:join(process.cwd(),"supervisor"),
    supervisionDbPath:join(dir,"inbox.sqlite"),recoveryDbPath:join(dir,"recovery.sqlite"),
    oracleConfigPath:join(dir,"oracle.json"),oracleDbPath:join(dir,"oracle.sqlite"),store:{load:async()=>state}});
  runtime.started=true;
  for(const [stats,eligible] of [
    [{state:"cooldown",cooldownUntil:Date.now()-10000},true],
    [{state:"cooldown",cooldownUntil:Date.now()+3600000},false],
    [{state:"exhausted",cooldownUntil:Date.now()-10000},false],
    [{state:"auth-failed",cooldownUntil:Date.now()-10000},false],
    [{state:"healthy",cooldownUntil:Date.now()+3600000},false],
  ]){
    state.accounts[0].stats=stats;
    const snapshot=await runtime.callTool("job_workers",{projectId:"project-a"},caller);
    assert.equal(snapshot.workers.find(w=>w.accountId==="acct-a").eligible,eligible,stats.state);
  }
});

test("fresh provisioning config is strict, optional, and account-bound", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rx-fresh-config-"));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "runtime.json");
  const withBindings = structuredClone(config);
  withBindings.projects[0].freshProvisioningBindings = [{ accountId: "acct-a", workspaceId: "workspace-a", stackId: "stack-a", provider: "claude" }];
  await writeFile(configPath, JSON.stringify(withBindings), { mode: 0o600 });
  const parsed = await readSupervisorRuntimeConfig(configPath);
  assert.deepEqual(parsed.projects[0].freshProvisioningBindings, withBindings.projects[0].freshProvisioningBindings);
  const runtime = new SupervisorRuntime(parsed, { configDir: dir, supervisorCwd: join(process.cwd(), "supervisor"),
    supervisionDbPath: join(dir, "inbox.sqlite"), recoveryDbPath: join(dir, "recovery.sqlite"),
    oracleConfigPath: join(dir, "oracle.json"), oracleDbPath: join(dir, "oracle.sqlite"), store });
  runtime.started = true;
  const inventory = await runtime.callTool("job_workers", { projectId: "project-a" }, caller);
  const freshAccount = inventory.accounts.find((account) => account.accountId === "acct-a");
  assert.equal(freshAccount.automaticProvisioning, true);
  assert.equal(freshAccount.provisioningState, "fresh_ready");
  assert.deepEqual(freshAccount.freshProvisioning, { workspaceId: "workspace-a", stackId: "stack-a", provider: "claude" });
  await runtime.close();

  for (const invalid of [
    [{ accountId: "acct-c", stackId: "stack-a", provider: "claude" }],
    [{ accountId: "acct-a", workspaceId: "workspace-a", stackId: "stack-a", provider: "claude" }, { accountId: "acct-a", workspaceId: "workspace-b", stackId: "stack-b", provider: "codex" }],
    [{ accountId: "acct-a", stackId: "stack-a", provider: "claude" }],
    [{ accountId: "acct-a", stackId: "../unsafe", provider: "claude" }],
  ]) {
    const invalidConfig = structuredClone(config);
    invalidConfig.projects[0].freshProvisioningBindings = invalid;
    await writeFile(configPath, JSON.stringify(invalidConfig), { mode: 0o600 });
    await assert.rejects(readSupervisorRuntimeConfig(configPath), /fresh-provisioning|Fresh-provisioning|Invalid supervisor config fields/);
  }
});

test("fresh job submit requires an exact eligible binding before bridge submission and pins the projection", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rx-fresh-submit-"));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bridgeCalls = [];
  const makeRuntime = (runtimeConfig) => {
    const runtime = new SupervisorRuntime(runtimeConfig, { configDir: dir, supervisorCwd: join(process.cwd(), "supervisor"),
      supervisionDbPath: join(dir, "inbox.sqlite"), recoveryDbPath: join(dir, "recovery.sqlite"),
      oracleConfigPath: join(dir, "oracle.json"), oracleDbPath: join(dir, "oracle.sqlite"), store });
    runtime.started = true;
    runtime.bridge.request = async (method, path, body) => {
      bridgeCalls.push({ method, path, body });
      return { assignmentId: body.assignmentId, projectId: body.projectId, state: "queued", tasks: body.tasks };
    };
    return runtime;
  };
  const freshSubmission = structuredClone(submission);
  freshSubmission.tasks = [structuredClone(submission.tasks[0])];
  freshSubmission.tasks[0].execution = { mode: "fresh", provider: "claude" };

  const unbound = makeRuntime(config);
  await assert.rejects(unbound.callTool("job_submit", freshSubmission, caller), /explicitly bound eligible account and stack/);
  assert.equal(bridgeCalls.length, 0, "unbound fresh jobs are refused before the bridge is contacted");
  await unbound.close();

  const boundConfig = structuredClone(config);
  boundConfig.projects[0].freshProvisioningBindings = [{ accountId: "acct-a", workspaceId: "workspace-a", stackId: "stack-a", provider: "claude" }];
  const bound = makeRuntime(boundConfig);
  const receipt = await bound.callTool("job_submit", freshSubmission, caller);
  assert.equal(receipt.state, "queued");
  assert.equal(bridgeCalls.length, 1);
  assert.deepEqual(bridgeCalls[0].body.eligibleAccountIds, ["acct-a", "acct-b"], "the task execution binding pins fresh provisioning while the job keeps its eligible fleet");
  assert.equal(bridgeCalls[0].body.tasks[0].execution.mode, "fresh");
  assert.equal(bridgeCalls[0].body.tasks[0].execution.workspaceId, "workspace-a");
  assert.equal(bridgeCalls[0].body.tasks[0].stackId, "stack-a");
  assert.equal(bridgeCalls[0].body.tasks[0].provider, "claude");
  assert.match(bridgeCalls[0].body.tasks[0].instructions, /DONE-task-one/);
  await bound.close();
});

test("fresh job submit round-robins verified bindings while pinning every task to its own account", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rx-fresh-fanout-"));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bridgeCalls = [];
  const fanoutConfig = structuredClone(config);
  fanoutConfig.projects[0].freshProvisioningBindings = [
    { accountId: "acct-a", workspaceId: "workspace-a", stackId: "stack-a", provider: "claude" },
    { accountId: "acct-b", workspaceId: "workspace-b", stackId: "stack-b", provider: "claude" },
  ];
  const runtime = new SupervisorRuntime(fanoutConfig, { configDir: dir, supervisorCwd: join(process.cwd(), "supervisor"),
    supervisionDbPath: join(dir, "inbox.sqlite"), recoveryDbPath: join(dir, "recovery.sqlite"),
    oracleConfigPath: join(dir, "oracle.json"), oracleDbPath: join(dir, "oracle.sqlite"), store });
  runtime.started = true;
  runtime.bridge.request = async (method, path, body) => {
    bridgeCalls.push({ method, path, body });
    return { assignmentId: body.assignmentId, projectId: body.projectId, state: "queued", tasks: body.tasks };
  };
  const freshSubmission = structuredClone(submission);
  freshSubmission.tasks.forEach((task) => { task.execution = { mode: "fresh", provider: "claude" }; });
  const receipt = await runtime.callTool("job_submit", freshSubmission, caller);
  assert.equal(receipt.state, "queued");
  assert.equal(bridgeCalls.length, 1);
  const body = bridgeCalls[0].body;
  assert.deepEqual(body.eligibleAccountIds, ["acct-a", "acct-b"]);
  assert.deepEqual(body.tasks.map((task) => task.execution), [
    { mode: "fresh", accountId: "acct-a", workspaceId: "workspace-a", stackId: "stack-a", provider: "claude" },
    { mode: "fresh", accountId: "acct-b", workspaceId: "workspace-b", stackId: "stack-b", provider: "claude" },
  ]);
  assert.deepEqual(body.tasks.map((task) => task.stackId), ["stack-a", "stack-b"]);
  await runtime.close();
});

const submission = {
  schemaVersion: 1, jobId: "job-one", idempotencyKey: "idem-one", projectId: "project-a",
  eligibleAccountIds: ["acct-a", "acct-b"], scheduling: { profile: "custom", maxConcurrency: 2 },
  tasks: ["task-one", "task-two"].map((taskId, index) => ({ taskId, priority: index ? 2 : 7, dependsOn: [], scopeKeys: [`path:src/${taskId}.txt`], instructions: "Write a short bounded result.",
    execution: { mode: "existing-session" }, output: { kind: "text", maxBytes: 2048, format: "plain text", expectedMarker: `DONE-${taskId}` } })),
};

function fakeAdapter(accountId) {
  let marker = "";
  return {
    accountId,
    async sessionStatus() { return { classification: "accepted", accountId, value: { status: "idle", isOwner: true, canSendMessage: true, registeredModel: "gpt-6-luna" } }; },
    async sendMessage(_sessionId, message) {
      marker = message.match(/exact completion marker on its own line: (.+)$/)?.[1] ?? "";
      return { classification: "accepted", accountId, value: {} };
    },
    async sessionTranscript() { return { classification: "accepted", accountId, value: {
      latestAssistantIndex: 0, latestAssistantComplete: true,
      messages: [{ role: "assistant", content: `Result ${marker}`, timestamp: new Date().toISOString(), complete: true }],
    } }; },
    async stopSession() { return { classification: "accepted", accountId, value: {} }; },
  };
}
async function waitComplete(runtime) {
  let last;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await runtime.callTool("job_status", { projectId: "project-a", jobId: "job-one" }, caller);
    last = value;
    if (value.tasks?.length && value.tasks.every((task) => task.state === "complete")) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job did not complete before test deadline: ${JSON.stringify(last)}`);
}

test("real Python IPC registers two accounts, completes pinned tasks, isolates callers, and resumes durable results", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-runtime-"));
  await chmod(dir, 0o700);
  let runtime, restarted;
  t.after(async () => {
    try { await restarted?.close(); await runtime?.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  const configPath = join(dir, "runtime.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  assert.equal((await readSupervisorRuntimeConfig(configPath)).projects[0].projectId, "project-a");
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/assignments"), true);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/accounts"), true);
  assert.equal(isAllowedSupervisorRoute("GET", "/v1/assignments/job-one/results"), true);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/assignments/job-one/cancel"), true);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/accounts/other"), false);
  assert.equal(isAllowedSupervisorRoute("GET", "/admin/api/v1/assignments/job-one/../../other"), false);

  const adapters = new Map();
  const options = { configPath, configDir: dir, supervisorCwd: join(process.cwd(), "supervisor"), supervisionDbPath: join(dir, "inbox.sqlite"), recoveryDbPath: join(dir, "recovery.sqlite3"), oracleConfigPath: join(dir, "oracle-config.json"), oracleDbPath: join(dir, "oracle.sqlite"), store,
    adapterFactory: (accountId) => { if (!adapters.has(accountId)) adapters.set(accountId, fakeAdapter(accountId)); return adapters.get(accountId); },
    workerOptions: { pollIntervalMs: 20, adapterTimeoutMs: 1000 } };
  runtime = new SupervisorRuntime(await readSupervisorRuntimeConfig(configPath), options);
  await runtime.start();
  const receipt = await runtime.callTool("job_submit", submission, caller);
  assert.equal(receipt.assignmentId, "job-one");
  assert.equal(receipt.state, "queued");
  assert.deepEqual(await runtime.callTool("job_submit", submission, caller), receipt);
  const submitted = await runtime.callTool("job_status", { projectId: "project-a", jobId: "job-one" }, caller);
  assert.deepEqual(submitted.scheduling, submission.scheduling);
  assert.deepEqual(submitted.tasks.map((task) => task.priority), [7, 2]);
  const completed = await waitComplete(runtime);
  assert.equal(completed.state, "complete");
  assert.deepEqual(completed.tasks.map((task) => task.selectedAccountId), ["acct-a", "acct-b"]);
  assert.deepEqual(completed.tasks.map((task) => task.sessionId), ["session-a", "session-b"]);
  const results = await runtime.callTool("job_results", { projectId: "project-a", jobId: "job-one" }, caller);
  assert.deepEqual(results.results.map((result) => result.taskId).sort(), ["task-one", "task-two"]);
  assert.ok(results.results.every((result) => result.text.includes("DONE-task-")));
  await assert.rejects(runtime.callTool("job_results", { projectId: "project-b", jobId: "job-one" }, { ...caller, projectId: "project-b" }), /job is not available/);
  await assert.rejects(runtime.callTool("job_results", { projectId: "project-a", jobId: "job-one" }, { clientId: "client-b", projectId: "project-a" }));
  const workers = await runtime.callTool("job_workers", { projectId: "project-a" }, caller);
  assert.equal(workers.workers.length, 2);
  assert.equal(workers.accounts.length, 3, "connected account inventory is distinct from dispatch binding");
  const unbound = workers.accounts.find(account => account.accountId === "acct-c");
  assert.equal(unbound.dispatchBound, false);
  assert.equal(unbound.provisioningState, "not_bound");
  assert.equal(unbound.providerSlotLimit, null);
  assert.equal(unbound.availableSlots, null);
  assert.ok(workers.accounts.every(account => !("secret" in account)));
  const supervision = await runtime.readSupervision("project-a", 0, 10);
  assert.equal(supervision.project, "project-a");
  assert.ok(Array.isArray(supervision.events));
  assert.ok(Array.isArray(supervision.models));
  assert.equal(supervision.recovery.project, "project-a");
  assert.equal(supervision.recovery.available, false, "the scoped snapshot uses the injected temporary recovery database");
  const paused = await runtime.callTool("job_control", {projectId:"project-a", action:"pause_dispatch"}, caller);
  assert.equal(paused.projectId,"project-a");
  assert.equal(paused.state,"paused");
  const dispatchResumed = await runtime.callTool("job_control", {projectId:"project-a", action:"resume_dispatch"}, caller);
  assert.equal(dispatchResumed.state,"running");
  assert.ok(dispatchResumed.revision > paused.revision);
  currentState.accounts.find((account) => account.id === "acct-b").stats.state = "auth-failed";
  const narrowed = await runtime.callTool("job_submit", { ...submission, jobId: "job-two", idempotencyKey: "idem-two", tasks: [submission.tasks[0]] }, caller);
  assert.equal(narrowed.assignmentId, "job-two");
  const narrowedStatus = await runtime.callTool("job_status", { projectId: "project-a", jobId: "job-two" }, caller);
  assert.deepEqual(narrowedStatus.eligibleAccountIds, ["acct-a"]);
  const inboxPage = await runtime.callTool("job_inbox", { projectId: "project-a", limit: 1 }, caller);
  assert.equal(inboxPage.projectId, "project-a");
  assert.equal(inboxPage.events.length, 1);
  assert.equal(inboxPage.hasMore, true);
  assert.match(inboxPage.cursor, /^[A-Za-z0-9_-]{32}$/);
  const eventId = inboxPage.events[0].eventId;
  assert.match(eventId, /^(repo|job):[1-9][0-9]{0,18}$/);
  assert.deepEqual(await runtime.callTool("job_inbox_ack", { projectId: "project-a", eventId }, caller),
    { projectId: "project-a", eventId, acknowledged: true });
  await assert.rejects(runtime.callTool("job_inbox_ack", { projectId: "project-a", eventId },
    { clientId: "client-b", projectId: "project-a" }));
  await assert.rejects(runtime.callTool("job_inbox_ack", { projectId: "project-b", eventId },
    { clientId: "client-a", projectId: "project-b" }));
  await runtime.close();

  restarted = new SupervisorRuntime(await readSupervisorRuntimeConfig(configPath), options);
  await restarted.start();
  const persisted = await restarted.callTool("job_results", { projectId: "project-a", jobId: "job-one" }, caller);
  assert.equal(persisted.results.length, 2);
  const inboxAfterCursor = await restarted.callTool("job_inbox", { projectId: "project-a", after: inboxPage.cursor, limit: 1 }, caller);
  assert.equal(inboxAfterCursor.projectId, "project-a");
  const persistedInbox = await restarted.callTool("job_inbox", { projectId: "project-a", limit: 100 }, caller);
  assert.equal(persistedInbox.events.find((event) => event.eventId === eventId)?.acknowledged, true);
  const resumed = await restarted.callTool("job_status", { projectId: "project-a", jobId: "job-one" }, caller);
  assert.equal(resumed.state, "complete");
  assert.ok(resumed.tasks.every((task) => task.state === "complete"));
});

test("readAdmin projects reported usage and deduplicates account cost by task generation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-runtime-usage-"));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "runtime.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const runtime = new SupervisorRuntime(await readSupervisorRuntimeConfig(configPath), { configPath, configDir: dir, supervisorCwd: join(process.cwd(), "supervisor"), supervisionDbPath: join(dir, "inbox.sqlite"), recoveryDbPath: join(dir, "recovery.sqlite3"), oracleConfigPath: join(dir, "oracle-config.json"), oracleDbPath: join(dir, "oracle.sqlite"), store });
  const usage = (delta, observedAt) => ({ reportedSessionCostUsd: 1.5, reportedCostDeltaUsd: delta, promptCountDelta: 2, budgetUsed: 4, maxBudget: 10,
    fundingSource: "shared", sandboxTier: "standard", observedAt, source: "lightsprint-session-status", provisional: true, budgetUnit: "unknown" });
  const assignment = { assignmentId: "job-usage", projectId: "project-a", state: "running", tasks: [
    { taskId: "task-one", state: "running", generation: 2, sessionId: "session-a", selectedAccountId: "acct-a", modelReported: "gpt-6-luna", usage: usage(0.12, 200) },
    { taskId: "task-two", state: "running", generation: 1, sessionId: "session-a", selectedAccountId: "acct-a", modelReported: "gpt-6.1", usage: usage(0.13, 300) },
    { taskId: "task-three", state: "queued", generation: 0, sessionId: "session-b", selectedAccountId: "acct-b", modelReported: "gpt-6-luna", usage: { reportedCostDeltaUsd: -1, maxBudget: 0 } },
  ] };
  runtime.bridge.request = async (_method, path) => {
    if (path.startsWith("/admin/api/v1/assignments?")) return { assignments: [{ assignmentId: "job-usage" }] };
    if (path === "/admin/api/v1/assignments/job-usage") return assignment;
    if (path === "/admin/api/v1/events?after=0&limit=50") return { events: [] };
    if (path === "/admin/api/v1/credit-admission") return { mode: "legacy", accounts: [] };
    if (path === "/admin/api/v1/projects/project-a/control") return { projectId: "project-a", state: "paused", paused: true, emergencyStop: false, maxConcurrency: 2, activeTaskCount: 1, revision: 4, updatedAt: 1 };
    throw new Error(`unexpected readAdmin request: ${path}`);
  };
  runtime.guidanceCommand = async () => ({ available: true, workers: [
    { sessionId: "session-a", state: "needs_instructions", model: "gpt-6.1", modelSource: "observed", heartbeatAt: 1791792000, lastProgressAt: 1791791000 },
    { sessionId: "session-b", state: "stalled", model: "gpt-6-luna", modelSource: "observed", heartbeatAt: 1791790000, lastProgressAt: 1791780000 },
  ], events: [], models: [] });
  runtime.bridge.status = () => ({ state: "ready" });

  const snapshot = await runtime.readAdmin("project-a");
  assert.deepEqual(snapshot.projectControl, { projectId: "project-a", state: "paused", paused: true, emergencyStop: false, maxConcurrency: 2, activeTaskCount: 1, revision: 4, updatedAt: 1 });
  const accountA = snapshot.providers[0].accounts.find((account) => account.id === "acct-a");
  const accountB = snapshot.providers[0].accounts.find((account) => account.id === "acct-b");
  const workerA = snapshot.providers[0].accounts.flatMap((account) => account.workspaces).flatMap((workspace) => workspace.workers).find((worker) => worker.id === "session-a");
  assert.equal(snapshot.tasks.filter((task) => task.accountId === "acct-a").length, 2);
  assert.equal(snapshot.tasks.find((task) => task.id === "job-usage:task-one").usage.reportedCostDeltaUsd, 0.12);
  assert.equal(accountA.usage.reportedCostDeltaUsd, 0.25);
  assert.equal(accountA.usage.coveredTaskGenerations, 2);
  assert.equal(accountA.usage.totalTaskGenerations, 2);
  assert.equal(accountA.usage.provisional, true);
  assert.equal(workerA.usage.reportedCostDeltaUsd, 0.13);
  assert.equal(workerA.model, "gpt-6.1");
  assert.equal(workerA.accountId, "acct-a");
  assert.equal(workerA.accountLabel, "acct-a");
  assert.equal(workerA.requestedModel, "gpt-6-luna");
  assert.equal(workerA.actualModel, "gpt-6.1");
  assert.equal(workerA.taskCorrelation, "job-usage:task-two");
  assert.equal(workerA.monitorState, "needs_instructions");
  assert.equal(workerA.heartbeatAt, 1791792000);
  const workerB = accountB.workspaces.flatMap((workspace) => workspace.workers).find((worker) => worker.id === "session-b");
  assert.equal(workerB.model, "gpt-6-luna", "reported model survives missing usage metrics");
  assert.equal(workerB.usage, undefined);
  assert.equal(accountB.usage.coveredTaskGenerations, 0);
  assert.equal("reportedCostDeltaUsd" in accountB.usage, false);
  assert.equal("capacity" in accountA, false);
  assert.equal("quota" in accountA, false);
});

test("compact summary derives owners from configured project, validates bounds, and caps the IPC result", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-runtime-summary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new SupervisorRuntime(config, { configPath: join(dir, "unused.json"), configDir: dir,
    supervisorCwd: join(process.cwd(), "supervisor"), supervisionDbPath: join(dir, "inbox.sqlite"),
    recoveryDbPath: join(dir, "recovery.sqlite3"), oracleConfigPath: join(dir, "oracle-config.json"),
    oracleDbPath: join(dir, "oracle.sqlite"), store });
  const calls = [];
  runtime.guidanceCommand = async (...args) => {
    calls.push(args);
    return { project: args[2][1], workers: [], events: [], cursor: Number(args[2][3]), hasMore: false };
  };
  assert.deepEqual(await runtime.readCompactSummary("project-a", 12, 4),
    { project: "project-a", workers: [], events: [], cursor: 12, hasMore: false });
  assert.deepEqual(calls[0], ["compact-summary", { owners: ["oauth-client:client-a", "oauth-client:client-b"] },
    ["--project", "project-a", "--after", "12", "--limit", "4"]]);
  await runtime.readCompactSummary("project-b", 0, 20);
  assert.deepEqual(calls[1][1], { owners: ["oauth-client:client-a"] }, "owner list comes from the selected project's private config");
  await assert.rejects(runtime.readCompactSummary("not-configured", 0, 20), /invalid compact summary/);
  await assert.rejects(runtime.readCompactSummary("project-a", -1, 20), /invalid compact summary/);
  await assert.rejects(runtime.readCompactSummary("project-a", 0, 21), /invalid compact summary/);
  runtime.guidanceCommand = async () => ({ project: "project-a", oversized: "x".repeat(520 * 1024) });
  await assert.rejects(runtime.readCompactSummary("project-a", 0, 20), /supervisor response exceeds configured bounds/);
});

test("compact summary runs the existing Python CLI and filters workers to configured project owners", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-runtime-summary-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new SupervisorRuntime(config, { configPath: join(dir, "unused.json"), configDir: dir,
    supervisorCwd: join(process.cwd(), "supervisor"), supervisionDbPath: join(dir, "inbox.sqlite"),
    recoveryDbPath: join(dir, "recovery.sqlite3"), oracleConfigPath: join(dir, "oracle-config.json"),
    oracleDbPath: join(dir, "oracle.sqlite"), store });
  await runtime.guidanceCommand("sync-project", { project: "project-a", workers: [
    { worker: "worker-a", owner: "oauth-client:client-a", account: "acct-a", session: "session-a", model: "gpt-6-luna" },
    { worker: "worker-b", owner: "oauth-client:client-b", account: "acct-b", session: "session-b", model: "gpt-6-luna" },
  ] });
  const projectA = await runtime.readCompactSummary("project-a");
  assert.equal(projectA.project, "project-a");
  assert.deepEqual(projectA.workers.map((worker) => worker.id), ["worker-a", "worker-b"]);
  const projectB = await runtime.readCompactSummary("project-b");
  assert.deepEqual(projectB.workers, [], "project filter excludes another project even when the owner overlaps");
});

test("admin project controls use configured project scope and revision-fenced durable bridge route", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-runtime-controls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new SupervisorRuntime(config, { configPath: join(dir, "unused.json"), configDir: dir, supervisorCwd: join(process.cwd(), "supervisor"), supervisionDbPath: join(dir, "inbox.sqlite"), recoveryDbPath: join(dir, "recovery.sqlite3"), oracleConfigPath: join(dir, "oracle-config.json"), oracleDbPath: join(dir, "oracle.sqlite"), store });
  const calls = [];
  runtime.bridge.request = async (...args) => { calls.push(args); return { projectId: "project-a", state: "paused", paused: true, emergencyStop: false, maxConcurrency: 2, activeTaskCount: 0, revision: 2 }; };
  assert.deepEqual(await runtime.controlAdmin({ projectId: "project-a", action: "set_concurrency", value: 2, expectedRevision: 1 }),
    { projectId: "project-a", state: "paused", paused: true, emergencyStop: false, maxConcurrency: 2, activeTaskCount: 0, revision: 2 });
  assert.deepEqual(calls[0].slice(0, 3), ["POST", "/admin/api/v1/projects/project-a/control", { action: "set_concurrency", value: 2, expectedRevision: 1 }]);
  await assert.rejects(runtime.controlAdmin({ projectId: "unconfigured", action: "pause_dispatch", expectedRevision: 1 }), /project unavailable/);
  await assert.rejects(runtime.controlAdmin({ projectId: "project-a", action: "pause_dispatch", value: 2, expectedRevision: 1 }), /invalid project control value/);
});

test("runtime config rejects permissive fields, missing workspace bindings, and non-private files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "runtime.json");
  await writeFile(path, JSON.stringify({ ...config, executable: "/bin/sh" }), { mode: 0o600 });
  await assert.rejects(readSupervisorRuntimeConfig(path));
  const missingWorkspace = structuredClone(config);
  delete missingWorkspace.projects[0].registeredSessions[0].workspaceId;
  await writeFile(path, JSON.stringify(missingWorkspace), { mode: 0o600 });
  await assert.rejects(readSupervisorRuntimeConfig(path));
  const declaredModel = structuredClone(config);
  declaredModel.projects[0].registeredSessions[0].model = "claude-opus-5-5";
  await writeFile(path, JSON.stringify(declaredModel), { mode: 0o600 });
  assert.equal((await readSupervisorRuntimeConfig(path)).projects[0].registeredSessions[0].model, "claude-opus-5-5");
  declaredModel.projects[0].registeredSessions[0].model = "bad/model";
  await writeFile(path, JSON.stringify(declaredModel), { mode: 0o600 });
  await assert.rejects(readSupervisorRuntimeConfig(path), /declared model/);
  const duplicateSession = structuredClone(config);
  duplicateSession.projects[1].registeredSessions[0].sessionId = "session-a";
  await writeFile(path, JSON.stringify(duplicateSession), { mode: 0o600 });
  await assert.rejects(readSupervisorRuntimeConfig(path), /only one project/);
  const workspaceOnly = structuredClone(config);
  workspaceOnly.projects.push({ projectId: "workspace-only", clientIds: ["client-c"], accountIds: [], registeredSessions: [] });
  await writeFile(path, JSON.stringify(workspaceOnly), { mode: 0o600 });
  const parsedWorkspaceOnly = await readSupervisorRuntimeConfig(path);
  assert.deepEqual(parsedWorkspaceOnly.projects.find((project) => project.projectId === "workspace-only"),
    { projectId: "workspace-only", clientIds: ["client-c"], accountIds: [], registeredSessions: [] });
  await writeFile(path, JSON.stringify(config), { mode: 0o644 });
  await chmod(path, 0o644);
  await assert.rejects(readSupervisorRuntimeConfig(path));
});

test("reconcile_task action verifies project ownership and passes caller revision without auto-refresh", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-reconcile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new SupervisorRuntime(config, { configDir: dir,
    supervisorCwd: join(process.cwd(), "supervisor"), supervisionDbPath: join(dir, "inbox.sqlite"),
    recoveryDbPath: join(dir, "recovery.sqlite3"), oracleConfigPath: join(dir, "oracle-config.json"),
    oracleDbPath: join(dir, "oracle.sqlite"), store });
  runtime.started = true; // bypass bridge start; bridge.request is fully mocked below
  const bridgeCalls = [];
  runtime.bridge.request = async (method, path, body) => {
    bridgeCalls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/admin/api/v1/assignments/")) {
      return { assignmentId: "job-x", projectId: "project-b", revision: 7 };
    }
    return {};
  };
  // reconcile_task with a job that belongs to project-b must be rejected
  await assert.rejects(
    runtime.callTool("job_control", { projectId: "project-a", action: "reconcile_task",
      jobId: "job-x", taskId: "task-1", expectedRevision: 7 }, caller),
    /job is not available/,
  );
  // The reconcile bridge write must NOT have been called
  assert.ok(!bridgeCalls.some((c) => c.path.endsWith("/reconcile")),
    "bridge reconcile route must not be reached on project mismatch");
  // Now test that a matching project passes the caller-supplied revision (not the fetched one)
  runtime.bridge.request = async (method, path, body) => {
    bridgeCalls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/admin/api/v1/assignments/")) {
      return { assignmentId: "job-y", projectId: "project-a", revision: 5 };
    }
    if (method === "POST" && path.endsWith("/reconcile")) {
      return { assignmentId: "job-y", taskId: "task-1", state: "awaiting_output", revision: 6 };
    }
    return {};
  };
  bridgeCalls.length = 0;
  const result = await runtime.callTool("job_control", { projectId: "project-a", action: "reconcile_task",
    jobId: "job-y", taskId: "task-1", expectedRevision: 3 }, caller);
  assert.equal(result.state, "awaiting_output");
  const reconcileCall = bridgeCalls.find((c) => c.path.endsWith("/reconcile"));
  assert.ok(reconcileCall, "bridge reconcile route must be called");
  // Caller-supplied expectedRevision (3) must be passed, not the fetched one (5)
  assert.equal(reconcileCall.body.expectedRevision, 3, "caller-supplied revision must be forwarded");
  assert.equal(reconcileCall.body.taskId, "task-1");
});

test("exhausted account shows ineligible for dispatch but isAccountObservable allows it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-obs-predicate-"));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "runtime.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  // acct-a is quota-exhausted; all others are healthy
  const exhaustedState = {
    config: { upstreamUrl: "https://app.lightsprint.ai/mcp" },
    accounts: [
      { id: "acct-a", provider: "lightsprint", enabled: true, stats: { state: "exhausted" } },
      { id: "acct-b", provider: "lightsprint", enabled: true, stats: { state: "healthy" } },
      { id: "acct-c", provider: "lightsprint", enabled: true, stats: { state: "healthy" } },
    ],
  };

  const results = [];
  let claimCount = 0;
  const observeOp = {
    operationId: "obs-exhausted-predicate", attemptId: "attempt-obs-p", generation: 1,
    selectedAccountId: "acct-a", kind: "observe_session", sessionId: "session-a",
    input: { sessionId: "session-a", clientMessageId: "client-obs-p", dispatchAt: 100, expectedMarker: "DONE" },
  };

  const options = {
    configPath, configDir: dir,
    supervisorCwd: join(process.cwd(), "supervisor"),
    supervisionDbPath: join(dir, "inbox.sqlite"),
    recoveryDbPath: join(dir, "recovery.sqlite3"),
    oracleConfigPath: join(dir, "oracle-config.json"),
    oracleDbPath: join(dir, "oracle.sqlite"),
    store: { async load() { return exhaustedState; } },
    adapterFactory: (accountId) => fakeAdapter(accountId),
    workerOptions: { pollIntervalMs: 20, adapterTimeoutMs: 1000 },
  };

  const runtime = new SupervisorRuntime(await readSupervisorRuntimeConfig(configPath), options);
  await runtime.start();
  t.after(() => runtime.close());

  // Exhaust-quoted account must not be eligible for chat dispatch.
  const workers = await runtime.callTool("job_workers", { projectId: "project-a" }, caller);
  const exhaustedWorker = workers.workers.find((w) => w.accountId === "acct-a");
  assert.equal(exhaustedWorker?.eligible, false, "exhausted account must not be dispatch-eligible");
  const healthyWorker = workers.workers.find((w) => w.accountId === "acct-b");
  assert.equal(healthyWorker?.eligible, true, "healthy account must remain dispatch-eligible");

  // Intercept bridge to inject an observe_session for the exhausted account and capture result.
  const origRequest = runtime.bridge.request.bind(runtime.bridge);
  runtime.bridge.request = async (method, path, body, opts) => {
    if (path === "/v1/operations/claim") {
      return claimCount++ === 0 ? observeOp : undefined;
    }
    if (path.endsWith("/result")) { results.push(structuredClone(body)); return {}; }
    return origRequest(method, path, body, opts);
  };

  // Drive a tick so the worker processes the injected observe operation.
  const deadline = Date.now() + 3_000;
  while (results.length === 0 && Date.now() < deadline) {
    await runtime.worker.tick();
    if (results.length === 0) await new Promise((r) => setTimeout(r, 20));
  }

  assert.ok(results.length > 0, "observe_session must produce a result for exhausted account");
  assert.equal(results[0].outcome, "accepted",
    "observation from exhausted account must be accepted (isAccountObservable bypasses quota)");
  assert.notEqual(results[0].errorClass, "account_unavailable",
    "exhausted account must not be blocked from observing");
});

test("underscore-prefixed provider session IDs register and traversal remains rejected", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rx-underscore-session-"));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "runtime.json");

  const underscoreConfig = structuredClone(config);
  underscoreConfig.projects[0].registeredSessions[0].sessionId = "_provider_session_abc";
  await writeFile(path, JSON.stringify(underscoreConfig), { mode: 0o600 });
  const parsed = await readSupervisorRuntimeConfig(path);
  assert.equal(parsed.projects[0].registeredSessions[0].sessionId, "_provider_session_abc",
    "underscore-prefixed session ID must be accepted by config parser");

  // Traversal-like IDs must remain rejected
  const traversalConfig = structuredClone(config);
  traversalConfig.projects[0].registeredSessions[0].sessionId = "../evil";
  await writeFile(path, JSON.stringify(traversalConfig), { mode: 0o600 });
  await assert.rejects(readSupervisorRuntimeConfig(path), /sessions must be bound/);

  const slashConfig = structuredClone(config);
  slashConfig.projects[0].registeredSessions[0].sessionId = "has/slash";
  await writeFile(path, JSON.stringify(slashConfig), { mode: 0o600 });
  await assert.rejects(readSupervisorRuntimeConfig(path), /sessions must be bound/);

  underscoreConfig.projects[0].registeredSessions[0].workspaceId = "_workspace_abc";
  await writeFile(path, JSON.stringify(underscoreConfig), { mode: 0o600 });
  assert.equal((await readSupervisorRuntimeConfig(path)).projects[0].registeredSessions[0].workspaceId, "_workspace_abc");
});

 test("runtime accepts explicit large worker ceilings and deployed shared membership without inventing sessions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rx-capacity-"));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const path = join(dir, "runtime.json");
  const policy = {...structuredClone(config), maxWorkers:32, sharedWorkspace:{projectId:"project-a", membership:"authenticated_mcp"}};
  await writeFile(path, JSON.stringify(policy), {mode:0o600});
  const parsed = await readSupervisorRuntimeConfig(path);
  assert.equal(parsed.maxWorkers,32);
  assert.equal(parsed.sharedWorkspace.membership,"authenticated_mcp");
  assert.equal(parsed.projects[0].registeredSessions.length,2);
  policy.maxWorkers=33;
  await writeFile(path, JSON.stringify(policy), {mode:0o600});
  await assert.rejects(readSupervisorRuntimeConfig(path));
});

test("consented Fleet clients can read a same-Fleet job without receiving access to another project", async () => {
  const policy = { ...structuredClone(config), sharedWorkspace: { projectId: "project-a", membership: "authenticated_mcp" } };
  const runtime = new SupervisorRuntime(policy, { configDir: process.cwd(), supervisorCwd: join(process.cwd(), "supervisor"), store });
  runtime.started = true;
  const requests = [];
  runtime.bridge = { request: async (_method, path, _body, options) => {
    requests.push({ path, options });
    if (path === "/admin/api/v1/assignments/shared-job") return { assignmentId: "shared-job", projectId: "project-a", state: "complete", revision: 2, tasks: [] };
    if (path === "/v1/assignments/shared-job/results") return { assignmentId: "shared-job", results: [{ taskId: "task-a", text: "DONE", generation: 1 }] };
    throw new Error(`unexpected shared read: ${path}`);
  } };
  const sharedCaller = { clientId: "client-c", projectId: "project-a" };
  assert.equal((await runtime.callTool("job_status", { projectId: "project-a", jobId: "shared-job" }, sharedCaller)).state, "complete");
  assert.equal((await runtime.callTool("job_results", { projectId: "project-a", jobId: "shared-job" }, sharedCaller)).results[0].text, "DONE");
  assert.ok(requests.every(({ options }) => options.sharedProject === "project-a"));
  await assert.rejects(runtime.callTool("job_status", { projectId: "project-b", jobId: "shared-job" }, { clientId: "client-c", projectId: "project-b" }), /not authorized/);
});


test("dispatch policy hot reload clamps account ceiling and preserves observation while paused",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"rx-policy-hot-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const registrations=[];
 const localState=structuredClone(currentState);
 const runtime=new SupervisorRuntime(config,{configDir:dir,supervisorCwd:join(process.cwd(),"supervisor"),store:{load:async()=>localState}});
 runtime.bridge={request:async(method,path,body)=>{assert.equal(path,"/v1/accounts");registrations.push(body);}};
 await runtime.syncDispatchPolicy();assert.equal(registrations.length,3);
 assert.equal(registrations[0].localCapacity,1);
 await runtime.syncDispatchPolicy();assert.equal(registrations.length,3,"unchanged rules do not rewrite accounts");
 await writeFile(join(dir,"resource-routing-rules.json"),JSON.stringify({version:1,pools:{lightsprint:{enabled:false}},resources:{"acct-a":{capacity:12}}}));
 await runtime.syncDispatchPolicy();
 assert.equal(registrations.at(-3).localCapacity,1,"manual ceiling cannot invent registered slots");
 assert.equal(registrations.at(-3).health,"degraded");
 assert.equal(registrations.at(-3).enabled,true,"monitor authorization remains enabled");
 localState.accounts=localState.accounts.filter(a=>a.id!=="acct-a");
 await runtime.syncDispatchPolicy();
 assert.equal(registrations.at(-3).enabled,false,"removed account is disabled without stopping healthy registrations");
 assert.equal(registrations.at(-2).enabled,true);
});
