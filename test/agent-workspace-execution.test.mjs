import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pkceS256 } from "../dist/crypto.js";
import { StateStore } from "../dist/store.js";
import { buildApp } from "../dist/server.js";
import { WorkspaceExecutionService } from "../dist/workspace-execution.js";

const ADMIN = "workspace-execution-test-password";
const listen = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address())); });
const close = server => new Promise(resolve => server.close(resolve));

async function oauthToken(base, scope = "mcp jobs:read jobs:write") {
  const registration = await (await fetch(base + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "workspace-execution", redirect_uris: [base + "/callback"] }) })).json();
  const verifier = "v".repeat(64);
  const consent = await fetch(base + "/oauth/authorize", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: registration.client_id, redirect_uri: base + "/callback", response_type: "code", code_challenge: pkceS256(verifier), code_challenge_method: "S256", resource: base + "/mcp", scope, admin_password: ADMIN }) });
  const location = consent.headers.get("location"); assert.ok(location, `OAuth consent failed ${consent.status}`);
  const code = new URL(location).searchParams.get("code");
  const token = await (await fetch(base + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, redirect_uri: base + "/callback", code, code_verifier: verifier, resource: base + "/mcp" }) })).json();
  return { token: token.access_token, clientId: registration.client_id };
}
const submission = (jobId, instructions = "Published instruction") => ({ schemaVersion: 1, jobId, idempotencyKey: "idem-" + jobId, projectId: "project-a", eligibleAccountIds: ["acct-a"], tasks: [{ taskId: "task-a", dependsOn: [], scopeKeys: ["path:src"], instructions, execution: { mode: "existing-session" }, output: { kind: "text", maxBytes: 2048, format: "text", expectedMarker: "DONE" } }] });

const BACKGROUND_RECONCILIATION_TIMEOUT_MS = 120_000;

test("workspace sync preserves the safe fresh-task roundtrip failure class", async () => {
  const summary = { projectId: "project-a", jobId: "job-roundtrip", state: "accepted", provider: "lightsprint", taskCount: 1, createdAt: 1, updatedAt: 1 };
  const runner = async (_executable, _args, stdin) => {
    const request = JSON.parse(stdin);
    if (request.command === "get") return JSON.stringify({ dispatch: summary, submission: { tasks: [{ taskId: "task-a" }] }, remoteJobId: "remote-job", actor: "client:owner" });
    if (request.command === "set_state") return JSON.stringify({ dispatch: { ...summary, state: request.state, updatedAt: 2 } });
    throw new Error("unexpected ledger command");
  };
  const backend = {
    authorizeWorkspace: async () => {},
    callTool: async (name) => name === "job_status"
      ? { state: "held", tasks: [{ taskId: "task-a", state: "blocked", error: "instruction_roundtrip_unverified" }] }
      : { results: [] },
  };
  const service = new WorkspaceExecutionService({ dir: "/tmp" }, backend, { runner });
  const result = await service.sync({ projectId: "project-a", jobId: "job-roundtrip" }, { projectId: "project-a", clientId: "client-owner" });
  assert.equal(result.status.state, "held");
  assert.equal(result.status.tasks[0].error, "instruction_roundtrip_unverified");
});

