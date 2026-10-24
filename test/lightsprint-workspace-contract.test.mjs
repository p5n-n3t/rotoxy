import test from "node:test";
import assert from "node:assert/strict";
import { LightSprintWorkspaceContract } from "../dist/providers/lightsprint-workspace-contract.js";

// ── Construction ─────────────────────────────────────────────────────────────

test("valid accountId and workspaceId construct without error", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  assert.equal(contract.accountId, "acct-01");
  assert.equal(contract.workspaceId, "ws-abc");
});

test("provider-generated session IDs may begin with underscore or hyphen", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  for (const id of ["_session-a", "-session-b"]) {
    const result = contract.sessionStatusRoute(id);
    assert.equal(result.ok, true);
    assert.equal(result.route.path, `/api/workspaces/ws-abc/agent-sessions/${id}/status`);
  }
});

test("invalid accountId throws TypeError at construction", () => {
  assert.throws(() => new LightSprintWorkspaceContract({ accountId: "", workspaceId: "ws-abc" }), TypeError);
  assert.throws(() => new LightSprintWorkspaceContract({ accountId: "/etc/passwd", workspaceId: "ws-abc" }), TypeError);
  assert.throws(() => new LightSprintWorkspaceContract({ accountId: null, workspaceId: "ws-abc" }), TypeError);
});

test("invalid workspaceId throws TypeError at construction", () => {
  assert.throws(() => new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "" }), TypeError);
  assert.throws(() => new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws/bad" }), TypeError);
  assert.throws(() => new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "../evil" }), TypeError);
});

// ── Account binding ───────────────────────────────────────────────────────────

test("verifyAccountBinding returns true only for exact accountId match", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  assert.equal(contract.verifyAccountBinding("acct-01"), true);
  assert.equal(contract.verifyAccountBinding("acct-02"), false);
  assert.equal(contract.verifyAccountBinding(""), false);
  assert.equal(contract.verifyAccountBinding(null), false);
  assert.equal(contract.verifyAccountBinding(undefined), false);
  assert.equal(contract.verifyAccountBinding(42), false);
});

test("verifyAccountBinding rejects a prefix match", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  assert.equal(contract.verifyAccountBinding("acct-0"), false);
  assert.equal(contract.verifyAccountBinding("acct-010"), false);
});

// ── Workspace-scoped route shapes ────────────────────────────────────────────

test("taskCreateRoute returns POST to workspace tasks path", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const r = contract.taskCreateRoute();
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/api/workspaces/ws-abc/tasks");
  assert.equal(r.accountId, "acct-01");
  assert.equal(r.workspaceId, "ws-abc");
});

test("taskListRoute returns GET to workspace tasks path", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const r = contract.taskListRoute();
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/api/workspaces/ws-abc/tasks");
});

test("sessionCreateRoute returns POST to workspace agent-sessions path", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const r = contract.sessionCreateRoute();
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/api/workspaces/ws-abc/agent-sessions");
});

test("sessionListRoute returns GET to workspace agent-sessions path", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const r = contract.sessionListRoute();
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/api/workspaces/ws-abc/agent-sessions");
});

// ── Session-level route validation ───────────────────────────────────────────

test("sessionStatusRoute returns ok route for valid sessionId", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const result = contract.sessionStatusRoute("sess-001");
  assert.equal(result.ok, true);
  assert.equal(result.route.method, "GET");
  assert.equal(result.route.path, "/api/workspaces/ws-abc/agent-sessions/sess-001/status");
  assert.equal(result.route.accountId, "acct-01");
});

test("sessionTranscriptRoute returns ok route for valid sessionId", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const result = contract.sessionTranscriptRoute("sess-001");
  assert.equal(result.ok, true);
  assert.equal(result.route.path, "/api/workspaces/ws-abc/agent-sessions/sess-001/transcript");
});

test("sessionChatRoute returns ok route for valid sessionId", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const result = contract.sessionChatRoute("sess-001");
  assert.equal(result.ok, true);
  assert.equal(result.route.method, "POST");
  assert.equal(result.route.path, "/api/workspaces/ws-abc/agent-sessions/sess-001/chat");
});

test("sessionCancelRoute returns ok route for valid sessionId", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const result = contract.sessionCancelRoute("sess-001");
  assert.equal(result.ok, true);
  assert.equal(result.route.method, "POST");
  assert.equal(result.route.path, "/api/workspaces/ws-abc/agent-sessions/sess-001/actions/cancel");
});

test("sessionStopRoute returns PATCH route for valid sessionId", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const result = contract.sessionStopRoute("sess-001");
  assert.equal(result.ok, true);
  assert.equal(result.route.method, "PATCH");
  assert.equal(result.route.path, "/api/workspaces/ws-abc/agent-sessions/sess-001");
});

