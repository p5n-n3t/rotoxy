import test from "node:test";
import assert from "node:assert/strict";
import {
  DurableSessionProvisioningCoordinator,
  ProvisioningConflictError,
} from "../dist/providers/lightsprint-provisioning.js";
import { LightSprintProvisioningAdapter } from "../dist/providers/lightsprint-provisioning-adapter.js";

const identity = { accountId: "acct-a", workspaceId: "ws-a", taskId: "task-a" };
const contract = () => ({
  accountId: "acct-a", status: "documented",
  semantics: { accountPinned: true, workspaceScoped: true, taskCreate: true, sessionLaunch: true, correlationLookup: true },
  modelPin: { status: "supported", values: ["model-a", "model-b"] },
  effortPin: { status: "supported", values: ["low", "high"] },
});

class MemoryLedger {
  rows = new Map(); byKey = new Map(); tuple = new Map(); nextId = 1;
  async reserve(input) {
    const old = this.byKey.get(input.idempotencyKey);
    if (old) {
      if (old.payloadDigest !== input.payloadDigest || JSON.stringify(old.identity) !== JSON.stringify(input.identity)) throw new ProvisioningConflictError("idempotency_collision");
      return { record: structuredClone(old), created: false };
    }
    const tuple = `${input.identity.accountId}/${input.identity.workspaceId}/${input.identity.taskId}`;
    const owner = this.tuple.get(tuple);
    if (owner && owner.state !== "rejected") throw new ProvisioningConflictError("task_in_flight");
    const row = { id: String(this.nextId++), ...structuredClone(input), state: "reserved", revision: 1 };
    this.rows.set(row.id, row); this.byKey.set(row.idempotencyKey, row); this.tuple.set(tuple, row);
    return { record: structuredClone(row), created: true };
  }
  async getByIdempotencyKey(key) { const row = this.byKey.get(key); return row && structuredClone(row); }
  async settle(id, revision, patch) {
    const row = this.rows.get(id);
    if (!row || row.revision !== revision) throw new Error("revision conflict");
    Object.assign(row, structuredClone(patch), { revision: row.revision + 1 });
    return structuredClone(row);
  }
}

function client(overrides = {}) {
  const calls = [];
  return {
    calls,
    async createTask(input) { calls.push(["createTask", input]); return { kind: "created", identity: input.identity, taskRef: "provider-task-1" }; },
    async launchSession(input) {
      calls.push(["launchSession", input]);
      return { kind: "started", evidence: { ...input.identity, providerSessionId: "provider-session-1", reportedModel: input.model ?? "auto", reportedEffort: input.effort ?? "auto" } };
    },
    async findSessions(input) { calls.push(["findSessions", input]); return []; },
    ...overrides,
  };
}

const request = (extra = {}) => ({ ...identity, idempotencyKey: "key-a", payload: { title: "Check behavior", prompt: "Inspect one component" }, ...extra });

test("launches through the injected account-pinned contract and carries exact model and effort pins", async () => {
  const fake = client();
  const adapter = new LightSprintProvisioningAdapter(contract(), fake);
  const coordinator = new DurableSessionProvisioningCoordinator(new MemoryLedger(), adapter);
  const result = await coordinator.provision(request({ model: "model-a", effort: "high" }));
  assert.equal(result.state, "started");
  assert.equal(result.record.providerSessionId, "provider-session-1");
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0][1].identity.accountId, "acct-a");
  assert.match(fake.calls[0][1].payloadDigest, /^[a-f0-9]{64}$/);
  assert.equal(fake.calls[0][1].payloadDigest, result.record.payloadDigest, "adapter correlation must match the durable ledger digest");
  assert.equal(fake.calls[1][1].model, "model-a");
  assert.equal(fake.calls[1][1].effort, "high");
  assert.equal(fake.calls[0][1].payloadDigest, fake.calls[1][1].payloadDigest);
});

test("unknown or incomplete discovery fails closed before client calls", async () => {
  const fake = client();
  const unverified = contract(); unverified.status = "unknown";
  const coordinator = new DurableSessionProvisioningCoordinator(new MemoryLedger(), new LightSprintProvisioningAdapter(unverified, fake));
  assert.equal((await coordinator.provision(request())).reason, "account_ineligible");
  assert.equal(fake.calls.length, 0);

  const missingSemantics = contract(); missingSemantics.semantics.correlationLookup = false;
  const incomplete = new DurableSessionProvisioningCoordinator(new MemoryLedger(), new LightSprintProvisioningAdapter(missingSemantics, fake));
  assert.equal((await incomplete.provision(request())).reason, "account_ineligible");
  assert.equal(fake.calls.length, 0);
});

