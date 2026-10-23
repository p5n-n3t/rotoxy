import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createJobWorker } from "../dist/job-worker.js";

const ok = (accountId, value = {}) => ({ classification: "accepted", accountId, value });
const op = (id, accountId, overrides = {}) => ({
  operationId: id, attemptId: `attempt-${id}`, generation: 1, selectedAccountId: accountId,
  kind: "chat_session", sessionId: `session-${accountId}`, input: {
    instructions: `work ${id}`, clientMessageId: `client-${id}`, dispatchAt: "2026-10-10T00:00:00Z",
  }, ...overrides,
});
const pythonObservation = (id, accountId, dispatchAt) => ({
  operationId: id, attemptId: `attempt-${id}`, generation: 1, selectedAccountId: accountId,
  kind: "observe_session", sessionId: `session-${accountId}`, providerTaskId: "provider-task",
  input: { sessionId: `session-${accountId}`, clientMessageId: `client-${id}`, dispatchAt,
    expectedMarker: "EXPECTED", providerTaskId: "provider-task", stackId: "stack-1", provider: "auto",
    workspace: "workspace-1", model: "gpt-6-luna" },
});
function adapter(accountId, overrides = {}) {
  return {
    accountId,
    sessionStatus: async () => ok(accountId, { status: {
      sessionId: `session-${accountId}`, isOwner: true, canSendMessage: true,
      model: "gpt-6-luna", sessionStatus: "idle",
    } }),
    sessionTranscript: async () => ok(accountId, { messages: [] }),
    sendMessage: async () => ok(accountId),
    stopSession: async () => ok(accountId),
    ...overrides,
  };
}
function harness(operations, overrides = {}) {
  const claims = [...operations];
  const resultBodies = [];
  const bridge = {
    async request(method, route, body) {
      if (route === "/v1/operations/claim") return claims.shift();
      if (route.endsWith("/result")) { resultBodies.push(structuredClone(body)); return { state: body.outcome }; }
      throw new Error("unexpected route");
    },
  };
  const worker = createJobWorker({
    bridge, adapterFactory: (accountId) => adapter(accountId), isAccountEligible: () => true,
    workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 2, pollIntervalMs: 20,
    ...overrides,
  });
  return { worker, resultBodies, claims };
}
const until = async (predicate, timeout = 1_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("dispatches pinned accounts concurrently without exceeding configured capacity", async () => {
  let current = 0; let peak = 0; const sent = [];
  const items = [op("one", "account-a"), op("two", "account-b"), op("three", "account-c")];
  const { worker, resultBodies } = harness(items, {
    maxConcurrent: 2,
    adapterFactory: (accountId) => adapter(accountId, { sendMessage: async (sessionId, message, clientMessageId) => {
      current++; peak = Math.max(peak, current); sent.push({ accountId, sessionId, message, clientMessageId });
      await new Promise((resolve) => setTimeout(resolve, 30)); current--;
      return ok(accountId);
    } }),
  });
  worker.start();
  await until(() => resultBodies.length === 3);
  await worker.stop();
  assert.equal(peak, 2);
  assert.deepEqual(sent.map((v) => v.accountId).sort(), ["account-a", "account-b", "account-c"]);
  assert.equal(resultBodies.every((body) => body.outcome === "accepted"), true);
});

test("ambiguous chat mutation is never replayed", async () => {
  let sends = 0;
  const { worker, resultBodies } = harness([op("ambiguous", "account-a")], {
    adapterFactory: (accountId) => adapter(accountId, { sendMessage: async () => { sends++; return { classification: "ambiguous", accountId }; } }),
  });
  worker.start(); await until(() => resultBodies.length === 1); await worker.tick(); await worker.stop();
  assert.equal(sends, 1);
  assert.equal(resultBodies[0].outcome, "ambiguous");
});

test("operation adapter is selected only for a valid claimed chat operation and replaces the fallback", async () => {
  let claimed = false; let specialized = 0; let fallback = 0; let sends = 0;
  const bridge = { async request(_method, route, body) {
    if (route === "/v1/operations/claim") { claimed = true; return op("trusted-claim", "account-a"); }
    if (route.endsWith("/result")) return { state: body.outcome };
    throw new Error("unexpected route");
  } };
  const worker = createJobWorker({ bridge,
    adapterFactory: () => { fallback++; return adapter("account-a"); },
    operationAdapterFactory: async (operation) => {
      assert.equal(claimed, true);
      assert.equal(operation.operationId, "trusted-claim");
      specialized++;
      return adapter("account-a", { sendMessage: async () => { sends++; return ok("account-a"); } });
    },
    isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1,
  });
  worker.start(); await until(() => specialized > 0 && sends > 0); await worker.stop();
  assert.equal(specialized, 1);
  assert.equal(fallback, 0);
  assert.equal(sends, 1);
});

test("claimed chat is rejected when the trusted operation factory declines its binding", async () => {
  let fallback = 0; let posted;
  const bridge = { async request(_method, route, body) {
    if (route === "/v1/operations/claim") return op("unregistered-session", "account-a");
    if (route.endsWith("/result")) { posted = body; return {}; }
    throw new Error("unexpected route");
  } };
  const worker = createJobWorker({ bridge,
    adapterFactory: () => { fallback++; return adapter("account-a"); },
    operationAdapterFactory: async () => undefined,
    isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1,
  });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(posted.outcome, "rejected");
  assert.equal(posted.errorClass, "operation_not_trusted");
  assert.equal(fallback, 0);
});

test("a failed result acknowledgment retries only the stored receipt", async () => {
  let sends = 0; let resultAttempts = 0; const receipts = [];
  let claimAvailable = true;
  const bridge = { async request(_method, route, body) {
    if (route === "/v1/operations/claim") {
      if (!claimAvailable) return undefined;
      claimAvailable = false;
      return op("receipt", "account-a");
    }
    receipts.push(structuredClone(body));
    if (++resultAttempts === 1) throw Object.assign(new Error("lost ack"), { code: "transport_error" });
    return { state: body.outcome };
  } };
  const retryWorker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, { sendMessage: async () => { sends++; return ok(id); } }),
    isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1, pollIntervalMs: 20 });
  retryWorker.start(); await until(() => resultAttempts >= 2); await retryWorker.stop();
  assert.equal(sends, 1);
  assert.deepEqual(receipts[0], receipts[1]);
});

