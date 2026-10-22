import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DurableSessionProvisioningCoordinator, ProvisioningConflictError } from "../dist/providers/lightsprint-provisioning.js";
import {
  ProvisioningLedgerError,
  SqliteProvisioningLedger,
} from "../dist/providers/lightsprint-provisioning-ledger.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-provisioning-ledger-"));
  const databasePath = join(root, "ledger.sqlite");
  const ledgers = new Set();
  t.after(async () => {
    for (const ledger of ledgers) ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    databasePath,
    open() {
      const ledger = new SqliteProvisioningLedger(databasePath);
      ledgers.add(ledger);
      return ledger;
    },
  };
}

const reservation = (extra = {}) => ({
  idempotencyKey: "request-1",
  payloadDigest: "a".repeat(64),
  identity: { accountId: "account-1", workspaceId: "workspace-1", taskId: "task-1" },
  requestedModel: "model-requested",
  ...extra,
});

test("independent SQLite connections atomically reserve once and survive reopen", async (t) => {
  const f = await fixture(t);
  const left = f.open();
  const right = f.open();
  const results = await Promise.all([left.reserve(reservation()), right.reserve(reservation())]);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results[0].record.id, results[1].record.id);
  assert.equal(results[0].record.state, "reserved");
  assert.equal(results[0].record.revision, 1);

  left.close();
  right.close();
  const afterRestart = f.open();
  const existing = await afterRestart.getByIdempotencyKey("request-1");
  assert.equal(existing.id, results[0].record.id);
  assert.equal(existing.requestedModel, "model-requested");
  assert.equal((await afterRestart.reserve(reservation())).created, false);
});

test("same idempotency key with changed digest or identity fails closed", async (t) => {
  const f = await fixture(t);
  const a = f.open();
  const b = f.open();
  await a.reserve(reservation());
  await assert.rejects(b.reserve(reservation({ payloadDigest: "b".repeat(64) })),
    (error) => error instanceof ProvisioningConflictError && error.code === "idempotency_collision");
  await assert.rejects(b.reserve(reservation({ identity: { accountId: "account-1", workspaceId: "workspace-1", taskId: "other-task" } })),
    (error) => error instanceof ProvisioningConflictError && error.code === "idempotency_collision");
  await assert.rejects(b.reserve(reservation({ requestedModel: "different-model" })),
    (error) => error instanceof ProvisioningConflictError && error.code === "idempotency_collision");
});

test("single-flight retains uncertain/started rows and releases only known rejection", async (t) => {
  const f = await fixture(t);
  const a = f.open();
  const b = f.open();
  const created = await a.reserve(reservation());
  const secondKey = () => reservation({ idempotencyKey: "request-2" });
  const inFlight = () => assert.rejects(b.reserve(secondKey()),
    (error) => error instanceof ProvisioningConflictError && error.code === "task_in_flight");
  await inFlight();
  const uncertain = await a.settle(created.record.id, created.record.revision, { state: "needs_reconciliation" });
  await inFlight();
  const started = await a.settle(uncertain.id, uncertain.revision, { state: "started", providerSessionId: "session-1" });
  await inFlight();

  const rejectedTask = await a.reserve(reservation({
    idempotencyKey: "rejected-task", identity: { accountId: "account-1", workspaceId: "workspace-1", taskId: "task-2" },
  }));
  const rejected = await a.settle(rejectedTask.record.id, rejectedTask.record.revision, {
    state: "rejected", refusalCode: "account_ineligible",
  });
  assert.equal(rejected.state, "rejected");
  assert.equal((await b.reserve(reservation({
    idempotencyKey: "retry-rejected-task",
    identity: { accountId: "account-1", workspaceId: "workspace-1", taskId: "task-2" },
  }))).created, true);
  assert.equal(started.state, "started");
});

