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
  for (let i = 0; i < 100; i++) {
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
  t.after(() => rm(dir, { recursive: true, force: true }));
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
  const runtime = new SupervisorRuntime(await readSupervisorRuntimeConfig(configPath), options);
  await runtime.start();
  t.after(() => runtime.close());
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
  const supervision = await runtime.readSupervision("project-a", 0, 10);
  assert.equal(supervision.project, "project-a");
  assert.ok(Array.isArray(supervision.events));
  assert.ok(Array.isArray(supervision.models));
  assert.equal(supervision.recovery.project, "project-a");
  assert.equal(supervision.recovery.available, false, "the scoped snapshot uses the injected temporary recovery database");
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

  const restarted = new SupervisorRuntime(await readSupervisorRuntimeConfig(configPath), options);
  await restarted.start();
  t.after(() => restarted.close());
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
  await writeFile(path, JSON.stringify(config), { mode: 0o644 });
  await chmod(path, 0o644);
  await assert.rejects(readSupervisorRuntimeConfig(path));
});
