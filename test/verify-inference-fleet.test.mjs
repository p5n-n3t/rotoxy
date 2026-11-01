import test from "node:test";
import assert from "node:assert/strict";
import { buildCanaryTasks, executeCanaryJobFlow, inspectCanaryResources, parseArgs, validateCanaryResources, assertOracleCredentialReady } from "../scripts/verify-inference-fleet.mjs";
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = ["--config", "/private/runtime.json", "--state-dir", "/private/state", "--project-id", "canary-project",
  "--cloudflare-account-id", "CloudflareCred_12345678", "--oracle-account-id", "oracle-canary", "--job-id", "stable-canary-20261101"];

test("canary refuses provider execution unless explicitly enabled", () => {
  assert.throws(() => parseArgs(cli), /explicit --execute/);
  assert.equal(parseArgs([...cli, "--execute"]).job_id, "stable-canary-20261101");
  assert.throws(() => parseArgs(["--execute", ...cli.slice(0, -2)]), /--job-id is required/);
});

test("canary DAG has two independent provider checks and an Oracle join behind both", () => {
  const tasks = buildCanaryTasks("stable-canary-20261101", "oracle/qwen3.5:2b", "@cf/meta/llama-3.1-8b-instruct");
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks[0].dependsOn, []);
  assert.deepEqual(tasks[1].dependsOn, []);
  assert.deepEqual(tasks[2].dependsOn, ["oracle-independent", "cloudflare-independent"]);
  assert.deepEqual(tasks.map(task => task.execution.maxOutputTokens), [64, 64, 64]);
  assert.ok(tasks.every(task => task.output.expectedMarker.startsWith("stable-canary-20261101-")));
  assert.ok(tasks.every(task => task.instructions === `Reply exactly ${task.output.expectedMarker} and nothing else. Do not add an explanation, preamble, or other text.`));
});

test("resource preflight requires exact enabled healthy allowlisted models and unknown quota", () => {
  const resources = [
    { accountId: "oracle-canary", provider: "oracle", enabled: true, authorized: true, health: "healthy", quota: "unknown",
      models: ["oracle/qwen3.5:2b"], maxOutputTokens: 128, capacity: 2, provenance: "inventory" },
    { accountId: "CloudflareCred_12345678", provider: "cloudflare", enabled: true, authorized: true, health: "healthy", quota: "unknown",
      models: ["@cf/meta/llama-3.1-8b-instruct"], maxOutputTokens: 4096, capacity: 1, provenance: "catalog" },
  ];
  assert.equal(validateCanaryResources(resources, { oracleAccountId: "oracle-canary", cloudflareAccountId: "CloudflareCred_12345678",
    oracleModel: "oracle/qwen3.5:2b", cloudflareModel: "@cf/meta/llama-3.1-8b-instruct" }).oracle.capacity, 2);
  for (const mutation of [
    row => { row.enabled = false; }, row => { row.health = "unknown"; }, row => { row.quota = "available"; },
    row => { row.models = []; }, row => { row.capacity = 0; },
  ]) {
    const bad = structuredClone(resources); mutation(bad[0]);
    assert.throws(() => validateCanaryResources(bad, { oracleAccountId: "oracle-canary", cloudflareAccountId: "CloudflareCred_12345678",
      oracleModel: "oracle/qwen3.5:2b", cloudflareModel: "@cf/meta/llama-3.1-8b-instruct" }), /oracle_resource_not_currently_eligible/);
  }
});

test("resource preflight reports redacted capability blockers without exposing provider payloads", () => {
  const result = inspectCanaryResources([{ accountId: "cf", provider: "cloudflare", enabled: true, authorized: true,
    health: "unknown", quota: "unknown", models: [], maxOutputTokens: 64, capacity: 1,
    provenance: "encrypted_credential_allowlist_and_live_model_catalog" }], {
    oracleAccountId: "oracle", cloudflareAccountId: "cf", oracleModel: "oracle/qwen3.5:2b", cloudflareModel: "@cf/meta/model",
  });
  assert.deepEqual(result.oracle.reasons, ["resource_missing"]);
  assert.ok(result.cloudflare.reasons.includes("health_unknown"));
  assert.ok(result.cloudflare.reasons.includes("model_not_in_live_allowlist_catalog"));
  assert.equal(JSON.stringify(result).includes("token"), false);
});

test("Oracle credential preflight accepts only an owner-only regular file and never reads token contents", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rotoxy-canary-token-"));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "api-token");
  await writeFile(tokenFile, "private-token-value\n", { mode: 0o600 });
  await assertOracleCredentialReady(tokenFile, process.getuid?.());
  const publicFile = join(dir, "public-token");
  await writeFile(publicFile, "private-token-value\n", { mode: 0o644 });
  await assert.rejects(assertOracleCredentialReady(publicFile, process.getuid?.()), /owner-only/);
  await assert.rejects(assertOracleCredentialReady("relative-token-file", process.getuid?.()), /owner-only/);
});

