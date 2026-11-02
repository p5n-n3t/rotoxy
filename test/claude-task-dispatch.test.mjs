import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeTaskDispatch, ClaudeTaskDispatchError } from "../dist/claude-task-dispatch.js";

const PROFILE_ID = "profile-claude-0001";
const EXECUTABLE = "/opt/rotoxy/bin/claude";
const CWD = "/work/allowed-project";
const profile = (overrides = {}) => ({
  id: PROFILE_ID, kind: "claude", label: "Local Claude", cwd: CWD, binary: EXECUTABLE,
  enabled: true, allowedModels: ["claude-sonnet-4-6"],
  probeState: "available", probeCheck: "version", probeAt: 1, probeOutput: "1.0.0",
  ...overrides,
});

async function fixture(t, profiles = [profile()], mode = 0o600) {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-claude-task-dispatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryPath = join(root, "runner-profiles.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, profiles }), { mode });
  await chmod(registryPath, mode);
  const calls = [];
  const jobs = { start(request) {
    calls.push(request);
    return { runId: "owned-run-1", cancel() { calls.push("cancelled"); }, promise: Promise.resolve({ sessionId: "11111111-1111-4111-8111-111111111111", text: "completed", model: request.model, costUsd: 0.001 }) };
  } };
  const dispatch = new ClaudeTaskDispatch({ registryPath, allowedExecutables: [EXECUTABLE], allowedCwds: [CWD], jobs });
  return { dispatch, calls };
}

test("dispatch resolves private enabled runner profile and delegates one bounded run to ClaudeCodeJobs", async t => {
  const nonClaude = { ...profile(), id: "profile-opencode-0001", kind: "opencode", binary: "/opt/rotoxy/bin/opencode" };
  const { dispatch, calls } = await fixture(t, [nonClaude, profile()]);
  const handle = await dispatch.start({ profileId: PROFILE_ID, prompt: "Summarize this task." });
  assert.equal(handle.profileId, PROFILE_ID);
  assert.equal(handle.model, "claude-sonnet-4-6");
  assert.equal((await handle.promise).text, "completed");
  assert.deepEqual(calls, [{ executable: EXECUTABLE, cwd: CWD, prompt: "Summarize this task.", model: "claude-sonnet-4-6" }]);
  handle.cancel();
  assert.equal(calls.at(-1), "cancelled");
});

test("profile, model, executable, and cwd are checked before any job launch", async t => {
  const { dispatch, calls } = await fixture(t, [profile({ enabled: false })]);
  await assert.rejects(dispatch.start({ profileId: PROFILE_ID, prompt: "No" }), error => error instanceof ClaudeTaskDispatchError && error.code === "profile_disabled");
  const enabled = await fixture(t, [profile()]);
  await assert.rejects(enabled.dispatch.start({ profileId: PROFILE_ID, prompt: "No", model: "unlisted-model" }), error => error instanceof ClaudeTaskDispatchError && error.code === "model_not_allowed");
  const badPaths = await fixture(t, [profile({ binary: "/tmp/other-claude" })]);
  await assert.rejects(badPaths.dispatch.start({ profileId: PROFILE_ID, prompt: "No" }), error => error instanceof ClaudeTaskDispatchError && error.code === "path_not_allowed");
  const badCwd = await fixture(t, [profile({ cwd: "/tmp/unapproved-project" })]);
  await assert.rejects(badCwd.dispatch.start({ profileId: PROFILE_ID, prompt: "No" }), error => error instanceof ClaudeTaskDispatchError && error.code === "path_not_allowed");
  assert.equal(calls.length, 0);
  assert.equal(enabled.calls.length, 0);
  assert.equal(badPaths.calls.length, 0);
  assert.equal(badCwd.calls.length, 0);
});

test("invalid private registry and oversized prompt are rejected before dispatch", async t => {
  const insecure = await fixture(t, [profile()], 0o644);
  await assert.rejects(insecure.dispatch.start({ profileId: PROFILE_ID, prompt: "No" }), error => error instanceof ClaudeTaskDispatchError && error.code === "registry_invalid");
  const valid = await fixture(t);
  await assert.rejects(valid.dispatch.start({ profileId: PROFILE_ID, prompt: "x".repeat(128 * 1024 + 1) }), error => error instanceof ClaudeTaskDispatchError && error.code === "invalid_request");
  assert.equal(insecure.calls.length, 0);
  assert.equal(valid.calls.length, 0);
});

test("ambiguous ClaudeCodeJobs errors pass through and are not retried", async t => {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-claude-task-ambiguous-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryPath = join(root, "runner-profiles.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, profiles: [profile()] }), { mode: 0o600 });
  let starts = 0;
  const dispatch = new ClaudeTaskDispatch({ registryPath, allowedExecutables: [EXECUTABLE], allowedCwds: [CWD], jobs: {
    start() { starts++; return { runId: "owned-run", cancel() {}, promise: Promise.reject(Object.assign(new Error("execution_ambiguous"), { ambiguous: true })) }; },
  } });
  const handle = await dispatch.start({ profileId: PROFILE_ID, prompt: "Do the task once." });
  await assert.rejects(handle.promise, error => error.message === "execution_ambiguous" && error.ambiguous === true);
  assert.equal(starts, 1);
});
