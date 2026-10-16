import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { WorkspaceExecutionService } from "../dist/workspace-execution.js";
import { WorkspaceReconciler } from "../dist/workspace-reconciler.js";

const supervisor = new URL("../supervisor/", import.meta.url).pathname;
const binding = (jobId, clientId = "client-a") => ({ projectId: "project-a", jobId, clientId });

test("SQLite reconciliation lease is scoped, durable, and only settles terminal complete projections", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rotoxy-workspace-reconcile-"));
  const oldHome = process.env.HOME;
  const oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(dir, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(dir, "config");
  t.after(async () => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
    await rm(dir, { recursive: true, force: true });
  });
  const store = new StateStore();
  await store.init({ adminPassword: "test-only" });
  const db = join(store.dir, "agent-workspace.sqlite3");
  const legacySchema = `import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("""CREATE TABLE workspace_execution_bindings(
    project_id TEXT NOT NULL, job_id TEXT NOT NULL, remote_job_id TEXT NOT NULL, client_id TEXT NOT NULL,
    actor TEXT NOT NULL, idempotency_key TEXT NOT NULL, remote_idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    submission_json TEXT NOT NULL, remote_submission_json TEXT NOT NULL, state TEXT NOT NULL, remote_state TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(project_id,client_id,job_id),
    UNIQUE(project_id,client_id,idempotency_key), UNIQUE(project_id,remote_job_id))"""); db.commit()`;
  const oldDb = spawnSync("/usr/bin/python3", ["-c", legacySchema, db], { encoding: "utf8" });
  assert.equal(oldDb.status, 0, oldDb.stderr);
  const ledger = (request) => {
    const proc = spawnSync("/usr/bin/python3", ["-m", "snooze.workspace_execution", "--db", db], { cwd: supervisor, input: JSON.stringify(request), encoding: "utf8" });
    return { status: proc.status, value: JSON.parse(proc.stdout) };
  };
  const reserve = (jobId, clientId = "client-a") => ledger({
    command: "reserve", projectId: "project-a", jobId, remoteJobId: `remote-${jobId}`, clientId, actor: `client:${clientId}`,
    idempotencyKey: `key-${jobId}`, remoteIdempotencyKey: `remote-key-${jobId}`, requestHash: "a".repeat(64),
    submission: { projectId: "project-a", jobId, tasks: [{ instructions: "private prompt" }] },
    remoteSubmission: { projectId: "project-a", jobId: `remote-${jobId}` },
  });
  assert.equal(reserve("job-a").status, 0);
  assert.equal(reserve("job-b", "client-b").status, 0);

  const firstClaim = ledger({ command: "claim_reconciliation", limit: 3 });
  assert.equal(firstClaim.status, 0);
  assert.deepEqual(firstClaim.value.bindings, [binding("job-a"), binding("job-b", "client-b")]);
  assert.equal(JSON.stringify(firstClaim.value).includes("private prompt"), false);
  // A separate process simulates restart; the persisted 120s lease prevents duplicate work.
  assert.deepEqual(ledger({ command: "claim_reconciliation", limit: 3 }).value.bindings, []);
  assert.equal(ledger({ command: "settle_reconciliation", ...binding("job-a", "client-b") }).status, 2, "wrong owner cannot settle another binding");
  assert.deepEqual(ledger({ command: "settle_reconciliation", ...binding("job-a") }).value, { settled: true });
  assert.deepEqual(ledger({ command: "claim_reconciliation", limit: 3 }).value.bindings, [], "the other claimed row remains leased");
  assert.deepEqual(ledger({ command: "settle_reconciliation", ...binding("job-b", "client-b") }).value, { settled: true });
  assert.equal(ledger({ command: "claim_reconciliation", limit: 0 }).status, 2);

  assert.equal(reserve("job-terminal").status, 0);
  const service = new WorkspaceExecutionService(store);
  const syncCalls = [];
  const callbacks = service.reconciliationCallbacks(async (row) => {
    syncCalls.push(row);
    return { dispatch: { state: "completed" }, projectionPending: false, resultsUnavailable: false };
  });
  assert.deepEqual(Object.keys(callbacks).sort(), ["claim", "settle", "sync"], "reconciliation has no submit callback");
  const reconciler = new WorkspaceReconciler(callbacks);
  const run = await reconciler.runOnce();
  assert.deepEqual(run, { claimed: 1, settled: 1, errors: 0, skipped: false });
  assert.deepEqual(syncCalls, [binding("job-terminal")]);
  assert.deepEqual(ledger({ command: "claim_reconciliation", limit: 3 }).value.bindings, []);

  for (const id of ["old-one", "old-two", "old-three", "new-unobserved"]) assert.equal(reserve(id).status, 0);
  const aged = spawnSync("/usr/bin/python3", ["-c", "import sqlite3,sys,time; d=sqlite3.connect(sys.argv[1]); d.execute(\"UPDATE workspace_execution_bindings SET created_at=1,last_polled_at=?,lease_until=0 WHERE job_id LIKE 'old-%'\",(int(time.time()*1000)-130000,)); d.commit()", db], { encoding: "utf8" });
  assert.equal(aged.status, 0, aged.stderr);
  assert.deepEqual(ledger({ command: "claim_reconciliation", limit: 1 }).value.bindings, [binding("new-unobserved")], "older long-running jobs cannot starve unobserved arrivals");

  const uncertainResults = [
    { dispatch: { state: "completed" }, projectionPending: false, resultsUnavailable: true },
    { dispatch: { state: "completed" }, projectionPending: true, resultsUnavailable: false },
    { dispatch: { state: "running" }, projectionPending: false, resultsUnavailable: false },
    { dispatch: { state: "completed" }, resultsUnavailable: false },
  ];
  for (const result of uncertainResults) {
    let settles = 0;
    const local = new WorkspaceReconciler({ claim: async () => [binding("job-a")], sync: async () => result, settle: async () => { settles++; } });
    await local.runOnce();
    assert.equal(settles, 0, "uncertain or incomplete outcomes must remain unsettled");
  }

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const processed = [];
  const local = new WorkspaceReconciler({
    claim: async () => [binding("one"), binding("two"), binding("three")],
    sync: async (row) => { processed.push(row.jobId); if (row.jobId === "one") await gate; return { dispatch: { state: "failed" }, projectionPending: false, resultsUnavailable: false }; },
    settle: async () => {},
  });
  const pending = local.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await local.runOnce()).skipped, true, "overlapping runs are rejected");
  local.stop();
  release();
  assert.deepEqual(await pending, { claimed: 1, settled: 1, errors: 0, skipped: false });
  assert.deepEqual(processed, ["one"], "stop halts remaining rows");
  assert.equal((await local.runOnce()).skipped, true);

});