test("stubbed MCP job lifecycle verifies parallel tasks, dependency join, markers, and same-key idempotency without provider calls", async () => {
  const jobId = "stable-canary-20261101";
  const body = { jobId, idempotencyKey: jobId, tasks: buildCanaryTasks(jobId, "oracle/qwen3.5:2b", "@cf/meta/model") };
  const counts = { job_submit: 0, job_status: 0, job_results: 0 };
  const completeRows = [
    { taskId: "oracle-independent", state: "complete", selectedAccountId: "oracle", dependsOn: [] },
    { taskId: "cloudflare-independent", state: "complete", selectedAccountId: "cf", dependsOn: [] },
    { taskId: "oracle-dependency-join", state: "complete", selectedAccountId: "oracle", dependsOn: ["oracle-independent", "cloudflare-independent"] },
  ];
  const callTool = async (name, args) => {
    counts[name]++;
    if (name === "job_submit") {
      assert.equal(args.idempotencyKey, jobId);
      return { assignmentId: jobId, taskCount: 3, state: counts.job_submit === 1 ? "queued" : "complete" };
    }
    if (name === "job_status") return counts.job_status === 1
      ? { state: "running", tasks: [
        { ...completeRows[0], state: "running" }, { ...completeRows[1], state: "running" }, completeRows[2],
      ] }
      : { state: "complete", tasks: completeRows };
    if (name === "job_results") return { results: body.tasks.map(task => ({ taskId: task.taskId,
      text: `OK\n${task.output.expectedMarker}`, reportedModel: task.execution.provider === "oracle" ? task.execution.model : null,
      finishReason: task.execution.provider === "oracle" ? "stop" : null,
      terminationEvidence: task.execution.provider === "oracle" ? "provider_finish" : "expected_marker" })) };
    throw new Error("unexpected fake tool");
  };
  const result = await executeCanaryJobFlow({ callTool, projectId: "canary-project", jobId, body,
    oracleAccountId: "oracle", cloudflareAccountId: "cf", pollMs: 0, pauseFn: async () => {} });
  assert.equal(result.state, "complete");
  assert.equal(result.parallelIndependentObserved, true);
  assert.equal(result.tasks.every(task => task.markerMatched), true);
  assert.equal(result.idempotency, "same_assignment_returned_without_new_provider_operations");
  assert.equal(counts.job_submit, 2, "only the confirmed terminal duplicate is submitted to test idempotency");
  assert.equal(counts.job_results, 1);
});

test("blocked provider task stops polling and does not retry the job or wait on queued dependents", async () => {
  const jobId = "stable-canary-20261101";
  const body = { jobId, idempotencyKey: jobId, tasks: buildCanaryTasks(jobId, "oracle/qwen3.5:2b", "@cf/meta/model") };
  let statuses = 0, submits = 0;
  const result = await executeCanaryJobFlow({ projectId: "canary-project", jobId, body, oracleAccountId: "oracle", cloudflareAccountId: "cf",
    callTool: async (name) => {
      if (name === "job_submit") { submits++; return { assignmentId: jobId, taskCount: 3, state: "queued" }; }
      if (name === "job_status") { statuses++; return { state: "held", tasks: [
        { taskId: "oracle-independent", state: "complete", selectedAccountId: "oracle", dependsOn: [] },
        { taskId: "cloudflare-independent", state: "blocked", selectedAccountId: "cf", dependsOn: [] },
        { taskId: "oracle-dependency-join", state: "queued", selectedAccountId: "oracle", dependsOn: ["oracle-independent", "cloudflare-independent"] },
      ] }; }
      throw new Error("no results are available for a blocked job");
    }, pollMs: 60_000 });
  assert.equal(result.state, "blocked");
  assert.equal(statuses, 1);
  assert.equal(submits, 1);
  assert.ok(result.blockers.some(message => message.includes("marker")));
});

test("ambiguous MCP submission is never replayed", async () => {
  let submits = 0;
  const body = { tasks: buildCanaryTasks("stable-canary-20261101", "oracle/qwen3.5:2b", "@cf/meta/model") };
  const result = await executeCanaryJobFlow({ projectId: "canary-project", jobId: "stable-canary-20261101", body,
    oracleAccountId: "oracle", cloudflareAccountId: "cf", callTool: async () => { submits++; throw new Error("connection_lost"); } });
  assert.equal(result.submission, "ambiguous");
  assert.equal(submits, 1);
});
