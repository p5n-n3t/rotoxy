import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORACLE_OPS_MAX_PAGE_SIZE,
  OracleOpsError,
  loadOracleOpsSnapshot,
  renderOracleOpsPage,
} from "../dist/oracle-ops.js";

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), "t2o-rotoxy-ops-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function isolatedEnv(t) {
  const root = await tempRoot(t);
  const oldHome = process.env.HOME;
  const oldConfigDir = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = root;
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "gateway-config");
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldConfigDir === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR;
    else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfigDir;
  });
  return root;
}

function fixture() {
  return {
    available: true,
    hosts: ["ora1", "ora3", "ora5"].map((host) => ({ host, models: ["tev1:0.8b"], lastCatalogCheck: 10, catalogCheckState: "checked", assignedTasks: 1, completedTasks: 1, runningTasks: 0 })),
    summary: { totalTasks: 3, taskCounts: { queued: 0, running: 0, complete: 3 }, completedLastHour: 2, throughputWindowSeconds: 3600, promptTokens: { total: 8, observations: 2 }, evalTokens: { total: 4, observations: 2 }, assignmentDenominator: 3, assignmentDistribution: ["ora1", "ora3", "ora5"].map((host) => ({ host, count: 1, share: 1 / 3 })) },
    tasks: { items: [{ status: "complete", model: "qwen3.5:9b", assignedHost: "ora1", createdAt: 1, updatedAt: 2, attempts: 1, actualModel: "qwen3.5:9b", promptTokens: 3, evalTokens: 2, remoteSeconds: 1.1, elapsedSeconds: 1.2, errorCode: null }], limit: 20, offset: 0, total: 3, hasMore: true, nextOffset: 20 },
    events: { items: [{ eventId: 1, kind: "complete", at: 2, status: "complete", host: "ora1", model: "qwen3.5:9b", actualModel: "qwen3.5:9b", errorCode: null }], limit: 20, after: 0, nextCursor: 1, hasMore: false },
    advisoryModel: { model: "tev1:0.8b", availability: "available" },
  };
}