test("shutdown aborts a pending claim and does not dispatch it when it returns", async () => {
  let resolveClaim; let sent = 0;
  const bridge = { request(_method, route) {
    if (route.endsWith("/claim")) return new Promise((resolve) => { resolveClaim = resolve; });
    return Promise.resolve({});
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, { sendMessage: async () => { sent++; return ok(id); } }),
    isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => resolveClaim); const stopping = worker.stop(); resolveClaim(op("late", "account-a")); await stopping;
  assert.equal(sent, 0);
});

test("observe_session ignores assistant messages older than durable dispatchAt", async () => {
  const dispatchAt = Date.parse("2026-10-10T00:00:00Z") / 1_000;
  const observation = pythonObservation("observe", "account-a", dispatchAt);
  let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return observation;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
    sessionTranscript: async () => ok(id, { shape: "messages", latestAssistantIndex: 0, latestAssistantComplete: true,
      messages: [{ role: "assistant", content: "old", timestamp: "2026-10-09T23:59:59Z", complete: true }] }),
  }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(posted.result.status, "idle");
  assert.equal("assistantText" in posted.result, false);
});

test("observe_session returns only the newest bounded assistant result after dispatchAt", async () => {
  const dispatchAt = Date.parse("2026-10-10T00:00:00Z") / 1_000;
  const observation = pythonObservation("fresh-observe", "account-a", dispatchAt);
  let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return observation;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
    sessionTranscript: async () => ok(id, { shape: "messages", latestAssistantIndex: 1, latestAssistantComplete: true,
      messages: [
        { role: "assistant", content: "first", timestamp: "2026-10-10T00:01:00Z", complete: true },
        { role: "assistant", content: [{ type: "text", text: "latest" }], timestamp: "2026-10-10T00:02:00Z", complete: true },
      ] }),
  }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(posted.result.assistantText, "latest");
  assert.equal(posted.outcome, "accepted");
  assert.equal(posted.result.status, "idle");
  assert.equal(posted.result.assistantAt, Date.parse("2026-10-10T00:02:00Z") / 1_000);
  assert.equal(typeof posted.result.assistantAt, "number");
});

