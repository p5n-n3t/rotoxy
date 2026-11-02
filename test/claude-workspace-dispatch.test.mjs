import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeWorkspaceDispatch, ClaudeWorkspaceDispatchError } from "../dist/claude-workspace-dispatch.js";

const caller = { clientId: "oauth-client-a", projectId: "project-a" };
const task = { projectId: "project-a", taskId: "task-a", title: "Review the change", description: "Produce a short review artifact.", state: "queued" };

function setup({ duplicate = false, result = { sessionId: "11111111-1111-4111-8111-111111111111", text: "Reviewed result", model: "claude-sonnet-4-6", costUsd: 0.01 }, failPublish = false } = {}) {
  const events = [];
  const source = {
    async resolveOwnedTask(input) { events.push(["resolve", input]); return task; },
    async claimTask(input) { events.push(["claim", input]); },
    async publishResult(input) { events.push(["artifact", input]); if (failPublish) throw new Error("private artifact backend detail"); return { artifactId: "artifact-a" }; },
  };
  const attempts = {
    async reserve(input) { events.push(["reserve", input]); return { created: !duplicate, attemptId: "attempt-a", status: duplicate ? "ambiguous" : "intent" }; },
    async update(input) { events.push(["attempt", input]); },
  };
  const dispatch = { async start(input) { events.push(["start", input]); return { runId: "owned-run-a", profileId: "profile-claude-0001", model: "claude-sonnet-4-6", cancel() {}, promise: Promise.resolve(result) }; } };
  return { service: new ClaudeWorkspaceDispatch(source, attempts, dispatch), events };
}

async function flush() { await new Promise(resolve => setImmediate(resolve)); }

test("workspace dispatch durably reserves before launching and publishes a result artifact", async () => {
  const { service, events } = setup();
  const submitted = await service.submit({ projectId: "project-a", taskId: "task-a", profileId: "profile-claude-0001" }, caller);
  assert.deepEqual(submitted, { accepted: true, replayed: false, attemptId: "attempt-a", state: "running" });
  assert.deepEqual(events.slice(0, 4).map(event => event[0]), ["resolve", "reserve", "claim", "start"]);
  const reserved = events.find(event => event[0] === "reserve")[1];
  assert.equal(reserved.ownerClientId, caller.clientId);
  assert.equal(reserved.projectId, caller.projectId);
  assert.equal(reserved.taskId, task.taskId);
  assert.match(reserved.promptDigest, /^[a-f0-9]{64}$/);
  assert.equal(events.find(event => event[0] === "start")[1].prompt.includes("Review the change"), true);
  assert.equal(events.find(event => event[0] === "start")[1].prompt.includes("Produce a short review artifact."), true);
  await flush();
  assert.deepEqual(events.filter(event => event[0] === "artifact").map(event => event[1].text), ["Reviewed result"]);
  assert.equal(events.at(-1)[0], "attempt");
  assert.equal(events.at(-1)[1].status, "success");
});

test("existing durable attempt returns its state and never launches a second Claude run", async () => {
  const { service, events } = setup({ duplicate: true });
  const submitted = await service.submit({ projectId: "project-a", taskId: "task-a", profileId: "profile-claude-0001" }, caller);
  assert.deepEqual(submitted, { accepted: false, replayed: true, attemptId: "attempt-a", state: "ambiguous" });
  assert.deepEqual(events.map(event => event[0]), ["resolve", "reserve"]);
});

test("ambiguous child outcome is recorded without exposing raw provider errors or replaying", async () => {
  const { service, events } = setup();
  const ambiguous = Object.assign(new Error("AWS bearer secret response"), { code: "execution_ambiguous", ambiguous: true });
  // Replace the dispatch test seam with one owned run that fails ambiguously.
  service.dispatch.start = async input => {
    events.push(["start", input]);
    return { runId: "owned-run-a", profileId: "profile-claude-0001", model: "claude-sonnet-4-6", cancel() {}, promise: Promise.reject(ambiguous) };
  };
  const submitted = await service.submit({ projectId: "project-a", taskId: "task-a", profileId: "profile-claude-0001" }, caller);
  assert.equal(submitted.state, "running");
  await flush();
  const last = events.at(-1)[1];
  assert.equal(last.status, "ambiguous");
  assert.equal(last.result, "execution_ambiguous");
  assert.doesNotMatch(JSON.stringify(events), /AWS bearer secret response/);
  assert.equal(events.filter(event => event[0] === "start").length, 1);
});

test("caller cannot select prompts or execution paths and task authorization is bound to its project", async () => {
  const { service, events } = setup();
  await assert.rejects(service.submit({ projectId: "project-a", taskId: "task-a", profileId: "profile-claude-0001", prompt: "inject" }, caller),
    error => error instanceof ClaudeWorkspaceDispatchError && error.code === "invalid_input");
  await assert.rejects(service.submit({ projectId: "project-b", taskId: "task-a", profileId: "profile-claude-0001" }, caller),
    error => error instanceof ClaudeWorkspaceDispatchError && error.code === "invalid_input");
  assert.equal(events.length, 0);
});

test("a failed artifact write is durably distinguished from provider completion", async () => {
  const { service, events } = setup({ failPublish: true });
  await service.submit({ projectId: "project-a", taskId: "task-a", profileId: "profile-claude-0001" }, caller);
  await flush();
  const last = events.at(-1)[1];
  assert.equal(last.status, "artifact_failed");
  assert.equal(last.result, "Reviewed result");
  assert.doesNotMatch(JSON.stringify(events), /private artifact backend detail/);
});

test("provider result secrets are redacted before either artifact or attempt storage", async () => {
  const { service, events } = setup({ result: { sessionId: "11111111-1111-4111-8111-111111111111", text: "Bearer secret-value sk-abcdefghijklmnop", model: "claude-sonnet-4-6" } });
  await service.submit({ projectId: "project-a", taskId: "task-a", profileId: "profile-claude-0001" }, caller);
  await flush();
  const storedText = events.filter(event => event[0] === "artifact").map(event => event[1].text).join(" ") + events.filter(event => event[0] === "attempt").map(event => event[1].result ?? "").join(" ");
  assert.match(storedText, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(storedText, /secret-value|sk-abcdefghijklmnop/);
});

test('multiline results longer than a preview are retained within the explicit result limit',async()=>{
 const text='line one\n'+'review detail '.repeat(200);
 const {service,events}=setup({result:{text,model:'claude-sonnet-4-6'}});
 await service.submit({projectId:'project-a',taskId:'task-a',profileId:'profile-claude-0001'},caller);await flush();
 assert.equal(events.find(event=>event[0]==='artifact')[1].text,text.trim());
 assert.equal(events.at(-1)[1].result,text.trim());
});
