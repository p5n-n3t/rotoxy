import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ClaudeCodeJobs, ClaudeCodeJobError } from "../dist/providers/claude-code-jobs.js";

const FIXTURE = `#!${process.execPath}
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (value("--model") === "fixture-hang") {
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1000);
} else {
  const chunks = [];
  process.stdin.on("data", chunk => chunks.push(chunk));
  process.stdin.on("end", () => {
    const sessionId = value("--resume") ?? value("--session-id");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: Buffer.concat(chunks).toString("utf8"), model: value("--model") ?? "fixture-model", usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.001, stop_reason: "end_turn" }));
  });
}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-claude-jobs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"); await mkdir(cwd);
  const executable = join(root, "claude-fixture"); await writeFile(executable, FIXTURE, { mode: 0o700 }); await chmod(executable, 0o700);
  return { root, cwd, executable };
}

test("Claude Code job runs the trusted local CLI with structured output and stdin prompt", async (t) => {
  const { cwd, executable } = await fixture(t);
  let observed;
  const jobs = new ClaudeCodeJobs({
    allowedExecutables: [executable], allowedCwds: [cwd],
    bedrockEnv: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1", AWS_PROFILE: "fixture-profile" },
    spawnProcess: (command, args, options) => {
      observed = { command, args: [...args], options };
      return spawn(command, [...args], options);
    },
  });
  const prompt = "Implement the change.\nKeep the second line.";
  const result = await jobs.start({ executable, cwd, prompt, model: "fixture-sonnet", timeoutMs: 5000 }).promise;
  assert.equal(result.text, prompt);
  assert.equal(result.model, "fixture-sonnet");
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 4 });
  assert.equal(result.costUsd, 0.001);
  assert.equal(result.stopReason, "end_turn");
  assert.match(result.sessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(observed.command, executable);
  assert.ok(observed.args.includes("--print"));
  assert.ok(observed.args.includes("--bare"), "project hooks and repository MCP settings are not loaded implicitly");
  assert.deepEqual(observed.args.slice(observed.args.indexOf("--output-format"), observed.args.indexOf("--output-format") + 2), ["--output-format", "json"]);
  assert.ok(observed.args.includes("--permission-prompts") && observed.args.includes("none"));
  assert.deepEqual(observed.args.slice(observed.args.indexOf('--tools'),observed.args.indexOf('--tools')+2),['--tools','Read,Glob,Grep']);
  assert.ok(observed.args.includes("--session-id"));
  assert.equal(observed.args.includes(prompt), false, "prompt bytes are sent through stdin rather than process arguments");
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.cwd, cwd);
  assert.equal(observed.options.env.AWS_REGION, "us-east-1");
  assert.equal(observed.options.env.AWS_PROFILE, "fixture-profile");
  assert.equal(observed.options.env.AWS_SECRET_ACCESS_KEY, undefined, "unconfigured provider secrets are not inherited");
  assert.equal(observed.options.env.NODE_OPTIONS, undefined, "arbitrary process settings are not inherited");
});

test("resume session and path allowlists are exact; rejected paths never spawn", async (t) => {
  const { root, cwd, executable } = await fixture(t);
  let spawnCount = 0;
  const jobs = new ClaudeCodeJobs({ allowedExecutables: [executable], allowedCwds: [cwd], spawnProcess: (...args) => { spawnCount++; return spawn(args[0], [...args[1]], args[2]); } });
  const resumeSessionId = "11111111-1111-4111-8111-111111111111";
  const result = await jobs.start({ executable, cwd, prompt: "Continue", resumeSessionId, timeoutMs: 5000 }).promise;
  assert.equal(result.sessionId, resumeSessionId);
  await assert.rejects(jobs.start({ executable: join(root, "other-claude"), cwd, prompt: "No" }).promise, error => error instanceof ClaudeCodeJobError && error.code === "executable_not_allowed");
  await assert.rejects(jobs.start({ executable, cwd: root, prompt: "No" }).promise, error => error instanceof ClaudeCodeJobError && error.code === "cwd_not_allowed");
  assert.equal(spawnCount, 1);
});

test("timeout is ambiguous, terminates only the owned child, and does not retry", async (t) => {
  const { cwd, executable } = await fixture(t);
  const signals = [];
  let childRef, resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const jobs = new ClaudeCodeJobs({
    allowedExecutables: [executable], allowedCwds: [cwd], terminationGraceMs: 100,
    spawnProcess: (command, args, options) => { childRef = spawn(command, [...args], options); const kill = childRef.kill.bind(childRef); childRef.kill = (signal) => { signals.push(signal); return kill(signal); }; childRef.once("close", resolveClosed); return childRef; },
  });
  const handle = jobs.start({ executable, cwd, prompt: "Wait", model: "fixture-hang", timeoutMs: 1500 });
  await assert.rejects(handle.promise, error => error instanceof ClaudeCodeJobError && error.code === "execution_ambiguous" && error.ambiguous);
  assert.ok(childRef.pid > 0);
  assert.ok(signals.includes("SIGTERM"));
  await closed;
  assert.equal(jobs.cancel(handle.runId), false, "finished attempts cannot target another process by stale PID");
});

test("explicit cancellation after spawn is ambiguous and uses only its child handle", async (t) => {
  const { cwd, executable } = await fixture(t);
  const signals = [];
  let childRef, resolveSpawned;
  const spawned = new Promise(resolve => { resolveSpawned = resolve; });
  const jobs = new ClaudeCodeJobs({
    allowedExecutables: [executable], allowedCwds: [cwd], terminationGraceMs: 100,
    spawnProcess: (command, args, options) => { childRef = spawn(command, [...args], options); const kill = childRef.kill.bind(childRef); childRef.kill = (signal) => { signals.push(signal); return kill(signal); }; childRef.once("spawn", resolveSpawned); return childRef; },
  });
  const handle = jobs.start({ executable, cwd, prompt: "Wait", model: "fixture-hang", timeoutMs: 5000 });
  await spawned;
  handle.cancel();
  await assert.rejects(handle.promise, error => error instanceof ClaudeCodeJobError && error.code === "execution_ambiguous" && error.ambiguous);
  assert.ok(childRef.pid > 0);
  assert.ok(signals.includes("SIGTERM"));
});
