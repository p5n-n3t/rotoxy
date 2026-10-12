import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { WorkerGuidanceLedger, WorkerGuidanceService } from "../dist/worker-guidance.js";

test("guidance preflights ownership/prompt state, gates policy, reserves once, and never replays uncertain actions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t2o-worker-guidance-"));
  const previousHome = process.env.HOME;
  const previousConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  const store = new StateStore(); // Isolated environment is set before construction.
  await store.init({ adminPassword: "synthetic-guidance-test-admin" });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = previousConfig;
  });

  const workers = [
    { projectId: "project-a", sessionId: "session-a", accountId: "account-a", model: "gpt-6-luna" },
    { projectId: "project-a", sessionId: "session-b", accountId: "account-b", model: "gpt-6-luna" },
    { projectId: "project-a", sessionId: "session-c", accountId: "account-c", model: "gpt-6-luna" },
    { projectId: "project-a", sessionId: "session-d", accountId: "account-d", model: "gpt-6-luna" },
  ];
  let mode = "accepted";
  let statusMode = "idle";
  let blockPolicy = false;
  let sends = [];
  let statusBarrier;
  let statusCalls = 0;
  const adapters = new Map(workers.map((worker) => [worker.accountId, {
    accountId: worker.accountId,
    async sessionStatus(sessionId) {
      if (statusBarrier) {
        statusCalls++;
        if (statusCalls === 2) statusBarrier.release();
        await statusBarrier.promise;
      }
      const parkedQuestion = statusMode === "parked" ? { id: "q-parked" } : undefined;
      return { classification: "accepted", accountId: worker.accountId, value: { status: {
        sessionId: statusMode === "wrong-session" ? "another-session" : sessionId,
        sessionStatus: statusMode === "busy" ? "running" : "idle", isOwner: statusMode !== "not-owner", canSendMessage: true,
        promptCount: statusMode === "changed" ? 8 : 7, questionId: "q-7", reportedModel: "gpt-6-luna", ...(parkedQuestion ? { parkedQuestion } : {}),
      } } };
    },
    async sendMessage(sessionId, message, clientMessageId) {
      sends.push({ sessionId, message, clientMessageId });
      return { classification: mode, accountId: worker.accountId, reason: mode === "rejected" ? "quota" : undefined };
    },
  }]));
  const makeService = (ledger = new WorkerGuidanceLedger(store)) => new WorkerGuidanceService({
    ledger,
    findWorker: (projectId, workerId) => workers.find((worker) => worker.projectId === projectId && worker.sessionId === workerId),
    adapterFor: (accountId) => adapters.get(accountId) ?? { accountId: "wrong-account", async sessionStatus() { throw new Error("unexpected"); }, async sendMessage() { throw new Error("unexpected"); } },
    accountEligible: async () => true,
    policyAllows: async () => !blockPolicy,
  });
  const service = makeService();
  const input = { projectId: "project-a", workerId: "session-a", requestId: "request-accepted", message: "A private bounded instruction that must not be stored.", expectedPromptCount: 7, expectedQuestionId: "q-7" };

  const accepted = await service.submit(input);
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.requestedModel, "gpt-6-luna");
  assert.equal(accepted.reportedModel, "gpt-6-luna");
  assert.equal(sends.length, 1);
  assert.match(sends[0].clientMessageId, /^guidance-[a-f0-9]{40}$/);
  assert.deepEqual(await service.submit(input), accepted, "completed request is idempotent");
  assert.equal(sends.length, 1);
  assert.equal((await service.submit({ ...input, message: "changed payload" })).reason, "request_id_conflict");

  const ledgerText = await readFile(join(store.dir, "worker-guidance-actions.json"), "utf8");
  assert.doesNotMatch(ledgerText, /private bounded instruction/, "durable ledger contains no message text");
  assert.match(ledgerText, /"digest"/);

  statusMode = "wrong-session";
  assert.equal((await service.submit({...input,workerId:"session-b",requestId:"wrong-session"})).reason,"session_identity_mismatch");
  statusMode = "idle";
  assert.equal((await service.submit({...input,requestId:"different-request-same-turn"})).reason,"prompt_count_consumed");
  statusMode = "parked";
  assert.equal((await service.submit({ ...input, workerId: "session-b", requestId: "request-parked" })).reason, "native_question_answer_unsupported");
  statusMode = "changed";
  assert.equal((await service.submit({ ...input, workerId: "session-b", requestId: "request-prompt" })).reason, "prompt_count_changed");
  statusMode = "busy";
  assert.equal((await service.submit({ ...input, workerId: "session-b", requestId: "request-busy" })).reason, "worker_not_idle_owned_or_sendable");
  statusMode = "not-owner";
  assert.equal((await service.submit({ ...input, workerId: "session-b", requestId: "request-not-owner" })).reason, "worker_not_idle_owned_or_sendable");
  statusMode = "idle";
  adapters.get("account-d").accountId = "different-account";
  assert.equal((await service.submit({ ...input, workerId: "session-d", requestId: "request-wrong-account" })).reason, "account_identity_mismatch");
  adapters.get("account-d").accountId = "account-d";
  blockPolicy = true;
  assert.equal((await service.submit({ ...input, workerId: "session-b", requestId: "request-policy" })).reason, "policy_paid_block");
  assert.equal(sends.length, 1, "policy denial and stale status never send");
  blockPolicy = false;
  assert.equal((await service.submit({ ...input, projectId: "project-unknown", requestId: "request-unbound" })).reason, "worker_not_registered");

  mode = "ambiguous";
  const ambiguousInput = { ...input, workerId: "session-c", requestId: "request-ambiguous" };
  assert.equal((await service.submit(ambiguousInput)).state, "ambiguous");
  assert.equal((await makeService().submit(ambiguousInput)).reason, "needs_reconciliation");
  assert.equal((await makeService().submit({...ambiguousInput,requestId:"new-request-after-ambiguity"})).reason,"worker_has_unreconciled_action");
  assert.equal(sends.length, 2, "restart retry returns recorded ambiguity without another provider call");

  mode = "accepted";
  const concurrentInput = { ...input, workerId: "session-d", requestId: "request-concurrent" };
  let release;
  statusBarrier = { promise: new Promise((resolve) => { release = resolve; }), release: () => release() };
  const beforeConcurrent = sends.length;
  const results = await Promise.all([service.submit(concurrentInput), service.submit(concurrentInput)]);
  statusBarrier = undefined;
  assert.equal(sends.length, beforeConcurrent + 1, "concurrent duplicate reserves and sends once");
  assert.ok(results.every((result) => result.state === "accepted" || result.state === "ambiguous"));

  const reservedInput = { ...input, workerId: "session-b", requestId: "crash-reservation" };
  const ledger = new WorkerGuidanceLedger(store);
  const reservedDigest = createHash("sha256").update(JSON.stringify({ message: reservedInput.message, expectedPromptCount: reservedInput.expectedPromptCount, expectedQuestionId: reservedInput.expectedQuestionId ?? null })).digest("hex");
  await ledger.reserve(reservedInput, reservedDigest);
  const afterRestart = await makeService(new WorkerGuidanceLedger(store)).submit(reservedInput);
  assert.deepEqual(afterRestart, { requestId: reservedInput.requestId, state: "ambiguous", reason: "needs_reconciliation" });
  assert.equal(sends.length, beforeConcurrent + 1, "an incomplete reservation is never replayed after restart");
});