test("loader uses only fixed Python module and trusted explicit pool paths", async (t) => {
  const root = await isolatedEnv(t);
  const calls = [];
  const expected = fixture();
  const snapshot = await loadOracleOpsSnapshot({
    supervisorCwd: join(root, "repo", "supervisor"),
    configPath: join(root, "private", "oracle.json"),
    dbPath: join(root, "private", "oracle.sqlite3"),
    commandRunner: async (command, args, request) => {
      calls.push({ command, args, request });
      return JSON.stringify(expected);
    },
  }, { limit: 10, offset: 20, afterEvent: 30 });
  assert.deepEqual(snapshot, expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/python3");
  assert.deepEqual(calls[0].args.slice(0, 6), ["-m", "snooze.oracle_ops", "--config", join(root, "private", "oracle.json"), "--db", join(root, "private", "oracle.sqlite3")]);
  assert.deepEqual(calls[0].args.slice(-6), ["--limit", "10", "--offset", "20", "--after-event", "30"]);
  assert.equal(calls[0].request.cwd, join(root, "repo", "supervisor"));
});

test("loader accepts bounded configured hosts and model IDs without an enum filter", async (t) => {
  const root = await isolatedEnv(t);
  const snapshot = fixture();
  snapshot.hosts.push({ host: "ora7-lab", models: ["team/model-x:4b"], lastCatalogCheck: 20,
    catalogCheckState: "checked", configured: true, enabled: true, assignedTasks: 0, completedTasks: 0, runningTasks: 0 });
  const loaded = await loadOracleOpsSnapshot({ supervisorCwd: root, configPath: join(root, "config"), dbPath: join(root, "db"),
    commandRunner: async () => JSON.stringify(snapshot) });
  assert.equal(loaded.hosts.at(-1).host, "ora7-lab");
  assert.deepEqual(loaded.hosts.at(-1).models, ["team/model-x:4b"]);
});

test("loader fails closed on malformed host and model identifiers", async (t) => {
  const root = await isolatedEnv(t);
  const options = { supervisorCwd: root, configPath: join(root, "config"), dbPath: join(root, "db"), commandRunner: async () => "" };
  for (const change of [
    (snapshot) => { snapshot.hosts[0].host = "<img src=x>"; },
    (snapshot) => { snapshot.hosts[0].models = ["<script>"]; },
    (snapshot) => { snapshot.tasks.items[0].actualModel = { untrusted: true }; },
  ]) {
    const snapshot = fixture(); change(snapshot);
    await assert.rejects(loadOracleOpsSnapshot({ ...options, commandRunner: async () => JSON.stringify(snapshot) }),
      (error) => error instanceof OracleOpsError && error.code === "invalid_snapshot");
  }
});

test("loader rejects non-absolute trusted paths and out-of-bound pagination before invoking command", async (t) => {
  const root = await isolatedEnv(t);
  let calls = 0;
  const options = { supervisorCwd: root, configPath: join(root, "config"), dbPath: join(root, "db"), commandRunner: async () => { calls++; return "{}"; } };
  await assert.rejects(loadOracleOpsSnapshot({ ...options, dbPath: "../../operator.sqlite" }), (error) => error.code === "invalid_trusted_paths");
  await assert.rejects(loadOracleOpsSnapshot(options, { limit: ORACLE_OPS_MAX_PAGE_SIZE + 1 }), (error) => error.code === "invalid_limit");
  await assert.rejects(loadOracleOpsSnapshot(options, { offset: 10_001 }), (error) => error.code === "invalid_offset");
  assert.equal(calls, 0);
});

test("rendered operator page is escaped, bounded in scope, and labels missing data clearly", () => {
  const snapshot = fixture();
  snapshot.hosts.push({ host: "ora7-lab", models: ["team/model-x:4b"], lastCatalogCheck: 20, catalogCheckState: "checked",
    configured: true, enabled: true, assignedTasks: 4, completedTasks: 3, runningTasks: 1 });
  snapshot.tasks.items[0].assignedHost = "ora7-lab";
  snapshot.tasks.items[0].actualModel = "team/model-x:4b";
  snapshot.tasks.items[0].errorCode = "worker_error";
  snapshot.summary.assignmentDistribution.push({ host: "ora7-lab", count: 1, share: 0.25 });
  snapshot.summary.assignmentDenominator = 4;
  snapshot.hosts[0].catalogError = "<script>owner-secret</script>";
  snapshot.summary.promptTokens.total = null;
  snapshot.summary.assignmentDenominator = 0;
  snapshot.summary.assignmentDistribution = snapshot.summary.assignmentDistribution.map((entry) => ({ ...entry, count: 0, share: null }));
  const html = renderOracleOpsPage({ base: "/gateway", snapshot });
  assert.match(html, /Oracle pool/);
  assert.match(html, /ora7-lab/);
  assert.match(html, /team\/model-x:4b/);
  assert.match(html, /Provider: Not reported/);
  assert.match(html, /Utilization not reported: no stored host-slot capacity/);
  assert.match(html, /1 completed · 1 error/);
  assert.match(html, /Requested model/);
  assert.match(html, /Reported model/);
  assert.match(html, /\/gateway\/admin\/oracle\/models/);
  assert.match(html, /\/gateway\/admin\/services/);
  assert.match(html, /min-width:1050px/);
  assert.match(html, /Lightweight advisory model/);
  assert.match(html, /share not reported/);
  assert.match(html, /Prompt tokens observed<\/div><div class="metric">Not reported/);
  assert.match(html, /&lt;script&gt;owner-secret&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>owner-secret/);
  assert.doesNotMatch(html, /source-owner|private-prompt|private-result|task-id/);
});

test("real read-only Python CLI reports missing pool state without creating files", async (t) => {
  const root = await isolatedEnv(t);
  const poolDir = join(root, "private-oracle");
  const configPath = join(poolDir, "config.json");
  const dbPath = join(poolDir, "queue.sqlite3");
  const snapshot = await loadOracleOpsSnapshot({
    supervisorCwd: join(process.cwd(), "supervisor"), configPath, dbPath,
  });
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.summary.totalTasks, null);
  assert.equal(snapshot.advisoryModel.availability, "unknown");
  assert.deepEqual(snapshot.hosts.map((host) => host.host), ["ora1", "ora3", "ora5"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-oracle/);
});

test("loader times out injected process runner with a safe error", async (t) => {
  const root = await isolatedEnv(t);
  await assert.rejects(loadOracleOpsSnapshot({
    supervisorCwd: root, configPath: join(root, "config"), dbPath: join(root, "db"), timeoutMs: 100,
    commandRunner: async (_command, _args, request) => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("private path")), { once: true })),
  }), (error) => error instanceof OracleOpsError && error.code === "snapshot_timeout");
});
