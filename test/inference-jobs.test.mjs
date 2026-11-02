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
  let account, forwardedSignal;
  const controller = new AbortController();
  const adapter = new InferenceJobsAdapter({
    now: () => 123_000,
    cloudflare: { runForAccountWithReceipt: async (id, input, signal) => {
      account = id;
      forwardedSignal = signal;
      assert.equal(input.model, "@cf/meta/model");
      assert.deepEqual(input.input.messages, [{ role: "user", content: "Answer briefly\n\nFinish with this exact marker as the final nonempty line: DONE" }]);
      assert.equal(input.input.max_tokens, 100);
      assert.equal(input.input.temperature, 0);
      assert.equal(input.input.prompt, undefined, "the selected chat-model request uses the messages form that passed the direct canary");
      return { credentialId: id, providerAccountId: "0123456789abcdef0123456789abcdef",
        result: { success: true, result: { response: "Answer\nDONE", usage: { prompt_tokens: 4, completion_tokens: 7, total_tokens: 11 } } } };
    } },
  });
  const result = await adapter.invoke({ ...inferenceRequest(operation("cloudflare", "@cf/meta/model")), accountId: "CloudflareCred_1234" }, controller.signal);
  assert.equal(account, "CloudflareCred_1234");
  assert.equal(forwardedSignal, controller.signal);
  assert.equal(result.classification, "accepted");
  assert.equal(result.value.reportedModel, null);
  assert.equal(result.value.modelEvidence, "pinned_endpoint");
  assert.equal(result.value.terminationEvidence, "expected_marker");
  assert.equal(result.value.providerAccountId, "0123456789abcdef0123456789abcdef");
  assert.equal(result.value.providerUsage.completion_tokens, 7);
  assert.equal(result.value.requestStartedAt, 123);
  assert.equal(result.value.assistantAt, 123);
});

test("Cloudflare completion requires the exact final marker and a non-truncated finish", async () => {
  const invoke = (response) => new InferenceJobsAdapter({
    cloudflare: { runForAccountWithReceipt: async (id) => ({ credentialId: id,
      providerAccountId: "0123456789abcdef0123456789abcdef",
      result: { success: true, result: response } }) },
  }).invoke({ ...inferenceRequest(operation("cloudflare", "@cf/meta/model")), accountId: "CloudflareCred_1234" });

  const missing = await invoke({ response: "A generic greeting with no requested marker" });
  assert.equal(missing.classification, "ambiguous");
  assert.equal(missing.reason, "cloudflare_completion_marker_missing");
  const wrongFinalLine = await invoke({ response: "Useful result\nDONE extra" });
  assert.equal(wrongFinalLine.classification, "ambiguous");
  assert.equal(wrongFinalLine.reason, "cloudflare_completion_marker_missing");
  const truncated = await invoke({ response: "Answer\nDONE\n", finish_reason: "length" });
  assert.equal(truncated.classification, "ambiguous");
  assert.equal(truncated.reason, "cloudflare_response_truncated");
  const complete = await invoke({ response: "Answer\nDONE\n\n", finish_reason: "stop" });
  assert.equal(complete.classification, "accepted");
  assert.equal(complete.value.terminationEvidence, "expected_marker");
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
    assert.equal(result.value.requestStartedAt, 456);
    assert.equal(result.value.assistantAt, 456);
    const wrongHostAdapter = new InferenceJobsAdapter({ oracleTokenFile: tokenFile,
      oracleAllowedHosts: async () => ["ora8"], fetch: async () => Response.json({ model: "qwen3.5:2b",
        choices: [{ finish_reason: "stop", message: { content: "Answer\nDONE" } }] },
      { status: 200, headers: { "x-oracle-host": "ora1" } }) });
    const wrongHost = await wrongHostAdapter.invoke({ ...inferenceRequest(operation("oracle", "oracle/qwen3.5:2b")), accountId: "oracle-cluster" });
    assert.equal(wrongHost.classification, "ambiguous");
    assert.equal(wrongHost.reason, "oracle_worker_attribution_invalid");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Oracle post-dispatch 408 and 5xx stay ambiguous while known preflight rejection does not retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rotoxy-oracle-status-"));
  const tokenFile = join(dir, "api-token");
  await writeFile(tokenFile, `${"T".repeat(32)}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  try {
    for (const [status, classification] of [[408, "ambiguous"], [502, "ambiguous"], [504, "ambiguous"], [429, "rejected"]]) {
      let calls = 0;
      const adapter = new InferenceJobsAdapter({ oracleTokenFile: tokenFile, oracleAllowedHosts: async () => ["ora8"],
        fetch: async (_url, init) => {
          calls++;
          assert.equal(init.method, "POST");
          assert.equal(init.redirect, "error");
          assert.match(init.headers.authorization, /^Bearer T{32}$/);
          return new Response("private provider response body", { status });
        } });
      const result = await adapter.invoke({ ...inferenceRequest(operation("oracle", "oracle/qwen3.5:2b")), accountId: "oracle-cluster" });
      assert.equal(result.classification, classification, `HTTP ${status}`);
      assert.equal(result.reason, `oracle_http_${status}`);
      assert.equal(calls, 1, "an ambiguous inference is never retried automatically");
      assert.doesNotMatch(JSON.stringify(result), /private provider response body|T{32}/, "provider bodies and credentials are not surfaced");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
