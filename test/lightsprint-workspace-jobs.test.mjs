import test from "node:test";
import assert from "node:assert/strict";
import { LightSprintJobsAdapter } from "../dist/providers/lightsprint-jobs.js";
import { LightSprintWorkspacePinnedJobsAdapter, workspaceBranchName } from "../dist/providers/lightsprint-workspace-pinned-jobs.js";

const description = "Every path starts /api/workspaces/{workspaceId}/, written `…/` below\nworkspaceId = ws-a\nPOST …/tasks\nPOST …/agent-sessions\nGET …/agent-sessions";
function harness({ permit, policy = { endpoints: [{ rules: [] }] }, workspace = "ws-a", lostLaunch = false, wrongTask = false } = {}) {
  const calls = [];
  let instructions = "";
  const store = {
    load: async () => ({ config: { toolPolicy: policy }, accounts: [{ id: "acct-a", provider: "lightsprint", enabled: true }] }),
    revealToken: async () => "synthetic-token",
  };
  const options = {
    trustedWorkspacePermit: permit,
    clientFactory: () => ({ request: async (method, params) => {
      if (method === "tools/list") return { tools: [{ name: "lightsprint_api", description: description.replace("workspaceId = ws-a", `workspaceId = ${workspace}`) }] };
      calls.push(params.arguments);
      const args = params.arguments;
      if (args.method === "PATCH") instructions = args.body.description;
      if (args.method === "POST" && args.path.endsWith("/agent-sessions")) {
        if (lostLaunch) throw new Error("lost response");
        return { structuredContent: { session: { id: "session-a", model: "reported-model" } } };
      }
      if (args.method === "GET" && args.path.startsWith("/api/workspaces/") && args.path.includes("/agent-sessions?taskRef=")) {
        return { structuredContent: { activeAgent: { id: "_session-a", taskRef: "LW-1", model: "reported-model" }, recentAgents: [] } };
      }
      return { structuredContent: { task: { id: wrongTask ? "internal-a" : "LW-1", ref: wrongTask ? "LW-1" : "MARYSW-2", description: instructions,
        ...(wrongTask ? { parent: { id: "LW-1", description: instructions } } : {}) } } };
    } }),
  };
  const adapter = new LightSprintJobsAdapter(store, "acct-a", options);
  return { adapter, calls, newAdapter: () => new LightSprintJobsAdapter(store, "acct-a", options), changeInstructions: value => { instructions = value; } };
}

test("catalog discovery never overrides denied policy without an explicit internal permit", async () => {
  const h = harness();
  assert.equal((await h.adapter.createWorkspaceTask("ws-a", "Bound task")).reason, "policy_denied");
  assert.equal(h.calls.length, 0);
});

test("wrong workspace is rejected even when global policy is permissive", async () => {
  const h = harness({ policy: {} });
  assert.equal((await h.adapter.createWorkspaceTask("ws-other", "Bound task")).reason, "identity_mismatch");
  assert.equal(h.calls.length, 0);
});

test("explicit tool denial cannot be overridden by internal workspace permit", async () => {
  const h = harness({ policy: { denyTools: ["lightsprint_api"] }, permit: () => true });
  assert.equal((await h.adapter.createWorkspaceTask("ws-a", "Bound task")).reason, "policy_denied");
  assert.equal(h.calls.length, 0);
});

test("workspace observation and cancellation retain scoped routes and correct methods", async () => {
  const h = harness({ permit: () => true });
  await h.adapter.workspaceSessionStatus("ws-a", "session-a");
  await h.adapter.workspaceSessionTranscript("ws-a", "session-a");
  await h.adapter.cancelWorkspaceTurn("ws-a", "session-a");
  await h.adapter.stopWorkspaceSession("ws-a", "session-a");
  assert.deepEqual(h.calls.map(c => [c.method, c.path]), [
    ["GET", "/api/workspaces/ws-a/agent-sessions/session-a/status"],
    ["GET", "/api/workspaces/ws-a/agent-sessions/session-a/transcript?limit=100&include=text&maxBytes=131072"],
    ["POST", "/api/workspaces/ws-a/agent-sessions/session-a/actions/cancel"],
    ["PATCH", "/api/workspaces/ws-a/agent-sessions/session-a"],
  ]);
  assert.deepEqual(h.calls.at(-1).body, { status: "stopped" });
});

test("workspace stack discovery stays account bound", async () => {
  const h = harness({ permit: request => request.method === "GET" });
  await h.adapter.listWorkspaceStacks("ws-a");
  assert.deepEqual(h.calls, [{ method: "GET", path: "/api/workspaces/ws-a/stacks" }]);
});

test("pinned task session inspection uses only the documented taskRef-scoped GET", async () => {
  const h = harness({ permit: request => request.method === "GET" });
  const pinned = new LightSprintWorkspacePinnedJobsAdapter(h.adapter, "ws-a");
  const result = await pinned.listTaskAgents("LW-1");
  assert.equal(result.classification, "accepted");
  assert.deepEqual(result.value.activeAgent, { id: "_session-a", taskRef: "LW-1", model: "reported-model" });
  assert.deepEqual(h.calls, [{ method: "GET", path: "/api/workspaces/ws-a/agent-sessions?taskRef=LW-1" }]);
});