test("observe_session preserves complete assistant text longer than the identifier limit", async () => {
  const dispatchAt = Date.parse("2026-10-10T00:00:00Z") / 1_000;
  const fullText = `EXPECTED ${"x".repeat(3_000)}`;
  const observation = pythonObservation("long-observe", "account-a", dispatchAt);
  let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return observation;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
    sessionTranscript: async () => ok(id, { shape: "messages", latestAssistantIndex: 0, latestAssistantComplete: true,
      messages: [{ role: "assistant", content: fullText, timestamp: "2026-10-10T00:02:00Z", complete: true }] }),
  }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(posted.outcome, "accepted");
  assert.equal(posted.result.assistantText, fullText);
});

test("observe_session omits oversized assistant output using a UTF-8 byte bound", async () => {
  const dispatchAt = Date.parse("2026-10-10T00:00:00Z") / 1_000;
  // 10,923 three-byte characters exceed 32 KiB despite having fewer than 32,768 JS chars.
  const tooLarge = `EXPECTED${"€".repeat(10_923)}`;
  const observation = pythonObservation("oversize-observe", "account-a", dispatchAt);
  let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return observation;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
    sessionTranscript: async () => ok(id, { shape: "messages", latestAssistantIndex: 0, latestAssistantComplete: true,
      messages: [{ role: "assistant", content: tooLarge, timestamp: "2026-10-10T00:02:00Z", complete: true }] }),
  }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(posted.outcome, "accepted");
  assert.equal("assistantText" in posted.result, false);
  assert.equal("assistantAt" in posted.result, false);
});

test("observe_session does not fall back to an older complete answer when the latest is incomplete", async () => {
  const dispatchAt = Date.parse("2026-10-10T00:00:00Z") / 1_000;
  for (const [index, latestAssistantComplete, messageComplete] of [[0, false, false], [1, true, false], [2, false, true]]) {
    let posted;
    const observation = pythonObservation(`incomplete-latest-${index}`, "account-a", dispatchAt);
    const bridge = { async request(_method, route, body) {
      if (route.endsWith("/claim")) return observation;
      posted = body; return {};
    } };
    const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
      sessionTranscript: async () => ok(id, { shape: "messages", latestAssistantIndex: 1, latestAssistantComplete,
        incomplete: true, messages: [
          { role: "assistant", content: "OLDER VALID MARKER", timestamp: dispatchAt + 5, complete: true },
          { role: "assistant", contentOmitted: "oversized", timestamp: dispatchAt + 10, complete: messageComplete },
        ] }),
    }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
    worker.start(); await until(() => posted); await worker.stop();
    assert.equal(posted.outcome, "accepted");
    assert.equal(posted.result.status, "idle");
    assert.equal("assistantText" in posted.result, false);
    assert.equal("assistantAt" in posted.result, false);
  }
});

test("observe_session rejects an invalid durable dispatch timestamp", async () => {
  const observation = pythonObservation("bad-dispatch-time", "account-a", "yesterday-ish");
  let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return observation;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id), isAccountEligible: () => true,
    workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(posted.outcome, "rejected");
  assert.equal(posted.errorClass, "invalid_dispatch_timestamp");
});

test("fresh create_task remains disabled unless explicitly enabled", async () => {
  const fresh = { ...op("fresh", "account-a"), kind: "create_task", input: { stackId: "stack", title: "Task", instructions: "bounded task" } };
  let posted; let creates = 0;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return fresh;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, { createTask: async () => { creates++; return ok(id); } }),
    isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(creates, 0);
  assert.equal(posted.outcome, "rejected");
  assert.equal(posted.errorClass, "fresh_operations_disabled");
});

