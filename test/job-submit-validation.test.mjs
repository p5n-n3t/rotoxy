import test from "node:test";
import assert from "node:assert/strict";
import { JobInputError, validateJobSubmission } from "../dist/job-submit.js";

function submission() {
  return {
    schemaVersion: 1, jobId: "schedule-1", idempotencyKey: "key-1", projectId: "project-1",
    eligibleAccountIds: ["account-a"],
    tasks: [{ taskId: "task-1", dependsOn: [], scopeKeys: ["path:src/task.txt"], priority: 0,
      instructions: "Return the bounded result", execution: { mode: "existing-session" },
      output: { kind: "text", maxBytes: 256, format: "plain", expectedMarker: "DONE" } }],
  };
}

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
