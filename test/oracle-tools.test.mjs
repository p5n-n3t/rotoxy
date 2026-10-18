import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORACLE_COMMAND_TIMEOUT_MS,
  ORACLE_MAX_PROMPT_CHARS,
  ORACLE_MAX_RESULT_BYTES,
  ORACLE_MODELS,
  ORACLE_TOOL_DEFINITIONS,
  OracleTools,
  isOracleToolName,
  oracleToolRequiredScope,
} from "../dist/oracle-tools.js";

async function temporaryDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), "t2o-oracle-tools-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function isolatedTools(t, options = {}) {
  const root = await temporaryDirectory(t);
  return new OracleTools({
    supervisorCwd: join(process.cwd(), "supervisor"),
    configPath: join(root, "config.json"),
    dbPath: join(root, "queue.sqlite3"),
    ...options,
  });
}

function poolTask(id, status = "queued", extra = {}) {
  return {
    id, status, model: ORACLE_MODELS[0], source: "private prompt must not be returned", created: 100,
    updated: 101, assigned_host: status === "running" || status === "complete" ? "ora1" : null,
    attempts: 1, error_code: null, actual_model: "qwen3.5:9b", prompt_tokens: 12,
    eval_tokens: 8, remote_seconds: 2.5, elapsed_seconds: 3,
    ...extra,
  };
}

test("exports six closed MCP tool definitions and exact name recognizer", () => {
  assert.deepEqual(ORACLE_TOOL_DEFINITIONS.map((tool) => tool.name), ["oracle_catalog", "oracle_submit", "oracle_submit_batch", "oracle_cancel", "oracle_status", "oracle_result"]);
  assert.ok(ORACLE_TOOL_DEFINITIONS.every((tool) => tool.inputSchema.additionalProperties === false));
  assert.equal(isOracleToolName("oracle_submit"), true);
  assert.equal(isOracleToolName("job_submit"), false);
  assert.equal(isOracleToolName(null), false);
  assert.equal(oracleToolRequiredScope("oracle_submit"), "jobs:write");
  assert.equal(oracleToolRequiredScope("oracle_submit_batch"), "jobs:write");
  assert.equal(oracleToolRequiredScope("oracle_cancel"), "jobs:write");
  assert.equal(oracleToolRequiredScope("oracle_result"), "jobs:read");
});

