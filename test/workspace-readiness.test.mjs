import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisorRuntime } from "../dist/supervisor-runtime.js";

const config = {
  version: 1,
  projects: [
    { projectId: "project-a", clientIds: ["client-a"], accountIds: ["acct-a"], registeredSessions: [{ sessionId: "session-a", accountId: "acct-a", model: "gpt-6-luna", workspaceId: "workspace-a" }] },
    { projectId: "project-b", clientIds: ["client-b"], accountIds: ["acct-b"], registeredSessions: [{ sessionId: "session-b", accountId: "acct-b", model: "gpt-6-luna", workspaceId: "workspace-b" }] },
  ],
  maxWorkers: 2, allowUnknownQuota: true,
  localLimits: { maxTasks: 10, maxJobBytes: 8192, maxOutputBytes: 1024 },
};

function makeHarness(t, credit, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "rotoxy-readiness-"));
  const accounts = [
    { id: "acct-a", label: "Project A account", provider: "lightsprint", enabled: true, stats: { state: "healthy" } },
    { id: "acct-b", label: "Foreign account", provider: "lightsprint", enabled: true, stats: { state: "healthy" } },
  ];
  if (options.disabled) accounts[0].enabled = false;
  const store = { async load() { return { config: { upstreamUrl: "https://app.lightsprint.ai/mcp" }, accounts }; } };
  const runtime = new SupervisorRuntime(config, { configDir: root, store,
    supervisionDbPath: join(root, "inbox.sqlite"), recoveryDbPath: join(root, "recovery.sqlite"),
    oracleConfigPath: join(root, "oracle.json"), oracleDbPath: join(root, "oracle.sqlite") });
  let reads = 0;
  runtime.bridge.request = async (method, route) => {
    assert.equal(method, "GET");
    assert.equal(route, "/admin/api/v1/credit-admission");
    reads++;
    if (options.unavailable) throw new Error("credential=must-not-escape");
    return credit;
  };
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, get reads() { return reads; } };
}

test("workspace readiness names incomplete credit policy states without presenting them as worker status", async (t) => {
  const empty = makeHarness(t, { mode: "strict", accounts: [] });
  const blocked = await empty.runtime.workspaceResources("project-a");
  assert.equal(blocked[0].executionAvailability, "Blocked: no verified credit policy");
  assert.equal(empty.reads, 1);

  for (const [label, credit, unavailable, expected] of [
    ["malformed", { mode: "strict", accounts: [{ accountId: "acct-a", available: 100, operationUpperBound: 1, boundVerified: true }] }, false, "Credit admission data needs correction; live session readiness not checked"],
    ["legacy", { mode: "legacy", accounts: [] }, false, "Legacy credit policy needs confirmation; live session readiness not checked"],
    ["unavailable", undefined, true, "Credit admission check unavailable; live session readiness not checked"],
  ]) {
    const h = makeHarness(t, credit, { unavailable });
    const resources = await h.runtime.workspaceResources("project-a");
    assert.equal(resources[0].executionAvailability, expected, label);
    assert.equal(h.reads, 1, `${label} status performs exactly one read`);
  }
});

test("readiness blocks insufficient balance, reports a bounded passing credit check, and never claims live session availability", async (t) => {
  const insufficient = makeHarness(t, { mode: "strict", accounts: [{ accountId: "acct-a", unit: "credits", available: 2, operationUpperBound: 3, boundVerified: true }] });
  assert.equal((await insufficient.runtime.workspaceResources("project-a"))[0].executionAvailability,
    "Blocked: available balance below verified operation upper bound");

  const sufficient = makeHarness(t, { mode: "strict", accounts: [{ accountId: "acct-a", unit: "credits", available: 3, operationUpperBound: 3, boundVerified: true }] });
  const resource = (await sufficient.runtime.workspaceResources("project-a"))[0];
  assert.equal(resource.executionAvailability, "Credit check passed; live session readiness not checked");
  assert.equal("available" in resource, false);
});

test("readiness uses only project-bound accounts and current disabled-account signals", async (t) => {
  const h = makeHarness(t, { mode: "strict", accounts: [
    { accountId: "acct-a", unit: "credits", available: 100, operationUpperBound: 1, boundVerified: true },
    { accountId: "acct-b", unit: "private-foreign-unit", available: 999999, operationUpperBound: 1, boundVerified: true, error: "credential=foreign-secret" },
  ] });
  const resources = await h.runtime.workspaceResources("project-a");
  assert.deepEqual(resources.map(({ accountId, sessionId }) => ({ accountId, sessionId })), [{ accountId: "acct-a", sessionId: "session-a" }]);
  assert.doesNotMatch(JSON.stringify(resources), /acct-b|private-foreign-unit|foreign-secret/);

  const disabled = makeHarness(t, { mode: "strict", accounts: [{ accountId: "acct-a", unit: "credits", available: 10, operationUpperBound: 1, boundVerified: true }] }, { disabled: true });
  assert.equal((await disabled.runtime.workspaceResources("project-a"))[0].executionAvailability, "Account disabled");
});