test("current account ineligibility prevents chat send", async () => {
  let checks = 0; let sends = 0; let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return op("disabled", "account-a");
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, { sendMessage: async () => { sends++; return ok(id); } }),
    isAccountEligible: () => ++checks === 1, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(checks, 2);
  assert.equal(sends, 0);
  assert.equal(posted.outcome, "rejected");
});

test("accepted chat receipts capture only bounded preflight model and usage", async () => {
  let posted; let sends = 0;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return op("chat-usage", "account-a");
    posted = body; return {};
  } };
  const baselineUsage = { aiGatewaySessionCostUsd: 0.125, promptCount: 4, budgetUsed: 1.5, maxBudget: 8,
    fundingSource: "trial", sandboxTier: "small", userId: "private-user", credentialRef: "secret-ref",
    branch: "private-branch", prompt: "private prompt", token: "never-return" };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
    sessionStatus: async () => ok(id, { status: { isOwner: true, canSendMessage: true, model: "gpt-6-luna",
      sessionStatus: "idle", ...baselineUsage } }),
    sendMessage: async () => { sends++; return ok(id); },
  }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(sends, 1);
  assert.equal(posted.outcome, "accepted");
  assert.equal(posted.result.reportedModel, "gpt-6-luna");
  assert.deepEqual(posted.result.usage, { reportedSessionCostUsd: 0.125, promptCount: 4, budgetUsed: 1.5,
    maxBudget: 8, fundingSource: "trial", sandboxTier: "small" });
  assert.doesNotMatch(JSON.stringify(posted.result), /private-user|secret-ref|private-branch|private prompt|never-return/);
});

test("observe_session captures latest usage while running without inventing absent fields", async () => {
  const dispatchAt = Date.parse("2026-10-10T00:00:00Z") / 1_000;
  const observation = pythonObservation("latest-usage", "account-a", dispatchAt);
  let posted; let transcriptReads = 0;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return observation;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
    sessionStatus: async () => ok(id, { status: { sessionStatus: "running", model: "agent-model-v2",
      aiGatewaySessionCostUsd: 0, promptCount: 0, budgetUsed: 0, maxBudget: 5,
      fundingSource: "workspace", sandboxTier: "standard" } }),
    sessionTranscript: async () => { transcriptReads++; return ok(id, { messages: [] }); },
  }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(transcriptReads, 0);
  assert.equal(posted.result.status, "running");
  assert.equal(posted.result.reportedModel, "agent-model-v2");
  assert.deepEqual(posted.result.usage, { reportedSessionCostUsd: 0, promptCount: 0, budgetUsed: 0,
    maxBudget: 5, fundingSource: "workspace", sandboxTier: "standard" });
});

test("malformed usage and model metadata are omitted instead of defaulted or echoed", async () => {
  const observation = pythonObservation("invalid-usage", "account-a", Date.parse("2026-10-10T00:00:00Z") / 1_000);
  let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return observation;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
    sessionStatus: async () => ok(id, { status: { sessionStatus: "running", model: { secret: "private-model" },
      reportedSessionCostUsd: null, promptCount: -1, budgetUsed: "3", maxBudget: 0,
      fundingSource: "f".repeat(65), sandboxTier: null, userId: "private-user", credentialRef: "secret-ref" } }),
  }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(posted.outcome, "accepted");
  assert.equal("reportedModel" in posted.result, false);
  assert.equal("usage" in posted.result, false);
  assert.doesNotMatch(JSON.stringify(posted.result), /private-model|private-user|secret-ref|fundingSource/);
});


test("existing sessions use the registered model and refuse changed or unapproved models", async () => {
  for (const [reported, allowed, accepted] of [
    ["claude-opus-5-5", ["claude-opus-5-5"], true],
    ["gpt-6-luna", ["claude-opus-5-5", "gpt-6-luna"], false],
    ["claude-opus-5-5", ["gpt-6-luna"], false],
  ]) {
    let sends = 0;
    const item = op("model-bound", "account-a", { input: {
      instructions: "bounded approved design", clientMessageId: "model-bound", model: "claude-opus-5-5",
    } });
    const { worker, resultBodies } = harness([item], {
      allowedModels: allowed,
      adapterFactory: id => adapter(id, {
        sessionStatus: async () => ok(id, { status: { sessionStatus: "idle", isOwner: true, canSendMessage: true, model: reported } }),
        sendMessage: async () => { sends++; return ok("account-a"); },
      }),
    });
    worker.start();
    try { await until(() => resultBodies.length === 1); } finally { await worker.stop(); }
    assert.equal(sends, accepted ? 1 : 0);
    assert.equal(resultBodies[0].outcome, accepted ? "accepted" : "rejected");
    if (accepted) assert.equal(resultBodies[0].result.reportedModel, "claude-opus-5-5");
  }
});

