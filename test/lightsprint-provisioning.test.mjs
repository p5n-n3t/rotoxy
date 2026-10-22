import test from "node:test";
import assert from "node:assert/strict";
import {
  DurableSessionProvisioningCoordinator,
  ProvisioningConflictError,
} from "../dist/providers/lightsprint-provisioning.js";

class MemoryLedger {
  rows = new Map();
  byKey = new Map();
  tuple = new Map();
  nextId = 1;

  async reserve(input) {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) {
      if (existing.payloadDigest !== input.payloadDigest || JSON.stringify(existing.identity) !== JSON.stringify(input.identity)) {
        throw new ProvisioningConflictError("idempotency_collision");
      }
      return { record: structuredClone(existing), created: false };
    }
    const tupleKey = `${input.identity.accountId}\0${input.identity.workspaceId}\0${input.identity.taskId}`;
    const owner = this.tuple.get(tupleKey);
    if (owner && owner.state !== "rejected") throw new ProvisioningConflictError("task_in_flight");
    const record = { id: String(this.nextId++), ...structuredClone(input), state: "reserved", revision: 1 };
    this.rows.set(record.id, record);
    this.byKey.set(record.idempotencyKey, record);
    this.tuple.set(tupleKey, record);
    return { record: structuredClone(record), created: true };
  }

  async getByIdempotencyKey(key) {
    const record = this.byKey.get(key);
    return record && structuredClone(record);
  }

  async settle(id, expectedRevision, patch) {
    const row = this.rows.get(id);
    if (!row || row.revision !== expectedRevision) throw new Error("revision_conflict");
    Object.assign(row, structuredClone(patch), { revision: row.revision + 1 });
    return structuredClone(row);
  }
}

const identity = { accountId: "acct-1", workspaceId: "ws-1", taskId: "task-1" };
function makeAdapter(overrides = {}) {
  const adapter = {
    capabilities: { modelPin: true, effortPin: true },
    eligible: true,
    launches: 0,
    candidates: [],
    async isAccountEligible() { return this.eligible; },
    async launch(input) {
      this.launches++;
      return { kind: "started", evidence: {
        ...input.identity, providerSessionId: "session-1",
        reportedModel: "provider-model", reportedEffort: "medium",
      } };
    },
    async reconcile() { return this.candidates; },
    ...overrides,
  };
  return adapter;
}
const request = (extra = {}) => ({ ...identity, idempotencyKey: "key-1", payload: { prompt: "work" }, ...extra });

test("concurrent duplicate provisions launch once and keep requested/reported pins distinct", async () => {
  const ledger = new MemoryLedger();
  let releaseLaunch;
  let launchStarted;
  const entered = new Promise((resolve) => { launchStarted = resolve; });
  const gate = new Promise((resolve) => { releaseLaunch = resolve; });
  const adapter = makeAdapter({ async launch(input) {
    this.launches++;
    launchStarted();
    await gate;
    return { kind: "started", evidence: { ...input.identity, providerSessionId: "session-1", reportedModel: "actual-model", reportedEffort: "high" } };
  } });
  const coordinator = new DurableSessionProvisioningCoordinator(ledger, adapter);
  const first = coordinator.provision(request({ model: "requested-model", effort: "low" }));
  await entered;
  const duplicate = await coordinator.provision(request({ model: "requested-model", effort: "low" }));
  assert.equal(duplicate.state, "needs_reconciliation");
  releaseLaunch();
  const result = await first;
  assert.equal(result.state, "started");
  assert.equal(adapter.launches, 1);
  assert.equal(result.record.requestedModel, "requested-model");
  assert.equal(result.record.reportedModel, "actual-model");
  assert.equal(result.record.requestedEffort, "low");
  assert.equal(result.record.reportedEffort, "high");
});

test("a pre-existing reserved row is unknown after restart and is never replayed", async () => {
  class CrashAfterReserveLedger extends MemoryLedger {
    async settle() { throw new Error("simulated process loss after reserve"); }
  }
  const restartLedger = new CrashAfterReserveLedger();
  const firstAdapter = makeAdapter();
  const beforeCrash = new DurableSessionProvisioningCoordinator(restartLedger, firstAdapter);
  const leftBehind = await beforeCrash.provision(request());
  assert.equal(leftBehind.record.state, "reserved");
  assert.equal(firstAdapter.launches, 0);
  const adapterAfterRestart = makeAdapter();
  const restarted = new DurableSessionProvisioningCoordinator(restartLedger, adapterAfterRestart);
  const result = await restarted.provision(request());
  assert.equal(result.state, "needs_reconciliation");
  assert.equal(result.record.state, "reserved");
  assert.equal(adapterAfterRestart.launches, 0);
});

