import test from "node:test";
import assert from "node:assert/strict";
import { safeClientId } from "../dist/oauth-client-id.js";
import { WorkspaceExecutionService } from "../dist/workspace-execution.js";

const submission = {
  schemaVersion: 1, projectId: "project-a", jobId: "job-a", idempotencyKey: "key-a",
  eligibleAccountIds: ["account-a"], tasks: [{
    taskId: "task-a", dependsOn: [], scopeKeys: ["path:src"], instructions: "Return DONE",
    execution: { mode: "existing-session" },
    output: { kind: "text", maxBytes: 2048, format: "text", expectedMarker: "DONE" },
  }],
};

for (const clientId of ["_opaque-client", "-opaque-client"]) {
  test(`workspace dispatch preserves opaque OAuth owner ${clientId}`, async () => {
    const calls = [], ledger = [];
    const service = new WorkspaceExecutionService({ dir: "/unused-test-store" }, {
      authorizeWorkspace: async (project, owner) => {
        assert.equal(project, "project-a"); assert.equal(owner, clientId);
      },
      callTool: async (name, args, caller) => { calls.push({ name, args, caller }); },
    }, {
      runner: async (_executable, _args, input) => {
        const request = JSON.parse(input); ledger.push(request);
        const dispatch = { projectId: "project-a", jobId: "job-a", state: request.state ?? "pending" };
        return JSON.stringify(request.command === "reserve" ? { created: true, shouldSubmit: true, dispatch } : dispatch);
      },
    });
    const caller = { projectId: "project-a", clientId };
    const result = await service.dispatch(submission, caller);
    assert.equal(result.accepted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "job_submit");
    assert.deepEqual(calls[0].caller, caller);
    assert.ok(ledger.every(row => row.clientId === clientId));
    assert.equal(ledger[0].actor, `client:${clientId}`);
  });
}

test("opaque OAuth IDs reject unsafe values before ledger or provider access", async () => {
  const service = new WorkspaceExecutionService({ dir: "/unused-test-store" }, {
    callTool: async () => { assert.fail("provider must not be called"); },
  }, { runner: async () => { assert.fail("ledger must not be called"); } });
  for (const clientId of ["", "a".repeat(129), "client/path", "client\n", "client\r", "client\t", "client\0", "client space", "éclient"]) {
    assert.equal(safeClientId(clientId), false, JSON.stringify(clientId));
    await assert.rejects(service.dispatch(submission, { projectId: "project-a", clientId }), { code: "invalid_input" });
  }
});