test("unknown and unlisted model or effort pins are rejected before reservation or provider calls", async () => {
  const fake = client();
  const unverifiedPin = contract(); unverifiedPin.modelPin.status = "unknown"; delete unverifiedPin.modelPin.values;
  const coordinator = new DurableSessionProvisioningCoordinator(new MemoryLedger(), new LightSprintProvisioningAdapter(unverifiedPin, fake));
  assert.equal((await coordinator.provision(request({ model: "model-a" }))).reason, "unsupported_model_pin");
  const unsupported = new DurableSessionProvisioningCoordinator(new MemoryLedger(), new LightSprintProvisioningAdapter(contract(), fake));
  assert.equal((await unsupported.provision(request({ idempotencyKey: "key-model", model: "not-listed" }))).reason, "unsupported_model_pin");
  assert.equal((await unsupported.provision(request({ idempotencyKey: "key-effort", effort: "medium" }))).reason, "unsupported_effort_pin");
  assert.equal(fake.calls.length, 0);
});

test("account or workspace identity mismatch cannot dispatch", async () => {
  const fake = client();
  const adapter = new LightSprintProvisioningAdapter(contract(), fake);
  const coordinator = new DurableSessionProvisioningCoordinator(new MemoryLedger(), adapter);
  assert.equal((await coordinator.provision(request({ accountId: "acct-b" }))).reason, "account_ineligible");
  assert.equal(fake.calls.length, 0);

  const badIdentityClient = client({ async createTask(input) {
    this.calls.push(["createTask", input]);
    return { kind: "created", identity: { ...input.identity, workspaceId: "other-ws" }, taskRef: "provider-task-2" };
  } });
  const mismatched = new DurableSessionProvisioningCoordinator(new MemoryLedger(), new LightSprintProvisioningAdapter(contract(), badIdentityClient));
  const result = await mismatched.provision(request());
  assert.equal(result.state, "needs_reconciliation");
  assert.equal(result.reason, "provider_launch_ambiguous");
  assert.equal(badIdentityClient.calls.length, 1, "must stop after untrusted create identity");
});

test("ambiguous session launch is not retried and records reconciliation state", async () => {
  const fake = client({ async launchSession(input) { this.calls.push(["launchSession", input]); throw new Error("response lost"); } });
  const coordinator = new DurableSessionProvisioningCoordinator(new MemoryLedger(), new LightSprintProvisioningAdapter(contract(), fake));
  const first = await coordinator.provision(request());
  const duplicate = await coordinator.provision(request());
  assert.equal(first.state, "needs_reconciliation");
  assert.equal(duplicate.state, "needs_reconciliation");
  assert.equal(fake.calls.filter(([name]) => name === "launchSession").length, 1);
});

test("reconciliation retains only exact correlation and identity, and coordinator requires uniqueness", async () => {
  const exact = { ...identity, providerSessionId: "provider-session-9" };
  const fake = client({ async launchSession(input) { this.calls.push(["launchSession", input]); throw new Error("response lost"); } });
  const adapter = new LightSprintProvisioningAdapter(contract(), fake);
  const coordinator = new DurableSessionProvisioningCoordinator(new MemoryLedger(), adapter);
  const pending = await coordinator.provision(request());
  const { idempotencyKey, payloadDigest } = pending.record;
  fake.findSessions = async (input) => [
    { identity: input.identity, idempotencyKey: input.idempotencyKey, payloadDigest: input.payloadDigest, evidence: exact },
    { identity: { ...input.identity, taskId: "other-task" }, idempotencyKey: input.idempotencyKey, payloadDigest: input.payloadDigest, evidence: { ...exact, taskId: "other-task", providerSessionId: "wrong" } },
  ];
  const unique = await coordinator.reconcile(idempotencyKey);
  assert.equal(unique.state, "started");
  assert.equal(unique.record.providerSessionId, "provider-session-9");

  const duplicateFake = client({ async launchSession(input) { this.calls.push(["launchSession", input]); throw new Error("response lost"); } });
  const duplicateAdapter = new LightSprintProvisioningAdapter(contract(), duplicateFake);
  const duplicateCoordinator = new DurableSessionProvisioningCoordinator(new MemoryLedger(), duplicateAdapter);
  const duplicatePending = await duplicateCoordinator.provision(request());
  duplicateFake.findSessions = async (input) => [
    { identity: input.identity, idempotencyKey: input.idempotencyKey, payloadDigest: input.payloadDigest, evidence: exact },
    { identity: input.identity, idempotencyKey: input.idempotencyKey, payloadDigest: input.payloadDigest, evidence: { ...exact, providerSessionId: "another-session" } },
  ];
  const ambiguous = await duplicateCoordinator.reconcile(duplicatePending.record.idempotencyKey);
  assert.equal(ambiguous.state, "needs_reconciliation");
  assert.equal(ambiguous.reason, "provider_session_not_uniquely_verified");
});

test("invalid task and session identifiers are never accepted as provider evidence", async () => {
  const fake = client({ async createTask(input) {
    this.calls.push(["createTask", input]);
    return { kind: "created", identity: input.identity, taskRef: "../escape" };
  } });
  const coordinator = new DurableSessionProvisioningCoordinator(new MemoryLedger(), new LightSprintProvisioningAdapter(contract(), fake));
  const result = await coordinator.provision(request());
  assert.equal(result.state, "needs_reconciliation");
  assert.equal(fake.calls.length, 1);
});