test("idle status with ACP_RELAY_DIED is reported as failed without reading an old transcript", async () => {
  const operation = pythonObservation("relay-dead", "account-a", Date.parse("2026-10-10T00:00:00Z") / 1000);
  let transcripts = 0;
  const { worker, resultBodies } = harness([operation], {
    adapterFactory: (id) => adapter(id, {
      sessionStatus: async () => ok(id, { status: {
        sessionId: 'session-account-a', sessionStatus: 'idle', model: 'claude-opus-5-5',
        errorCode: 'ACP_RELAY_DIED', errorMessage: 'password=do-not-leak',
      } }),
      sessionTranscript: async () => { transcripts++; return ok(id, { shape: 'messages',
        latestAssistantIndex: 0, latestAssistantComplete: true,
        messages: [{ role: 'assistant', content: 'stale success', timestamp: '2026-10-10T00:01:00Z', complete: true }],
      }); },
    }),
  });
  worker.start(); await until(() => resultBodies.length === 1); await worker.stop();
  assert.equal(transcripts, 0);
  assert.equal(resultBodies[0].outcome, 'accepted');
  assert.equal(resultBodies[0].result.status, 'failed');
  assert.equal(resultBodies[0].errorClass, 'ACP_RELAY_DIED');
  assert.equal(JSON.stringify(resultBodies[0]).includes('do-not-leak'), false);
  assert.equal('assistantText' in resultBodies[0].result, false);
});

test("native approval is a handoff and never makes an assistant transcript into a result", async () => {
  const operation = pythonObservation("native-approval", "account-a", Date.parse("2026-10-10T00:00:00Z") / 1000);
  let transcripts = 0;
  const { worker, resultBodies } = harness([operation], {
    adapterFactory: (id) => adapter(id, {
      sessionStatus: async () => ok(id, { status: { sessionId: 'session-account-a',
        sessionStatus: 'idle', parkedQuestion: { kind: 'approval', text: 'Approve?' } } }),
      sessionTranscript: async () => { transcripts++; return ok(id); },
    }),
  });
  worker.start(); await until(() => resultBodies.length === 1); await worker.stop();
  assert.equal(transcripts, 0);
  assert.equal(resultBodies[0].result.status, 'needs_approval');
});

test("typed transcript cannot complete without exact dispatched instruction hash", async () => {
  const sentText = "EXPECTED make a concise result";
  const rightHash = createHash('sha256').update(sentText).digest('hex');
  const dispatchAt = Date.parse("2026-10-15T09:00:00Z") / 1000;
  for (const hash of [rightHash, createHash('sha256').update('different').digest('hex')]) {
    const observation = pythonObservation("typed-" + hash.slice(0,8), "account-a", dispatchAt);
    observation.input.instructionsHash = rightHash;
    const { worker, resultBodies } = harness([observation], {
      adapterFactory: id => adapter(id, {
        sessionTranscript: async () => ok(id, {
          shape:'items', messages:[{role:'assistant',complete:true,content:'EXPECTED delivered',
            timestamp:'2026-10-15T09:01:00Z'}],
          latestAssistantIndex:0,latestAssistantComplete:true,lastUserTextSha256:hash,
        }),
      }),
    });
    worker.start(); await until(() => resultBodies.length === 1); await worker.stop();
    assert.equal('assistantText' in resultBodies[0].result, hash === rightHash);
  }
});

