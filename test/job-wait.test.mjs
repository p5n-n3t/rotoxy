import test from "node:test";
import assert from "node:assert/strict";
import { SupervisorRuntime } from "../dist/supervisor-runtime.js";
import { JOB_TOOL_DEFINITIONS, JobInputError, requiredJobScope, validateJobToolArguments } from "../dist/job-submit.js";

const config = { version: 1, projects: [{ projectId: "project-a", clientIds: ["client-a"], accountIds: [], registeredSessions: [] }],
  maxWorkers: 1, allowUnknownQuota: true, localLimits: { maxTasks: 8, maxJobBytes: 65536, maxOutputBytes: 8192 } };
const caller = { clientId: "client-a", projectId: "project-a" };
function runtimeWith(request) {
  const runtime = new SupervisorRuntime(config, { configDir: "/tmp/rotoxy-job-wait-test", store: { async load() { return { config: { upstreamUrl: "" }, accounts: [] }; } } });
  runtime.started = true;
  runtime.authorizeWorkspace = async () => {};
  runtime.bridge = { request };
  return runtime;
}
const statusRow = (state = "running", revision = 1) => ({ assignmentId: "job-a", projectId: "project-a", state, revision, tasks: [] });

test("job_wait is a read-scoped bounded tool and rejects unsupported arguments", () => {
  const definition = JOB_TOOL_DEFINITIONS.find((tool) => tool.name === "job_wait");
  assert.ok(definition);
  assert.equal(requiredJobScope("job_wait"), "jobs:read");
  assert.deepEqual(validateJobToolArguments("job_wait", { projectId: "project-a", jobId: "job-a" }), { projectId: "project-a", jobId: "job-a" });
  for (const timeoutSeconds of [0, 21, 1.5, "2"]) assert.throws(() => validateJobToolArguments("job_wait", { projectId: "project-a", jobId: "job-a", timeoutSeconds }), JobInputError);
  assert.throws(() => validateJobToolArguments("job_wait", { projectId: "project-a", jobId: "job-a", prompt: "bad" }), /unsupported field/);
  assert.throws(() => validateJobToolArguments("job_wait", { projectId: "project-a", jobId: "job-a", snapshot: "not-a-token" }), /opaque status fingerprint/);
});

test("job_wait returns terminal status immediately without a second read", async () => {
  let reads = 0;
  const runtime = runtimeWith(async () => { reads++; return statusRow("complete"); });
  const result = await runtime.callTool("job_wait", { projectId: "project-a", jobId: "job-a" }, caller);
  assert.equal(result.waitState, "terminal");
  assert.match(result.snapshot, /^[a-f0-9]{64}$/);
  assert.equal(reads, 1);
});

test("job_wait detects metadata changes and reauthorizes every status read", async () => {
  let reads = 0;
  let authorizations = 0;
  const runtime = runtimeWith(async () => statusRow("running", ++reads));
  runtime.authorizeWorkspace = async () => { authorizations++; };
  const result = await runtime.callTool("job_wait", { projectId: "project-a", jobId: "job-a", timeoutSeconds: 2 }, caller);
  assert.equal(result.waitState, "changed");
  assert.equal(result.status.revision, 2);
  assert.equal(reads, 2);
  assert.ok(authorizations >= 3, "initial authorization plus each status read");
});

test("job_wait times out with the last status after bounded polling", async () => {
  let reads = 0;
  const runtime = runtimeWith(async () => { reads++; return statusRow(); });
  const started = Date.now();
  const result = await runtime.callTool("job_wait", { projectId: "project-a", jobId: "job-a", timeoutSeconds: 1 }, caller);
  assert.equal(result.waitState, "timeout");
  assert.equal(result.status.state, "running");
  assert.ok(reads <= 2);
  assert.ok(Date.now() - started < 2500);
});

test("job_wait caps concurrent callers and releases the slot after completion", async () => {
  const pending = [];
  const runtime = runtimeWith(() => new Promise((resolve) => pending.push(resolve)));
  const waiters = Array.from({ length: 8 }, () => runtime.callTool("job_wait", { projectId: "project-a", jobId: "job-a" }, caller));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 8);
  await assert.rejects(runtime.callTool("job_wait", { projectId: "project-a", jobId: "job-a" }, caller), /capacity is full/);
  for (const resolve of pending) resolve(statusRow("complete"));
  const results = await Promise.all(waiters);
  assert.equal(results.length, 8);
  runtime.bridge.request = async () => statusRow("complete");
  assert.equal((await runtime.callTool("job_wait", { projectId: "project-a", jobId: "job-a" }, caller)).waitState, "terminal");
});

test("a completed sibling does not end waiting for a slower running sibling", async () => {
  let reads=0;
  const runtime=runtimeWith(async()=>{reads++;return {...statusRow(),tasks:[{taskId:'fast',state:'complete'},{taskId:'slow',state:'running'}]};});
  const result=await runtime.callTool('job_wait',{projectId:'project-a',jobId:'job-a',timeoutSeconds:1},caller);
  assert.equal(result.waitState,'timeout');
  assert.equal(reads,1);
});

test("a guidance request returns immediately without treating an idle worker as complete", async () => {
  const runtime=runtimeWith(async()=>({...statusRow(),tasks:[{taskId:'slow',state:'needs_instructions'}]}));
  const result=await runtime.callTool('job_wait',{projectId:'project-a',jobId:'job-a'},caller);
  assert.equal(result.waitState,'terminal');
  assert.equal(result.status.state,'running');
});