test("scoped task instructions read back by canonical id beside a human ref", async () => {
  const permits = [];
  const h = harness({ permit: request => { permits.push(request); return true; } });
  assert.equal((await h.adapter.patchWorkspaceTaskInstructions("ws-a", "LW-1", "Reviewed instructions")).instructionsVerified, true);
  const result = await h.adapter.launchWorkspaceSession("ws-a", "LW-1", "codex", "rotoxy-proof-1", "Reviewed instructions");
  assert.equal(result.classification, "accepted");
  assert.equal(result.reportedModel, "reported-model");
  assert.deepEqual(h.calls.at(-1), { method: "POST", path: "/api/workspaces/ws-a/agent-sessions", body: {
    taskRef: "LW-1", branchName: "rotoxy-proof-1", provider: "codex", autoMerge: false,
  } });
  assert.ok(permits.every(r => r.accountId === "acct-a" && r.workspaceId === "ws-a" && Object.isFrozen(r)));
});

test("lost launch response is ambiguous and repeated launch cannot replay the mutation", async () => {
  const h = harness({ permit: () => true, lostLaunch: true });
  await h.adapter.patchWorkspaceTaskInstructions("ws-a", "LW-1", "Reviewed instructions");
  assert.equal((await h.adapter.launchWorkspaceSession("ws-a", "LW-1", "codex", "proof-1")).classification, "ambiguous");
  assert.equal((await h.adapter.launchWorkspaceSession("ws-a", "LW-1", "codex", "proof-1")).reason, "instructions_mismatch");
  assert.equal(h.calls.filter(c => c.method === "POST").length, 1);
});

test("changed upstream instructions block launch before POST", async () => {
  const h = harness({ permit: () => true });
  await h.adapter.patchWorkspaceTaskInstructions("ws-a", "LW-1", "Reviewed instructions");
  h.changeInstructions("Unreviewed edit");
  const freshOperationAdapter = new LightSprintWorkspacePinnedJobsAdapter(h.newAdapter(), "ws-a");
  assert.equal((await freshOperationAdapter.launchVerifiedTask("LW-1", "claude", "Reviewed instructions")).reason, "instructions_mismatch");
  assert.equal(h.calls.filter(c => c.method === "POST").length, 0);
});

test("catalog with conflicting workspace declarations cannot authorize scoped I/O", async () => {
  const h = harness({ permit: () => true, workspace: "ws-a\nworkspaceId = ws-b" });
  assert.equal((await h.adapter.createWorkspaceTask("ws-a", "Bound task")).reason, "identity_mismatch");
  assert.equal(h.calls.length, 0);
});

test("a nested related task cannot satisfy task identity readback", async () => {
  const h = harness({ permit: () => true, wrongTask: true });
  assert.equal((await h.adapter.patchWorkspaceTaskInstructions("ws-a", "LW-1", "Reviewed instructions")).reason, "instructions_mismatch");
  assert.equal((await h.adapter.launchWorkspaceSession("ws-a", "LW-1", "codex", "proof-1")).reason, "instructions_mismatch");
  assert.equal(h.calls.filter(c => c.method === "POST").length, 0);
});

test("canonical task id mismatch cannot be rescued by a matching human ref", async () => {
  const h = harness({ permit: () => true, wrongTask: true });
  assert.equal((await h.adapter.patchWorkspaceTaskInstructions("ws-a", "LW-1", "Reviewed instructions")).reason, "instructions_mismatch");
  assert.equal((await h.adapter.launchWorkspaceSession("ws-a", "LW-1", "codex", "proof-1", "Reviewed instructions")).reason, "instructions_mismatch");
  assert.equal(h.calls.filter(c => c.method === "POST").length, 0);
});

test("concurrent launch calls consume only one verified launch binding", async () => {
  const h = harness({ permit: () => true });
  await h.adapter.patchWorkspaceTaskInstructions("ws-a", "LW-1", "Reviewed instructions");
  const results = await Promise.all([
    h.adapter.launchWorkspaceSession("ws-a", "LW-1", "codex", "proof-1"),
    h.adapter.launchWorkspaceSession("ws-a", "LW-1", "codex", "proof-1"),
  ]);
  assert.equal(results.filter(r => r.classification === "accepted").length, 1);
  assert.equal(h.calls.filter(c => c.method === "POST").length, 1);
});

test("pinned worker adapter cannot substitute its verified workspace and derives a bounded branch label", async () => {
  const h = harness({ permit: () => true });
  const adapter = new LightSprintWorkspacePinnedJobsAdapter(h.adapter, "ws-a");
  assert.equal(await adapter.createTask("Bound task", "stack-a").then(row => row.classification), "accepted");
  assert.equal((await adapter.patchTaskInstructions("LW-1", "Reviewed instructions")).instructionsVerified, true);
  assert.equal((await adapter.launchTask("LW-1", "codex")).classification, "accepted", "legacy two-argument call retains its one-shot local verification path");
  const stateless = new LightSprintWorkspacePinnedJobsAdapter(h.newAdapter(), "ws-a");
  const launched = await stateless.launchVerifiedTask("LW-1", "codex", "Reviewed instructions");
  assert.equal(launched.classification, "accepted");
  assert.deepEqual(h.calls.at(-1), { method: "POST", path: "/api/workspaces/ws-a/agent-sessions", body: {
    taskRef: "LW-1", branchName: workspaceBranchName("LW-1"), provider: "codex", autoMerge: false,
  } });
  assert.match(workspaceBranchName("LW-1"), /^rotoxy-[a-f0-9]{24}$/);
});