test("isAccountObservable bypasses isAccountEligible for observe_session", async () => {
  // isAccountEligible=false would normally block; isAccountObservable=true must allow observation.
  let observableCalls = 0; let eligibleCalls = 0;
  const obs = pythonObservation("obs-bypass", "account-a", Date.parse("2026-10-10T00:00:00Z") / 1_000);
  const { worker, resultBodies } = harness([obs], {
    isAccountEligible: () => { eligibleCalls++; return false; },
    isAccountObservable: () => { observableCalls++; return true; },
  });
  worker.start(); await until(() => resultBodies.length === 1); await worker.stop();
  assert.ok(observableCalls > 0, "isAccountObservable must be called for observe_session");
  assert.equal(resultBodies[0].outcome, "accepted", "exhausted account must be allowed to observe");
  assert.notEqual(resultBodies[0].errorClass, "account_unavailable");
});

test("an idle session with a failed relay or pending approval never receives a new task", async () => {
  for (const extra of [{errorCode:"ACP_RELAY_DIED"},{parkedQuestion:{kind:"approval",text:"Approve this change?"}}]) {
    let sends=0;
    const {worker,resultBodies}=harness([op("unavailable-relay","account-a")],{
      adapterFactory:id=>adapter(id,{
        sessionStatus:async()=>ok(id,{status:{sessionStatus:"idle",isOwner:true,canSendMessage:true,model:"gpt-6-luna",...extra}}),
        sendMessage:async()=>{sends++;return ok(id);},
      }),
    });
    worker.start();
    try {await until(()=>resultBodies.length===1);} finally {await worker.stop();}
    assert.equal(sends,0);
    assert.equal(resultBodies[0].outcome,"rejected");
    assert.equal(resultBodies[0].errorClass,"session_not_sendable");
  }
});

test("isAccountObservable=false denies observe_session with account_unavailable", async () => {
  const obs = pythonObservation("obs-deny", "account-a", Date.parse("2026-10-10T00:00:00Z") / 1_000);
  const { worker, resultBodies } = harness([obs], {
    isAccountEligible: () => true,
    isAccountObservable: () => false,
  });
  worker.start(); await until(() => resultBodies.length === 1); await worker.stop();
  assert.equal(resultBodies[0].outcome, "rejected");
  assert.equal(resultBodies[0].errorClass, "account_unavailable");
});

test("chat_session uses isAccountEligible even when isAccountObservable is provided and returns true", async () => {
  let eligibleCalled = false;
  const { worker, resultBodies } = harness([op("chat-gate", "account-a")], {
    isAccountEligible: () => { eligibleCalled = true; return false; },
    isAccountObservable: () => true,
  });
  worker.start(); await until(() => resultBodies.length === 1); await worker.stop();
  assert.ok(eligibleCalled, "isAccountEligible must be called for chat_session");
  assert.equal(resultBodies[0].outcome, "rejected");
  assert.equal(resultBodies[0].errorClass, "account_unavailable");
});

test("observe_session falls back to isAccountEligible when isAccountObservable is absent", async () => {
  let eligibleCalled = false;
  const obs = pythonObservation("obs-fallback", "account-a", Date.parse("2026-10-10T00:00:00Z") / 1_000);
  const { worker, resultBodies } = harness([obs], {
    isAccountEligible: () => { eligibleCalled = true; return false; },
    // no isAccountObservable
  });
  worker.start(); await until(() => resultBodies.length === 1); await worker.stop();
  assert.ok(eligibleCalled, "isAccountEligible must be called as fallback for observe_session");
  assert.equal(resultBodies[0].outcome, "rejected");
  assert.equal(resultBodies[0].errorClass, "account_unavailable");
});


test("policy refresh failure prevents claiming new operations and recovers on a later tick",async()=>{
  let blocked=true,refreshes=0;
  const {worker,resultBodies,claims}=harness([op("policy-one","account-a")],{beforeClaim:async()=>{refreshes++;if(blocked)throw new Error("policy unreadable");}});
  worker.start();
  try{
    await until(()=>refreshes>=2);
    assert.equal(claims.length,1);assert.equal(resultBodies.length,0);
    blocked=false;await until(()=>resultBodies.length===1);
    assert.equal(resultBodies[0].outcome,"accepted");
  }finally{await worker.stop();}
});