// ── Path injection rejection ─────────────────────────────────────────────────

test("session routes reject path traversal fragments", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const injections = [
    "../other-session",
    "sess/../../admin",
    "sess\0null",
    "sess?query=x",
    "sess#fragment",
    "%2F",
    "",
    null,
    undefined,
    42,
    { toString() { return "sess-001"; } },
  ];
  for (const bad of injections) {
    const status = contract.sessionStatusRoute(bad);
    assert.equal(status.ok, false, `expected rejection for: ${JSON.stringify(bad)}`);
    assert.equal(status.reason, "invalid_session_id");

    const chat = contract.sessionChatRoute(bad);
    assert.equal(chat.ok, false);
    assert.equal(chat.reason, "invalid_session_id");

    const cancel = contract.sessionCancelRoute(bad);
    assert.equal(cancel.ok, false);

    const stop = contract.sessionStopRoute(bad);
    assert.equal(stop.ok, false);
  }
});

test("scopedTaskReadRoute rejects path injection in taskId", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const bad = ["../secrets", "task/../../other", "task?x=1", "", null];
  for (const taskId of bad) {
    const result = contract.scopedTaskReadRoute(taskId);
    assert.equal(result.ok, false, `expected rejection for: ${JSON.stringify(taskId)}`);
    assert.equal(result.reason, "invalid_task_id");
  }
});

test("scopedTaskReadRoute returns correct path for valid taskId", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const result = contract.scopedTaskReadRoute("task-001");
  assert.equal(result.ok, true);
  assert.equal(result.route.method, "GET");
  assert.equal(result.route.path, "/api/workspaces/ws-abc/tasks/task-001");
});

// ── Ownership mismatch ───────────────────────────────────────────────────────

test("route objects from different contracts carry their own bound accountId", () => {
  const contractA = new LightSprintWorkspaceContract({ accountId: "acct-A", workspaceId: "ws-001" });
  const contractB = new LightSprintWorkspaceContract({ accountId: "acct-B", workspaceId: "ws-002" });

  const routeA = contractA.taskCreateRoute();
  const routeB = contractB.taskCreateRoute();

  assert.equal(routeA.accountId, "acct-A");
  assert.equal(routeB.accountId, "acct-B");

  // A route from contract A must not pass B's account binding check.
  assert.equal(contractB.verifyAccountBinding(routeA.accountId), false);
  assert.equal(contractA.verifyAccountBinding(routeB.accountId), false);
});

test("workspace paths do not leak across distinct contracts", () => {
  const contractA = new LightSprintWorkspaceContract({ accountId: "acct-A", workspaceId: "ws-001" });
  const contractB = new LightSprintWorkspaceContract({ accountId: "acct-B", workspaceId: "ws-002" });

  const pathA = contractA.sessionCreateRoute().path;
  const pathB = contractB.sessionCreateRoute().path;

  assert.ok(pathA.includes("ws-001"), "path A should contain its own workspaceId");
  assert.ok(pathB.includes("ws-002"), "path B should contain its own workspaceId");
  assert.ok(!pathA.includes("ws-002"), "path A must not contain B's workspaceId");
  assert.ok(!pathB.includes("ws-001"), "path B must not contain A's workspaceId");
});

// ── Route object immutability ─────────────────────────────────────────────────

test("route objects are frozen and cannot be mutated by callers", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const r = contract.taskCreateRoute();
  assert.throws(() => { r.path = "/injected"; }, TypeError);
  assert.throws(() => { r.method = "GET"; }, TypeError);
  assert.throws(() => { r.accountId = "other"; }, TypeError);
});

// ── No model/effort/pricing inference ────────────────────────────────────────

test("contract carries no model pins, effort pins, pricing or entitlement fields", () => {
  const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
  const keys = Object.keys(contract);
  for (const forbidden of ["model", "effort", "pricing", "entitlement", "quota", "slots"]) {
    assert.ok(!keys.includes(forbidden), `unexpected field: ${forbidden}`);
  }
  const r = contract.taskCreateRoute();
  const routeKeys = Object.keys(r);
  for (const forbidden of ["model", "effort", "pricing", "entitlement"]) {
    assert.ok(!routeKeys.includes(forbidden), `route has unexpected field: ${forbidden}`);
  }
});

 test("account and workspace binding cannot be mutated after construction", () => {
 const contract = new LightSprintWorkspaceContract({ accountId: "acct-01", workspaceId: "ws-abc" });
 assert.throws(() => { contract.accountId = "acct-02"; }, TypeError);
 assert.throws(() => { contract.workspaceId = "other"; }, TypeError);
 assert.equal(contract.sessionStatusRoute("sess-001").route.path, "/api/workspaces/ws-abc/agent-sessions/sess-001/status");
 });
