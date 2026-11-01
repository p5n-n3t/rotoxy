import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InferenceJobsAdapter, inferenceRequest } from "../dist/providers/inference-jobs.js";

const operation = (provider, model) => ({
  operationId: "0123456789abcdef0123456789abcdef", attemptId: "abcdef0123456789abcdef0123456789", generation: 1,
  selectedAccountId: provider === "cloudflare" ? "CloudflareCred_1234" : "oracle-cluster",
  kind: "run_inference", input: { provider, model, prompt: "Answer briefly", maxOutputTokens: 100,
    expectedMarker: "DONE", dispatchAt: 100 },
});

test("inferenceRequest accepts only the durable bounded outbox shape", () => {
  assert.equal(inferenceRequest(operation("oracle", "oracle/qwen3.5:2b")).provider, "oracle");
  const extra = operation("oracle", "oracle/qwen3.5:2b"); extra.input.url = "https://example.test";
  assert.equal(inferenceRequest(extra), undefined);
  assert.equal(inferenceRequest(operation("oracle", "@cf/meta/llama")), undefined);
});

test("Cloudflare inference pins the credential and retains marker and usage provenance", async () => {
  let account;
  const adapter = new InferenceJobsAdapter({
    now: () => 123_000,
    cloudflare: { runForAccountWithReceipt: async (id, input) => {
      account = id;
      assert.equal(input.model, "@cf/meta/model");
      assert.equal(input.input.max_tokens, 100);
      assert.match(input.input.prompt, /final nonempty line: DONE/);
      return { credentialId: id, providerAccountId: "0123456789abcdef0123456789abcdef",
        result: { success: true, result: { response: "Answer\nDONE", usage: { prompt_tokens: 4, completion_tokens: 7, total_tokens: 11 } } } };
    } },
  });
  const result = await adapter.invoke({ ...inferenceRequest(operation("cloudflare", "@cf/meta/model")), accountId: "CloudflareCred_1234" });
  assert.equal(account, "CloudflareCred_1234");
  assert.equal(result.classification, "accepted");
  assert.equal(result.value.reportedModel, null);
  assert.equal(result.value.modelEvidence, "pinned_endpoint");
  assert.equal(result.value.terminationEvidence, "expected_marker");
  assert.equal(result.value.providerAccountId, "0123456789abcdef0123456789abcdef");
  assert.equal(result.value.providerUsage.completion_tokens, 7);
});

test("Oracle inference uses a fixed private origin, secured token file, and provider finish evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rotoxy-oracle-inference-"));
  const tokenFile = join(dir, "api-token");
  await writeFile(tokenFile, `${"T".repeat(32)}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  let called = false;
  const adapter = new InferenceJobsAdapter({ oracleTokenFile: tokenFile, now: () => 456_000, oracleAllowedHosts: async () => ["ora8"],
    fetch: async (url, init) => {
      called = true;
      assert.equal(url, "http://100.114.191.111:8877/v1/chat/completions");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.authorization, `Bearer ${"T".repeat(32)}`);
      const payload = JSON.parse(init.body);
      assert.equal(payload.model, "qwen3.5:2b");
      assert.equal(payload.stream, false);
      assert.equal(payload.max_tokens, 100);
      assert.deepEqual(payload.allowed_hosts, ["ora8"]);
      return new Response(JSON.stringify({ model: "qwen3.5:2b", choices: [{
        finish_reason: "stop", message: { content: "Answer\nDONE" },
      }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), {
        status: 200, headers: { "content-type": "application/json", "x-oracle-host": "ora8" },
      });
    } });
  try {
    const result = await adapter.invoke({ ...inferenceRequest(operation("oracle", "oracle/qwen3.5:2b")), accountId: "oracle-cluster" });
    assert.equal(called, true);
    assert.equal(result.classification, "accepted");
    assert.equal(result.value.reportedModel, "oracle/qwen3.5:2b");
    assert.equal(result.value.modelEvidence, "provider_reported");
    assert.equal(result.value.terminationEvidence, "provider_finish");
    assert.equal(result.value.finishReason, "stop");
    assert.equal(result.value.providerHost, "ora8");
    assert.equal(result.value.providerUsage.total_tokens, 7);
    const wrongHostAdapter = new InferenceJobsAdapter({ oracleTokenFile: tokenFile,
      oracleAllowedHosts: async () => ["ora8"], fetch: async () => Response.json({ model: "qwen3.5:2b",
        choices: [{ finish_reason: "stop", message: { content: "Answer\nDONE" } }] },
      { status: 200, headers: { "x-oracle-host": "ora1" } }) });
    const wrongHost = await wrongHostAdapter.invoke({ ...inferenceRequest(operation("oracle", "oracle/qwen3.5:2b")), accountId: "oracle-cluster" });
    assert.equal(wrongHost.classification, "ambiguous");
    assert.equal(wrongHost.reason, "oracle_worker_attribution_invalid");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