test("submits prompt on stdin to fixed Python queue and returns safe queued metadata", async (t) => {
  const supervisorCwd = join(process.cwd(), "supervisor");
  const root = await temporaryDirectory(t);
  const configPath = join(root, "config.json");
  const dbPath = join(root, "queue.sqlite3");
  const calls = [];
  const tools = await isolatedTools(t, { supervisorCwd, configPath, dbPath, commandRunner: async (command, args, request) => {
    calls.push({ command, args, request });
    const id = args[args.indexOf("--id") + 1];
    return { exitCode: 0, stdout: JSON.stringify(poolTask(id, "queued", { model: args[args.indexOf("--model") + 1] })) };
  } });
  const prompt = "Keep this only on stdin";
  const result = await tools.call("oracle_submit", { jobId: "job-A", prompt, model: "gpt-oss:20b" }, "oauth-client-a");
  assert.deepEqual(result, { jobId: "job-A", state: "queued", model: "gpt-oss:20b", attempts: 1, promptTokens: 12, evalTokens: 8, createdAt: 100, updatedAt: 101, remoteSeconds: 2.5, elapsedSeconds: 3, actualModel: "qwen3.5:9b" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/python3");
  assert.deepEqual(calls[0].args.slice(0, 8), ["-m", "snooze.oracle_pool", "--config", configPath, "--db", dbPath, "submit", "--stdin"]);
  assert.deepEqual(calls[0].args.slice(8, 12), ["--model", "gpt-oss:20b", "--id", calls[0].args[11]]);
  assert.match(calls[0].args[11], /^o[0-9a-f]{44}:job-A$/);
  assert.equal(calls[0].args.includes(prompt), false);
  assert.equal(calls[0].request.stdin, prompt);
  assert.equal(calls[0].request.cwd, supervisorCwd);
  assert.equal(calls[0].request.timeoutMs, ORACLE_COMMAND_TIMEOUT_MS);
  assert.ok(!JSON.stringify(result).includes("private prompt"));
});

test("cached catalog projects approved models and valid registry host IDs without a three-host ceiling", async (t) => {
  const calls = [];
  const tools = await isolatedTools(t, { commandRunner: async (command, args) => {
    calls.push([command, args]);
    return { exitCode: 0, stdout: JSON.stringify({ hosts: [
      { id: "ora1", ip: "private-ip", models: [ORACLE_MODELS[1], "unapproved-model"], updated: 20, assigned: 99 },
      { id: "ora6", models: [ORACLE_MODELS[0]], updated: 21 },
      { id: "future-worker", models: [ORACLE_MODELS[0]], updated: 22 },
      { id: "../unexpected-host", models: [ORACLE_MODELS[0]] },
    ] }) };
  } });
  const result = await tools.call("oracle_catalog", {}, "oauth-client-a");
  assert.deepEqual(calls[0][1].slice(-1), ["catalog"]);
  assert.ok(!calls[0][1].includes("--refresh"));
  assert.deepEqual(result, { hosts: [{ host: "ora1", models: [ORACLE_MODELS[1]], updatedAt: 20 }, { host: "ora6", models: [ORACLE_MODELS[0]], updatedAt: 21 }, { host: "future-worker", models: [ORACLE_MODELS[0]], updatedAt: 22 }] });
  assert.ok(!JSON.stringify(result).includes("private-ip"));
});

test("stable caller hash namespaces identical job IDs and status/result only query that namespace", async (t) => {
  const calls = [];
  const tools = await isolatedTools(t, { commandRunner: async (_command, args) => {
    calls.push([...args]);
    const id = args[args.indexOf("--id") + 1];
    if (args.includes("submit")) return { exitCode: 0, stdout: JSON.stringify(poolTask(id)) };
    if (args.includes("status")) return { exitCode: 0, stdout: JSON.stringify(poolTask(id, "complete")) };
    return { exitCode: 0, stdout: JSON.stringify({ id, status: "complete", result: "answer", actual_model: "qwen3.5:9b", prompt_tokens: 2, eval_tokens: 3, remote_seconds: 1, elapsed_seconds: 2 }) };
  } });
  await tools.call("oracle_submit", { jobId: "same-id", prompt: "alpha" }, "caller-one");
  await tools.call("oracle_submit", { jobId: "same-id", prompt: "beta" }, "caller-two");
  const idOne = calls[0][calls[0].indexOf("--id") + 1];
  const idTwo = calls[1][calls[1].indexOf("--id") + 1];
  assert.notEqual(idOne, idTwo);
  assert.equal(idOne.endsWith(":same-id"), true);
  assert.equal(idTwo.endsWith(":same-id"), true);
  const status = await tools.call("oracle_status", { jobId: "same-id" }, "caller-one");
  const result = await tools.call("oracle_result", { jobId: "same-id" }, "caller-one");
  assert.equal(calls[2][calls[2].indexOf("--id") + 1], idOne);
  assert.equal(calls[3][calls[3].indexOf("--id") + 1], idOne);
  assert.equal(calls[4][calls[4].indexOf("--id") + 1], idOne);
  assert.equal(result.result, "answer");
  assert.equal(status.state, "complete");
});

test("batch submit forwards every independent task in one caller-namespaced atomic CLI request", async (t) => {
  const calls = [];
  const tools = await isolatedTools(t, { commandRunner: async (_command, args, request) => {
    calls.push({ args: [...args], request });
    const payload = JSON.parse(request.stdin);
    return { exitCode: 0, stdout: JSON.stringify(payload.tasks.map((item) => poolTask(item.job_id, "queued", { model: item.model }))) };
  } });
  const input = { tasks: [
    { jobId: "batch-a", prompt: "Independent prompt A" },
    { jobId: "batch-b", prompt: "Independent prompt B", model: "gpt-oss:20b" },
  ] };
  const first = await tools.call("oracle_submit_batch", input, "caller-one");
  const second = await tools.call("oracle_submit_batch", input, "caller-two");

  assert.equal(calls.length, 2, "one subprocess call for each complete batch, never one call per item");
  for (const call of calls) {
    assert.deepEqual(call.args.slice(-2), ["submit-batch", "--stdin-json"]);
    const payload = JSON.parse(call.request.stdin);
    assert.equal(payload.tasks.length, 2);
    assert.equal(payload.tasks[0].text, "Independent prompt A");
    assert.equal(payload.tasks[1].text, "Independent prompt B");
    assert.ok(payload.tasks.every((item) => /^o[0-9a-f]{44}:batch-[ab]$/.test(item.job_id)));
    assert.ok(call.args.every((arg) => !arg.includes("Independent prompt")));
  }
  const firstIds = first.tasks.map((task) => task.jobId);
  const secondIds = second.tasks.map((task) => task.jobId);
  assert.deepEqual(firstIds, ["batch-a", "batch-b"]);
  assert.deepEqual(secondIds, ["batch-a", "batch-b"]);
  const rawIds = calls.map((call) => JSON.parse(call.request.stdin).tasks.map((item) => item.job_id));
  assert.notDeepEqual(rawIds[0], rawIds[1], "same external IDs in different OAuth callers get isolated storage IDs");
  assert.ok(first.tasks.every((task) => task.state === "queued"));
});

test("rejects malformed, duplicate, oversized and out-of-bound batches before enqueue", async (t) => {
  let calls = 0;
  const tools = await isolatedTools(t, { commandRunner: async () => { calls++; return { exitCode: 0, stdout: "[]" }; } });
  await assert.rejects(tools.call("oracle_submit_batch", { tasks: [] }, "client"), (error) => error.code === "invalid_arguments");
  await assert.rejects(tools.call("oracle_submit_batch", { tasks: Array.from({ length: 13 }, (_, i) => ({ jobId: `id-${i}`, prompt: "x" })) }, "client"), (error) => error.code === "invalid_arguments");
  await assert.rejects(tools.call("oracle_submit_batch", { tasks: [{ jobId: "same", prompt: "one" }, { jobId: "same", prompt: "two" }] }, "client"), (error) => error.code === "invalid_arguments");
  await assert.rejects(tools.call("oracle_submit_batch", { tasks: [{ jobId: "bad", prompt: "x", shell: "true" }] }, "client"), (error) => error.code === "invalid_arguments");
  await assert.rejects(tools.call("oracle_submit_batch", { tasks: [{ jobId: "bad", prompt: "x", model: "unapproved" }] }, "client"), (error) => error.code === "model_not_allowed");
  await assert.rejects(tools.call("oracle_submit_batch", { tasks: [{ jobId: "bad", prompt: "x" }], arbitrary: true }, "client"), (error) => error.code === "invalid_arguments");
  assert.equal(calls, 0);
});

test("queued cancellation returns cancelled state and running cancellation is explicitly refused", async (t) => {
  const calls = [];
  const tools = await isolatedTools(t, { commandRunner: async (_command, args) => {
    calls.push([...args]);
    const id = args[args.indexOf("--id") + 1];
    if (id.endsWith(":running-job")) return { exitCode: 2, stdout: JSON.stringify({ error: "task_inference_not_cancellable" }) };
    if (args.includes("cancel")) return { exitCode: 0, stdout: JSON.stringify({ id, status: "cancelled", cancelled: true }) };
    return { exitCode: 0, stdout: JSON.stringify(poolTask(id, "cancelled")) };
  } });
  const cancelled = await tools.call("oracle_cancel", { jobId: "queued-job" }, "client");
  assert.deepEqual(cancelled, { jobId: "queued-job", state: "cancelled", cancelled: true });
  assert.equal(calls[0].at(-3), "cancel");
  const status = await tools.call("oracle_status", { jobId: "queued-job" }, "client");
  assert.equal(status.state, "cancelled");
  await assert.rejects(tools.call("oracle_cancel", { jobId: "running-job" }, "client"), (error) => {
    assert.equal(error.code, "running_task_not_cancellable");
    assert.equal(error.message, "running_task_not_cancellable");
    return true;
  });
  assert.equal(calls.filter((args) => args.includes("cancel")).length, 2);
});

test("rejects unknown keys, prompts over 4000 Unicode characters, and disallowed models before launch", async (t) => {
  let calls = 0;
  const tools = await isolatedTools(t, { commandRunner: async () => { calls++; return { exitCode: 0, stdout: "{}" }; } });
  await assert.rejects(tools.call("oracle_catalog", { refresh: true }, "client"), (error) => error.code === "invalid_arguments");
  await assert.rejects(tools.call("oracle_submit", { jobId: "a", prompt: "x", arbitraryCommand: "ssh" }, "client"), (error) => error.code === "invalid_arguments");
  await assert.rejects(tools.call("oracle_submit", { jobId: "a", prompt: "😀".repeat(ORACLE_MAX_PROMPT_CHARS + 1) }, "client"), (error) => error.code === "invalid_arguments");
  await assert.rejects(tools.call("oracle_submit", { jobId: "a", prompt: "x", model: "other:latest" }, "client"), (error) => error.code === "model_not_allowed");
  await assert.rejects(tools.call("oracle_status", { jobId: "a", all: true }, "client"), (error) => error.code === "invalid_arguments");
  assert.equal(calls, 0);
});

test("rejects cross-caller or malformed pool IDs and bounds provider result text", async (t) => {
  const tools = await isolatedTools(t, { commandRunner: async (_command, args) => {
    const id = args[args.indexOf("--id") + 1];
    if (args.includes("status")) return { exitCode: 0, stdout: JSON.stringify(poolTask(id, "complete")) };
    return { exitCode: 0, stdout: JSON.stringify({ id: `o${"0".repeat(44)}:other-job`, status: "complete", result: "wrong tenant" }) };
  } });
  const cross = await isolatedTools(t, { commandRunner: async (_command, args) => {
    return { exitCode: 0, stdout: JSON.stringify(poolTask(`o${"0".repeat(44)}:owned-job`, "complete")) };
  } });
  await assert.rejects(cross.call("oracle_status", { jobId: "owned-job" }, "client"), (error) => error.code === "job_not_found");
  const huge = "x".repeat(ORACLE_MAX_RESULT_BYTES + 1);
  const tooLarge = await isolatedTools(t, { commandRunner: async (_command, args) => {
    const id = args[args.indexOf("--id") + 1];
    if (args.includes("status")) return { exitCode: 0, stdout: JSON.stringify(poolTask(id, "complete")) };
    return { exitCode: 0, stdout: JSON.stringify({ id, status: "complete", result: huge }) };
  } });
  await assert.rejects(tooLarge.call("oracle_result", { jobId: "owned-job" }, "client"), (error) => error.code === "invalid_pool_response");
});

test("bounds stdout, discards stderr and returns safe command failures", async (t) => {
  const huge = "x".repeat(1025);
  const outputBounded = await isolatedTools(t, { maxStdoutBytes: 1024, commandRunner: async () => ({ exitCode: 0, stdout: huge, stderr: "secret stderr" }) });
  await assert.rejects(outputBounded.call("oracle_catalog", {}, "client"), (error) => error.code === "output_too_large");
  const failed = await isolatedTools(t, { commandRunner: async () => { throw new Error("private prompt and credential"); } });
  await assert.rejects(failed.call("oracle_catalog", {}, "client"), (error) => {
    assert.equal(error.code, "command_failed");
    assert.equal(error.message, "command_failed");
    return true;
  });
});

test("enforces a timeout even for an injected runner", async (t) => {
  const tools = await isolatedTools(t, { timeoutMs: 100, commandRunner: async (_command, _args, request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
  }) });
  await assert.rejects(tools.call("oracle_catalog", {}, "client"), (error) => error.code === "command_timeout");
});

test("real Python queue integration submits, polls and reads queued job without SSH/inference", async (t) => {
  try { await access("/usr/bin/python3"); } catch { t.skip("/usr/bin/python3 unavailable"); return; }
  const root = await temporaryDirectory(t);
  const tools = new OracleTools({
    supervisorCwd: join(process.cwd(), "supervisor"),
    configPath: join(root, "config.json"),
    dbPath: join(root, "queue.sqlite3"),
  });
  const client = "integration-client";
  const catalog = await tools.call("oracle_catalog", {}, client);
  assert.deepEqual(catalog.hosts.map((host) => host.host), ["ora1", "ora3", "ora5"]);
  const submitted = await tools.call("oracle_submit", { jobId: "integration-1", prompt: "queue-only test" }, client);
  assert.equal(submitted.state, "queued");
  assert.equal(submitted.jobId, "integration-1");
  assert.equal((await tools.call("oracle_status", { jobId: "integration-1" }, client)).state, "queued");
  const result = await tools.call("oracle_result", { jobId: "integration-1" }, client);
  assert.equal(result.state, "queued");
  assert.equal(result.result, null);
});
