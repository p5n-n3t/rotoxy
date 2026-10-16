import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { StateStore } from "../dist/store.js";
import { AdminSessions, adminEpoch } from "../dist/admin-session.js";
import {
  AgentWorkspaceError,
  AgentWorkspaceService,
  AW_TOOL_DEFINITIONS,
  awRequiredScope,
  createAgentWorkspaceRouter,
  isAgentWorkspaceToolName,
  validateAgentWorkspaceToolArguments,
} from "../dist/agent-workspace.js";

const sampleSnapshot = (projectId) => ({
  projectId, revision: 0, participants: [], tasks: [], messages: [], artifacts: [], reviews: [], events: [], nextCursor: 0,
});

test("Agent Workspace service binds trusted actors, bounds the Python bridge, and protects admin routes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rotoxy-agent-workspace-"));
  const oldHome = process.env.HOME;
  const oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home");
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  t.after(async () => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
    await rm(root, { recursive: true, force: true });
  });

  const store = new StateStore();
  await store.init({ adminPassword: "test-only-password", publicBaseUrl: "https://gateway.example/base" });
  const calls = [];
  const backend = { listProjects: () => ["project-a"] };
  const runner = async (executable, args, stdin, options) => {
    calls.push({ executable, args, stdin: JSON.parse(stdin), options });
    const payload = JSON.parse(stdin);
    return JSON.stringify(payload.command === "snapshot" ? sampleSnapshot(payload.projectId) : { accepted: true, revision: 1 });
  };
  const service = new AgentWorkspaceService(store, backend, { runner });

  assert.deepEqual(await service.projects(), ["project-a"]);
  const snapshot = await service.snapshot("project-a", "client:client-1", 9);
  assert.deepEqual(snapshot, sampleSnapshot("project-a"));
  assert.equal(calls[0].executable, "/usr/bin/python3");
  assert.deepEqual(calls[0].args.slice(0, 3), ["-m", "snooze.agent_workspace", "--db"]);
  assert.equal(isAbsolute(calls[0].args[3]), true);
  assert.equal(calls[0].args[3], join(store.dir, "agent-workspace.sqlite3"));
  assert.equal(calls[0].options.cwd.endsWith("/supervisor/"), true);
  assert.equal(calls[0].options.timeoutMs, 10_000);
  assert.equal(calls[0].options.maxStdoutBytes, 512 * 1024);
  assert.deepEqual(calls[0].stdin, { command: "snapshot", projectId: "project-a", actor: "client:client-1", after: 9 });

  const validInput = { action: "task_create", taskId: "task-1", idempotencyKey: "once-1", expectedRevision: 0, title: "Prepare review", description: "bounded task" };
  assert.deepEqual(await service.update("project-a", "admin:local", validInput), { accepted: true, revision: 1 });
  assert.equal(calls[1].stdin.actor, "admin:local");
  assert.deepEqual(calls[1].stdin.input, validInput);
  const beforeRejectedCalls = calls.length;
  await assert.rejects(service.update("project-a", "client:client-1", { ...validInput, actor: "client:other" }), AgentWorkspaceError);
  await assert.rejects(service.snapshot("project-a", "client:bad/id"), AgentWorkspaceError);
  await assert.rejects(service.snapshot("../outside", "admin:local"), AgentWorkspaceError);
  await assert.rejects(service.snapshot("project-a", "admin:local", -1), AgentWorkspaceError);
  await assert.rejects(service.update("unknown-project", "admin:local", validInput), AgentWorkspaceError);
  assert.equal(calls.length, beforeRejectedCalls);
  const invalidOutput = new AgentWorkspaceService(store, backend, { runner: async () => "not-json" });
  await assert.rejects(invalidOutput.snapshot("project-a", "admin:local"), (error) => error.code === "bridge_output_invalid");
  const oversizedOutput = new AgentWorkspaceService(store, backend, { runner: async () => "x".repeat(512 * 1024 + 1) });
  await assert.rejects(oversizedOutput.snapshot("project-a", "admin:local"), (error) => error.code === "bridge_output_invalid");

  assert.deepEqual(AW_TOOL_DEFINITIONS.map((tool) => tool.name), ["workspace_snapshot", "workspace_update"]);
  assert.equal(isAgentWorkspaceToolName("workspace_update"), true);
  assert.equal(isAgentWorkspaceToolName("workspace_delete_all"), false);
  assert.equal(awRequiredScope("workspace_snapshot"), "jobs:read");
  assert.equal(awRequiredScope("workspace_update"), "jobs:write");
  assert.deepEqual(validateAgentWorkspaceToolArguments("workspace_snapshot", { projectId: "project-a", after: 3 }), { projectId: "project-a", after: 3 });
  assert.throws(() => validateAgentWorkspaceToolArguments("workspace_snapshot", { projectId: "project-a", actor: "admin:local" }), AgentWorkspaceError);

  const sessions = new AdminSessions();
  const session = sessions.create(undefined, adminEpoch(await store.load()));
  const csrf = sessions.csrfToken(session);
  const app = express();
  app.use(createAgentWorkspaceRouter(store, sessions, service));
  const server = createServer(app);
  const address = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = `t2o_admin=${session}`;

  assert.equal((await fetch(`${base}/admin/api/v1/agent-workspace/project-a`)).status, 401);
  assert.equal((await fetch(`${base}/admin/api/v1/agent-workspace/unknown-project`, { headers: { cookie } })).status, 404);
  const api = await fetch(`${base}/admin/api/v1/agent-workspace/project-a?after=2`, { headers: { cookie } });
  assert.equal(api.status, 200);
  assert.deepEqual(await api.json(), sampleSnapshot("project-a"));
  assert.equal(calls.at(-1).stdin.after, 2);
  assert.equal(calls.at(-1).stdin.actor, "admin:local");
  const pageResponse = await fetch(`${base}/admin/agents`, { headers: { cookie } });
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Agent Workspace/);
  assert.match(pageResponse.headers.get("content-security-policy"), /default-src 'none'/);
  const selectedPage = await fetch(`${base}/admin/agents?project=project-a`, { headers: { cookie } });
  assert.equal(selectedPage.status, 200);
  assert.match(await selectedPage.text(), /Durable workspace data is available/);

  const postUrl = `${base}/admin/api/v1/agent-workspace/project-a/update`;
  const body = JSON.stringify({ input: validInput });
  const baseHeaders = { cookie, "content-type": "application/json" };
  assert.equal((await fetch(postUrl, { method: "POST", headers: baseHeaders, body })).status, 403);
  assert.equal((await fetch(postUrl, { method: "POST", headers: { ...baseHeaders, "x-csrf-token": csrf, origin: "https://attacker.example" }, body })).status, 403);
  const accepted = await fetch(postUrl, { method: "POST", headers: { ...baseHeaders, "x-csrf-token": csrf, origin: base }, body });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { accepted: true, revision: 1 });
  assert.equal(calls.at(-1).stdin.actor, "admin:local");
  const actorOverride = await fetch(postUrl, { method: "POST", headers: { ...baseHeaders, "x-csrf-token": csrf, origin: base }, body: JSON.stringify({ input: { ...validInput, actor: "client:forged" } }) });
  assert.equal(actorOverride.status, 400);
  assert.equal(calls.at(-1).stdin.actor, "admin:local");
});