test("idempotency payload collision and account/workspace/task single-flight are rejected", async () => {
  const ledger = new MemoryLedger();
  const coordinator = new DurableSessionProvisioningCoordinator(ledger, makeAdapter());
  assert.equal((await coordinator.provision(request())).state, "started");
  await assert.rejects(coordinator.provision(request({ payload: { prompt: "different" } })),
    (error) => error instanceof ProvisioningConflictError && error.code === "idempotency_collision");
  await assert.rejects(coordinator.provision(request({ idempotencyKey: "key-2" })),
    (error) => error instanceof ProvisioningConflictError && error.code === "task_in_flight");
});

test("unsupported model or effort pin is rejected before reservation or provider send", async () => {
  const ledger = new MemoryLedger();
  const adapter = makeAdapter({ capabilities: { modelPin: false, effortPin: false } });
  const coordinator = new DurableSessionProvisioningCoordinator(ledger, adapter);
  assert.equal((await coordinator.provision(request({ model: "pinned" }))).reason, "unsupported_model_pin");
  assert.equal((await coordinator.provision(request({ effort: "high" }))).reason, "unsupported_effort_pin");
  assert.equal(adapter.launches, 0);
  assert.equal(ledger.rows.size, 0);
});

test("account eligibility is rechecked after reserve and before any launch", async () => {
  const ledger = new MemoryLedger();
  const adapter = makeAdapter({ eligible: false });
  const coordinator = new DurableSessionProvisioningCoordinator(ledger, adapter);
  const result = await coordinator.provision(request());
  assert.equal(result.state, "rejected");
  assert.equal(result.reason, "account_ineligible");
  assert.equal(result.record.state, "rejected");
  assert.equal(adapter.launches, 0);
});

test("wrong provider identity cannot be bound during launch or explicit reconciliation", async () => {
  const ledger = new MemoryLedger();
  const adapter = makeAdapter({ async launch() {
    this.launches++;
    return { kind: "started", evidence: { ...identity, accountId: "other-account", providerSessionId: "wrong" } };
  } });
  const coordinator = new DurableSessionProvisioningCoordinator(ledger, adapter);
  const result = await coordinator.provision(request());
  assert.equal(result.state, "needs_reconciliation");
  assert.equal((await ledger.getByIdempotencyKey("key-1")).state, "needs_reconciliation");
  adapter.candidates = [{ ...identity, workspaceId: "other-workspace", providerSessionId: "wrong" }];
  const reconciled = await coordinator.reconcile("key-1");
  assert.equal(reconciled.state, "needs_reconciliation");
  assert.equal(reconciled.record.providerSessionId, undefined);
});

test("known pre-execution refusal is durable and a duplicate does not retry", async () => {
  const ledger = new MemoryLedger();
  const adapter = makeAdapter({ async launch() {
    this.launches++;
    return { kind: "refused", beforeExecution: true, code: "quota_exhausted" };
  } });
  const coordinator = new DurableSessionProvisioningCoordinator(ledger, adapter);
  const first = await coordinator.provision(request());
  const duplicate = await coordinator.provision(request());
  assert.equal(first.state, "rejected");
  assert.equal(first.record.refusalCode, "quota_exhausted");
  assert.equal(duplicate.state, "rejected");
  assert.equal(adapter.launches, 1);
});

test("thrown launch persists reconciliation state and never auto-retries", async () => {
  const ledger = new MemoryLedger();
  const adapter = makeAdapter({ async launch() { this.launches++; throw new Error("transport ended after send"); } });
  const coordinator = new DurableSessionProvisioningCoordinator(ledger, adapter);
  const first = await coordinator.provision(request());
  const duplicate = await coordinator.provision(request());
  assert.equal(first.state, "needs_reconciliation");
  assert.equal(first.record.state, "needs_reconciliation");
  assert.equal(duplicate.state, "needs_reconciliation");
  assert.equal(adapter.launches, 1);
});

test("explicit reconciliation binds only one exact-identity candidate and never launches", async () => {
  const ledger = new MemoryLedger();
  const adapter = makeAdapter({ async launch() { this.launches++; throw new Error("ambiguous"); } });
  const coordinator = new DurableSessionProvisioningCoordinator(ledger, adapter);
  await coordinator.provision(request());
  adapter.candidates = [{ ...identity, providerSessionId: "verified-session", reportedModel: "actual" }];
  const result = await coordinator.reconcile("key-1");
  assert.equal(result.state, "started");
  assert.equal(result.record.providerSessionId, "verified-session");
  assert.equal(result.record.reportedModel, "actual");
  assert.equal(adapter.launches, 1);
});