test("CAS revisions and allowlisted state transitions are enforced", async (t) => {
  const f = await fixture(t);
  const ledger = f.open();
  const created = await ledger.reserve(reservation());
  await assert.rejects(ledger.settle(created.record.id, 1, {
    state: "started", providerSessionId: "session-1",
  }), (error) => error instanceof ProvisioningLedgerError && error.code === "invalid_transition");
  const launching = await ledger.settle(created.record.id, 1, { state: "launching" });
  assert.equal(launching.revision, 2);
  await assert.rejects(ledger.settle(created.record.id, 1, { state: "needs_reconciliation" }),
    (error) => error instanceof ProvisioningLedgerError && error.code === "revision_conflict");
  const started = await ledger.settle(created.record.id, 2, {
    state: "started", providerSessionId: "session-1", reportedModel: "model-actual",
  });
  assert.equal(started.revision, 3);
  assert.equal(started.reportedModel, "model-actual");
  await assert.rejects(ledger.settle(created.record.id, 3, { state: "needs_reconciliation" }),
    (error) => error instanceof ProvisioningLedgerError && error.code === "invalid_transition");
  await assert.rejects(ledger.settle(created.record.id, 3, { state: "started", accountId: "changed" }), /Invalid settlement fields/);
});

test("metadata is bounded and SQLite files stay owner-private", async (t) => {
  const f = await fixture(t);
  const ledger = f.open();
  const directory = await stat(f.root);
  const database = await stat(f.databasePath);
  assert.equal(directory.mode & 0o077, 0);
  assert.equal(database.mode & 0o077, 0);
  await assert.rejects(ledger.reserve(reservation({ payloadDigest: "not-a-digest" })), /Invalid payload digest/);
  await assert.rejects(ledger.reserve(reservation({ idempotencyKey: "x".repeat(257) })), /Invalid idempotency key/);
  await assert.rejects(ledger.reserve({ ...reservation(), payload: "must not be stored" }), /Unknown reservation field/);
  ledger.close();
  await assert.rejects(ledger.getByIdempotencyKey("request-1"), /closed/);
});

test("separate processes share one durable reservation", async (t) => {
  const f = await fixture(t);
  f.open();
  const moduleUrl = new URL("../dist/providers/lightsprint-provisioning-ledger.js", import.meta.url).href;
  const code = `import {SqliteProvisioningLedger} from ${JSON.stringify(moduleUrl)};
    const ledger=new SqliteProvisioningLedger(process.argv[1]);
    const result=await ledger.reserve(JSON.parse(process.argv[2]));
    console.log(JSON.stringify(result));ledger.close();`;
  const run = promisify(execFile);
  const replies = await Promise.all([1, 2].map(() => run(process.execPath,
    ["--input-type=module", "-e", code, f.databasePath, JSON.stringify(reservation())], {timeout: 15000})));
  const rows = replies.map(reply => JSON.parse(reply.stdout));
  assert.equal(rows.filter(row => row.created).length, 1);
  assert.equal(rows[0].record.id, rows[1].record.id);
});

test("coordinator preserves mismatched pin evidence across restart and never changes session ownership", async (t) => {
  const f = await fixture(t);
  let launches = 0;
  let evidence = {accountId:"account-1",workspaceId:"workspace-1",taskId:"task-1",providerSessionId:"session-1",reportedModel:"wrong"};
  const adapter = {capabilities:{modelPin:true,effortPin:false},isAccountEligible:()=>true,
    launch:async()=>{ launches++; return {kind:"started",evidence}; },reconcile:async()=>[evidence]};
  const input = {...evidence,idempotencyKey:"coordinator",payload:{prompt:"bounded"},model:"wanted"};
  const original = f.open();
  const result = await new DurableSessionProvisioningCoordinator(original,adapter).provision(input);
  assert.equal(result.state,"needs_reconciliation");
  assert.equal(result.record.providerSessionId,"session-1");
  assert.equal(result.record.reportedModel,"wrong");
  original.close();
  const recovered = new DurableSessionProvisioningCoordinator(f.open(),adapter);
  assert.equal((await recovered.provision(input)).state,"needs_reconciliation");
  assert.equal((await recovered.reconcile("coordinator")).record.reportedModel,"wrong");
  evidence={...evidence,providerSessionId:"session-other",reportedModel:"wanted"};
  const changed=await recovered.reconcile("coordinator");
  assert.equal(changed.state,"needs_reconciliation");
  assert.equal(changed.record.providerSessionId,"session-1");
  evidence={...evidence,providerSessionId:"session-1"};
  assert.equal((await recovered.reconcile("coordinator")).state,"started");
  assert.equal(launches,1);
});
