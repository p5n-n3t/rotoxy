import test from "node:test";
import assert from "node:assert/strict";
import { buildCanaryTasks, parseArgs, validateCanaryResources } from "../scripts/verify-inference-fleet.mjs";

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