test("workspace execution persists before submit, replays once, reconciles owner-scoped results and publishes only bounded projections", { timeout: BACKGROUND_RECONCILIATION_TIMEOUT_MS + 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "rotoxy-aw-execution-"));
  const priorHome = process.env.HOME, priorConfig = process.env.ROTOXY_CONFIG_DIR;
  process.env.HOME = dir; process.env.ROTOXY_CONFIG_DIR = join(dir, "config");
  const projectMembers = new Map([["project-a", new Set()]]);
  const allowed = projectMembers.get("project-a");
  const submissions = new Map(); const calls = []; let ambiguous = true; let revokeAfterResults = false;
  const backend = {
    listProjects: () => [...projectMembers.keys()],
    workspaceProjects: async clientId => [...projectMembers.entries()].flatMap(([projectId, members]) => members.has(clientId) ? [{projectId}] : []),
    authorizeWorkspace: (projectId, clientId) => { if (!projectMembers.get(projectId)?.has(clientId)) throw new Error("workspace_forbidden"); },
    callTool: async (name, args, caller) => {
      calls.push({ name, args, caller });
      if (name === "job_submit") {
        await new Promise(resolve => setTimeout(resolve, 50));
        submissions.set(args.jobId, args);
        if (args.tasks?.[0]?.instructions === "ambiguous" && ambiguous) { ambiguous = false; throw new Error("timeout after send Basic dXNlcjpwYXNz https://user:secret@invalid.test password=private-value"); }
        return { assignmentId: args.jobId, state: "queued" };
      }
      if (name === "job_status") return { projectId: args.projectId, assignmentId: args.jobId, state: "completed", revision: 7, tasks: [...(submissions.get(args.jobId)?.tasks ?? []).map(t => ({taskId:t.taskId,state:"completed"})), { taskId: "unrelated-task", state: "completed" }] };
      if (name === "job_results") {
        if (revokeAfterResults) projectMembers.get(args.projectId)?.delete(caller.clientId);
        return { assignmentId: args.jobId, results: [...(submissions.get(args.jobId)?.tasks ?? []).map(t => ({taskId:t.taskId,text:"safe shared result",reportedModel:"reported-model"})), { taskId: "unrelated-task", text: "must not leak" }] };
      }
      throw new Error("unexpected tool " + name);
    },
  };
  let server;
  try {
    const store = new StateStore(); await store.init({ adminPassword: ADMIN });
    const app = await buildApp(store, { supervisorBackend: backend }); server = createHttpServer(app.app);
    const address = await listen(server), base = `http://127.0.0.1:${address.port}`;
    await store.update(s => { s.config.publicBaseUrl = base; s.config.basePath = ""; s.config.upstreamUrl = ""; });
    const owner = await oauthToken(base), collaborator = await oauthToken(base), readOnly = await oauthToken(base, "mcp jobs:read");
    allowed.add(owner.clientId); allowed.add(collaborator.clientId); allowed.add(readOnly.clientId);
    const mcp = async (client, name, args) => {
      const response = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } }) });
      const body = await response.json();
      const text = body.result?.content?.[0]?.text;
      return { status: response.status, body, value: text ? JSON.parse(text) : undefined };
    };
    assert.deepEqual((await mcp(readOnly,"workspace_projects",{})).value, {projects:[{projectId:"project-a"}]});
    assert.ok((await mcp(owner,"workspace_projects",{clientId:collaborator.clientId})).body.error);
    allowed.delete(readOnly.clientId);
    assert.deepEqual((await mcp(readOnly,"workspace_projects",{})).value, {projects:[]});
    allowed.add(readOnly.clientId);
    const listed = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.ok((await listed.json()).result.tools.some(tool => tool.name === "workspace_dispatch"));
    const readOnlyList = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${readOnly.token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    assert.equal((await readOnlyList.json()).result.tools.some(tool => tool.name === "workspace_dispatch"), false, "write tools are not silently granted to read-only OAuth clients");
    const readOnlyDispatch = await mcp(readOnly, "workspace_dispatch", submission("job-readonly"));
    assert.equal(readOnlyDispatch.status, 403);
    const spoofed = await mcp(owner, "workspace_dispatch", { ...submission("job-spoof"), clientId: collaborator.clientId, actor: "admin:local" });
    assert.ok(spoofed.body.error, "caller identity fields are rejected");
    assert.equal(calls.some(call => call.name === "job_submit" && call.args.jobId === "job-spoof"), false);

    const job = { ...submission("job-published"), shareMode: "fleet" };
    const [first, concurrentReplay] = await Promise.all([mcp(owner, "workspace_dispatch", job), mcp(owner, "workspace_dispatch", job)]);
    assert.ok(first.value?.dispatch || concurrentReplay.value?.dispatch, JSON.stringify([first.body, concurrentReplay.body]));
    const ownerSubmit = calls.find(call => call.name === "job_submit" && call.caller.clientId === owner.clientId);
    assert.ok(ownerSubmit.args.jobId.startsWith("ws-") && ownerSubmit.args.jobId !== job.jobId, "provider job id is namespaced away from a preexisting private job id");
    assert.equal(calls.filter(call => call.name === "job_submit" && call.caller.clientId === owner.clientId).length, 1);
    const privateJob = submission("job-private-by-default");
    const privateDispatch = await mcp(owner, "workspace_dispatch", privateJob);
    assert.equal(privateDispatch.value.dispatch.shareMode, "private");
    assert.equal(privateDispatch.value.shareHandle, undefined, "private jobs do not mint a share handle");
    const beforePrivateSummary = await mcp(collaborator, "workspace_snapshot", { projectId: "project-a" });
    assert.equal(beforePrivateSummary.value.executionSummaries?.some(row => row.jobId === privateJob.jobId), false, "private jobs are absent from shared Fleet summaries");
    const privateSync = await mcp(collaborator, "workspace_sync", { projectId: "project-a", jobId: privateJob.jobId });
    assert.ok(privateSync.body.error, "a Fleet collaborator cannot sync an owner's private job without a handle");

    const sharedJob = submission("job-shared-explicitly");
    const sharedDispatch = await mcp(owner, "workspace_dispatch", { ...sharedJob, shareMode: "fleet" });
    assert.equal(sharedDispatch.value.dispatch.shareMode, "fleet");
    assert.match(sharedDispatch.value.shareHandle, /^share_[A-Za-z0-9_-]{32}$/);
    const ownerRemote = calls.filter(call => call.name === "job_submit" && call.caller.clientId === owner.clientId).at(-1);
    assert.ok(ownerRemote, "only the initiating client submits the upstream job");
    assert.equal(ownerRemote.args.tasks[0].instructions, sharedJob.tasks[0].instructions);
    const sharedSubmits = calls.filter(call => call.name === "job_submit" && call.args.jobId === ownerRemote.args.jobId).length;
    const changedSharedPayload = { ...sharedJob, shareMode: "fleet", tasks: [{ ...sharedJob.tasks[0], instructions: "conflicting shared payload" }] };
    assert.ok((await mcp(owner, "workspace_dispatch", changedSharedPayload)).body.error, "a shared handle cannot be rebound to a conflicting payload hash");
    assert.equal(calls.filter(call => call.name === "job_submit" && call.args.jobId === ownerRemote.args.jobId).length, sharedSubmits, "payload conflicts never duplicate submit");
    const sharedSync = await mcp(collaborator, "workspace_sync", { projectId: "project-a", shareHandle: sharedDispatch.value.shareHandle });
    assert.equal(sharedSync.value.status.state, "completed");
    assert.equal(sharedSync.value.results[0].text, "safe shared result");
    assert.equal(calls.filter(call => call.name === "job_submit" && call.args.jobId === ownerRemote.args.jobId).length, sharedSubmits, "shared sync observes the initiator's existing job without resubmitting");
    assert.ok(calls.some(call => call.name === "job_status" && call.args.jobId === ownerRemote.args.jobId && call.caller.clientId === collaborator.clientId));
    assert.equal(calls.some(call => call.name === "job_submit" && call.caller.clientId === collaborator.clientId && call.args.jobId === ownerRemote.args.jobId), false, "the initiator retains the provider account/session binding");
    const wrongHandle = await mcp(collaborator, "workspace_sync", { projectId: "project-a", shareHandle: "share_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa" });
    assert.ok(wrongHandle.body.error, "unknown share handles fail closed");
    const beforeDeniedStatus = calls.filter(call => call.name === "job_status").length;
    allowed.delete(collaborator.clientId);
    const revokedShare = await mcp(collaborator, "workspace_sync", { projectId: "project-a", shareHandle: sharedDispatch.value.shareHandle });
    assert.ok(revokedShare.body.error, "revoked Fleet membership blocks shared job access");
    assert.equal(calls.filter(call => call.name === "job_status").length, beforeDeniedStatus, "revoked collaborators cannot reach provider status");
    allowed.add(collaborator.clientId);
    const auditRead = spawnSync("/usr/bin/python3", ["-c", "import json,sqlite3,sys; d=sqlite3.connect(sys.argv[1]); print(json.dumps(d.execute(\"SELECT action,actor_client_id FROM workspace_execution_audit WHERE job_id=? AND action IN ('share_created','sync_shared') ORDER BY id\",(sys.argv[2],)).fetchall()))", join(store.dir, "agent-workspace.sqlite3"), sharedJob.jobId], { encoding: "utf8" });
    assert.equal(auditRead.status, 0, auditRead.stderr);
    assert.deepEqual(JSON.parse(auditRead.stdout), [["share_created", owner.clientId], ["sync_shared", collaborator.clientId]], "shared access records the initiating and collaborating actor IDs");
    const samePublicId = await mcp(collaborator, "workspace_dispatch", job);
    assert.ok(samePublicId.value?.accepted, JSON.stringify(samePublicId.body));
    const collaboratorSubmit = calls.find(call => call.name === "job_submit" && call.caller.clientId === collaborator.clientId);
    assert.notEqual(collaboratorSubmit.args.jobId, ownerSubmit.args.jobId, "same project/job label gets an owner-specific provider binding");
    const ownerSubmitsBeforeReplay = calls.filter(call => call.name === "job_submit" && call.caller.clientId === owner.clientId).length;
    await close(server);
    const restartedApp = await buildApp(store, { supervisorBackend: backend }); server = createHttpServer(restartedApp.app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address.port, "127.0.0.1", resolve); });
    const replay = await mcp(owner, "workspace_dispatch", job);
    assert.equal(replay.value.replayed, true);
    assert.equal(calls.filter(call => call.name === "job_submit" && call.caller.clientId === owner.clientId).length, ownerSubmitsBeforeReplay);
    const conflict = await mcp(owner, "workspace_dispatch", submission("job-published", "different request"));
    assert.ok(conflict.body.error, "conflicting request hash must be rejected");
    assert.equal(calls.filter(call => call.name === "job_submit" && call.caller.clientId === owner.clientId).length, ownerSubmitsBeforeReplay);

    const otherProject = await mcp(owner, "workspace_dispatch", { ...submission("job-other"), projectId: "project-b" });
    assert.ok(otherProject.body.error);
    const unauthorizedSync = await mcp(readOnly, "workspace_sync", { projectId: "project-a", jobId: "job-published" });
    assert.ok(unauthorizedSync.body.error, "another owner cannot sync this job");
    assert.equal(calls.filter(call => call.name === "job_status" && call.caller.clientId === readOnly.clientId).length, 0);

    const synced = await mcp(owner, "workspace_sync", { projectId: "project-a", jobId: "job-published" });
    assert.equal(synced.value.status.state, "completed");
    assert.equal(synced.value.results[0].text, "safe shared result");
    assert.ok(calls.some(call => call.name === "job_results" && call.caller.clientId === owner.clientId));
    const snapshotResponse = await mcp(collaborator, "workspace_snapshot", { projectId: "project-a" });
    assert.ok(snapshotResponse.value.executionSummaries.some(row => row.provider === "lightsprint" && row.taskCount === 1));
    assert.ok(snapshotResponse.value.tasks.every(task => !task.description.includes("Published instruction")));
    assert.equal(new Set(snapshotResponse.value.tasks.filter(task => task.externalTaskId === "task-a").map(task => task.id)).size, 3, "shared task identifiers are owner-specific across three published executions");
    assert.ok(snapshotResponse.value.artifacts.some(artifact => artifact.reference === "safe shared result"));
    assert.equal(snapshotResponse.value.artifacts.find(artifact => artifact.reference === "safe shared result").state, "pending");
    assert.equal(snapshotResponse.value.tasks[0].state, "review", "artifact import leaves approval to an independent reviewer");
    assert.equal(synced.value.status.tasks.some(task => task.taskId === "unrelated-task"), false, "status projection is limited to submitted task ids");
    assert.equal(synced.value.results.some(result => result.taskId === "unrelated-task"), false, "result projection is limited to submitted task ids");
    const ownArtifact = snapshotResponse.value.artifacts.find(artifact => artifact.reference === "safe shared result");
    const selfReview = await mcp(owner, "workspace_update", { projectId: "project-a", input: { action: "review_decide", idempotencyKey: "owner-self-review", expectedRevision: snapshotResponse.value.revision, artifactId: ownArtifact.id, decision: "approved" } });
    assert.ok(selfReview.body.error, "the original dispatch author cannot approve their own execution artifact");

    const beforeRevocation = snapshotResponse.value.artifacts.length;
    revokeAfterResults = true;
    const revoked = await mcp(owner, "workspace_sync", { projectId: "project-a", jobId: job.jobId });
    assert.ok(revoked.body.error, "membership is checked again after remote reads and before projection");
    revokeAfterResults = false;
    allowed.add(owner.clientId);
    const afterRevocation = await mcp(collaborator, "workspace_snapshot", { projectId: "project-a" });
    assert.equal(afterRevocation.value.artifacts.length, beforeRevocation, "membership loss prevents shared result projection");

    const uncertain = submission("job-ambiguous", "ambiguous");
    const ambiguousCallsBefore = calls.filter(call => call.name === "job_submit" && call.caller.clientId === owner.clientId).length;
    const firstAttempt = await mcp(owner, "workspace_dispatch", uncertain);
    assert.equal(firstAttempt.value.accepted, false);
    assert.equal(firstAttempt.value.providerError,"provider_operation_unavailable");
    assert.doesNotMatch(JSON.stringify(firstAttempt.value),/dXNlcjpwYXNz|private-value|user:secret/);
    assert.equal(firstAttempt.value.dispatch.state, "needs_reconciliation");
    const retry = await mcp(owner, "workspace_dispatch", uncertain);
    assert.equal(retry.value.replayed, true);
    assert.equal(calls.filter(call => call.name === "job_submit" && call.caller.clientId === owner.clientId).length, ambiguousCallsBefore + 1, "ambiguous submit is not resent");
    const reconciled = await mcp(owner, "workspace_sync", { projectId: "project-a", jobId: uncertain.jobId });
    assert.equal(reconciled.value.status.state, "completed");
    const dag = { ...submission("job-dependency-review"), shareMode: "fleet" };
    dag.tasks.push({...structuredClone(dag.tasks[0]), taskId:"task-b", dependsOn:["task-a"], scopeKeys:["path:tests"]});
    assert.equal((await mcp(owner,"workspace_dispatch",dag)).value.accepted,true);
    const firstSync=await mcp(owner,"workspace_sync",{projectId:"project-a",jobId:dag.jobId});
    assert.equal(firstSync.value.projectionPending,true,"provider completion cannot forge a prerequisite review");
    let board=(await mcp(collaborator,"workspace_snapshot",{projectId:"project-a"})).value;
    const firstTask=board.tasks.find(t=>t.jobId===dag.jobId&&t.externalTaskId==="task-a");
    const nextTask=board.tasks.find(t=>t.jobId===dag.jobId&&t.externalTaskId==="task-b");
    assert.equal(firstTask.state,"review");assert.equal(nextTask.state,"queued");
    const artifact=board.artifacts.find(a=>a.taskId===firstTask.id);
    const review=await mcp(collaborator,"workspace_update",{projectId:"project-a",input:{action:"review_decide",artifactId:artifact.id,decision:"approved",idempotencyKey:"dependency-independent-review",expectedRevision:board.revision}});
    assert.ok(!review.body.error,JSON.stringify(review.body));
    const nextSync=await mcp(owner,"workspace_sync",{projectId:"project-a",jobId:dag.jobId});
    assert.equal(nextSync.value.projectionPending,false);
    board=(await mcp(collaborator,"workspace_snapshot",{projectId:"project-a"})).value;
    assert.equal(board.tasks.find(t=>t.id===nextTask.id).state,"review");
    assert.ok(board.executions.some(e=>e.jobId===dag.jobId));
    assert.ok(board.executionRevision>0);

    // Keep the scheduled handoff proof in a fresh task context.  The earlier
    // cases deliberately retain unsettled bindings for their own assertions;
    // allowing those to occupy reconciliation leases makes this timing test
    // depend on unrelated backlog order rather than scheduler behavior.
    const backgroundProject = "project-background";
    projectMembers.set(backgroundProject, new Set([owner.clientId, collaborator.clientId]));
    const background = { ...submission("job-background-handoff"), projectId: backgroundProject, shareMode: "fleet" };
    assert.equal((await mcp(owner,"workspace_dispatch",background)).value.accepted,true);
    const submitCount=calls.filter(c=>c.name==="job_submit").length;
    // Observe the real scheduled sync completing rather than repeatedly spawning
    // snapshot subprocesses while the background reconciler needs the same CPU.
    const originalSync = restartedApp.agentWorkspace.sync;
    let signalBackground;
    const synchronized = new Promise(resolve => { signalBackground = resolve; });
    restartedApp.agentWorkspace.sync = async (...args) => {
      const result = await originalSync.apply(restartedApp.agentWorkspace, args);
      if (args[1] === background.jobId && result.projectionPending === false) signalBackground();
      return result;
    };
    const reconciler=restartedApp.agentWorkspace.createReconciler(200);
    let timeout;
    try {
      reconciler.start();
      await Promise.race([synchronized, new Promise((_, reject) => {
        timeout=setTimeout(()=>reject(new Error("background reconciliation did not publish before deadline")), BACKGROUND_RECONCILIATION_TIMEOUT_MS);
      })]);
    } finally {
      clearTimeout(timeout);
      reconciler.stop();
      restartedApp.agentWorkspace.sync = originalSync;
    }
    const observed=(await mcp(collaborator,"workspace_snapshot",{projectId:backgroundProject})).value;
    const backgroundTask=observed.tasks.find(t=>t.jobId===background.jobId);
    assert.ok(observed.artifacts.some(a=>a.taskId===backgroundTask?.id),"background reconciliation publishes results after the initiating HTTP request ended");
    assert.equal(calls.filter(c=>c.name==="job_submit").length,submitCount,"background observation never launches another inference/job");

  } finally {
    if (server) await close(server);
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorConfig === undefined) delete process.env.ROTOXY_CONFIG_DIR; else process.env.ROTOXY_CONFIG_DIR = priorConfig;
    await rm(dir, { recursive: true, force: true });
  }
});
