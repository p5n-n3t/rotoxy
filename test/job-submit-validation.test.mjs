import test from "node:test";
import assert from "node:assert/strict";
import { JobInputError, validateJobSubmission, validateJobToolArguments } from "../dist/job-submit.js";

function submission() {
  return {
    schemaVersion: 1, jobId: "schedule-1", idempotencyKey: "key-1", projectId: "project-1",
    eligibleAccountIds: ["account-a"],
    tasks: [{ taskId: "task-1", dependsOn: [], scopeKeys: ["path:src/task.txt"], priority: 0,
      instructions: "Return the bounded result", execution: { mode: "existing-session" },
      output: { kind: "text", maxBytes: 256, format: "plain", expectedMarker: "DONE" } }],
  };
}

test("reconciliation requires explicit safe revision and forbids launch overrides", () => {
  const args={projectId:"project-1",action:"reconcile_task",jobId:"job-1",taskId:"task-1",expectedRevision:2};
  assert.deepEqual(validateJobToolArguments("job_control",args),args);
  for (const expectedRevision of [undefined,true,0,-1,1.5,"2",Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(()=>validateJobToolArguments("job_control",{...args,expectedRevision}),/expectedRevision/);
  }
  for (const field of ["taskId","jobId"]) {
    const invalid={...args};delete invalid[field];
    assert.throws(()=>validateJobToolArguments("job_control",invalid));
  }
  assert.throws(()=>validateJobToolArguments("job_control",{...args,sessionId:"other"}),/unsupported/);
  assert.throws(()=>validateJobToolArguments("job_control",{...args,accountId:"other"}),/unsupported/);
  assert.throws(()=>validateJobToolArguments("job_control",{...args,action:"pause_dispatch"}),/require reconcile_task/);
});

test("scheduler profiles validate and preserve backward-compatible default", () => {
  assert.equal(validateJobSubmission(submission()).scheduling, undefined);
  for (const profile of ["economy", "balanced", "throughput"]) {
    assert.deepEqual(validateJobSubmission({ ...submission(), scheduling: { profile } }).scheduling, { profile });
  }
  assert.deepEqual(validateJobSubmission({ ...submission(), scheduling: { profile: "custom", maxConcurrency: 4 } }).scheduling,
    { profile: "custom", maxConcurrency: 4 });
});

test("scheduler policy rejects unknown and budget-unsafe fields", () => {
  for (const scheduling of [
    { profile: "unbounded" }, { profile: "custom" }, { profile: "custom", maxConcurrency: 33 },
    { profile: "economy", maxConcurrency: 2 }, { profile: "throughput", providerSlots: 12 },
  ]) assert.throws(() => validateJobSubmission({ ...submission(), scheduling }), JobInputError);
  const unknownTopLevel = { ...submission(), budgetUsd: 50 };
  assert.throws(() => validateJobSubmission(unknownTopLevel), /unsupported field/);
});

test("task priority is bounded, integer-only, and optional for old callers", () => {
  const old = submission();
  delete old.tasks[0].priority;
  assert.equal(validateJobSubmission(old).tasks[0].priority, undefined);
  for (const priority of [-100, 0, 100]) {
    const job = submission(); job.tasks[0].priority = priority;
    assert.equal(validateJobSubmission(job).tasks[0].priority, priority);
  }
  for (const priority of [-101, 101, 2.5, true]) {
    const job = submission(); job.tasks[0].priority = priority;
    assert.throws(() => validateJobSubmission(job), /priority/);
  }
});

test("instructions byte length is enforced not character count (UTF-8 regression)", () => {
  const emoji = "\u{1F600}"; // 4 bytes per character in UTF-8
  // 4096 emoji = exactly 16384 bytes — must pass
  const exact = emoji.repeat(4096);
  assert.equal(Buffer.byteLength(exact, "utf8"), 16384);
  const jobExact = submission(); jobExact.tasks[0].instructions = exact;
  assert.doesNotThrow(() => validateJobSubmission(jobExact), "exactly 16384 bytes must be accepted");
  // 4097 emoji = 16388 bytes — must be rejected even though only 4097 chars (< 16384 char limit)
  const over = emoji.repeat(4097);
  assert.equal(Buffer.byteLength(over, "utf8"), 16388);
  const jobOver = submission(); jobOver.tasks[0].instructions = over;
  assert.throws(() => validateJobSubmission(jobOver), /instructions/, "16388 bytes must be rejected");
  // ASCII: exactly 16384 chars = 16384 bytes — must pass
  const ascii = "a".repeat(16384);
  const jobAscii = submission(); jobAscii.tasks[0].instructions = ascii;
  assert.doesNotThrow(() => validateJobSubmission(jobAscii));
  // ASCII: 16385 chars = 16385 bytes — must be rejected
  const asciiOver = "a".repeat(16385);
  const jobAsciiOver = submission(); jobAsciiOver.tasks[0].instructions = asciiOver;
  assert.throws(() => validateJobSubmission(jobAsciiOver), /instructions/);
});

test("observation deadlines are explicit bounded monitoring policy and optional for old jobs", () => {
  assert.equal(validateJobSubmission(submission()).tasks[0].observationTimeoutSeconds, undefined);
  for (const seconds of [60,21600,604800]) {
    const job=submission(); job.tasks[0].observationTimeoutSeconds=seconds;
    assert.equal(validateJobSubmission(job).tasks[0].observationTimeoutSeconds, seconds);
  }
  for (const seconds of [59,604801,1.5,true,"3600"]) {
    const job=submission(); job.tasks[0].observationTimeoutSeconds=seconds;
    assert.throws(()=>validateJobSubmission(job), /observationTimeoutSeconds/);
  }
});
