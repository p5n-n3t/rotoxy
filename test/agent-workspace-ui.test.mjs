import test from "node:test";
import assert from "node:assert/strict";
import { renderAgentWorkspace } from "../dist/agent-workspace-ui.js";

const options = { base: "/token2oauth", csrfToken: "csrf<&", projects: ["project-a", "project-b"], projectId: "project-a" };
const snapshot = {
  projectId: "project-a", revision: 7, nextCursor: 15,
  participants: [
    { id: "client:worker-a", label: "Runner A", provider: "Codex", model: "gpt-reported", accountId: "acct-a", updatedAt: "2026-10-16T10:00:00Z" },
    { id: "admin:local", label: "Operator", provider: "local" },
  ],
  tasks: [
    { id: "task-q", title: "Queued task", description: "Queued", state: "queued", dependsOn: [], revision: 1 },
    { id: "task-w", title: "Running task", description: "Active work", state: "running", assignee: "client:worker-a", jobId: "job-a", dependsOn: ["task-q"] },
    { id: "task-b", title: "Blocked task", description: "Waiting", state: "blocked", assignee: "client:worker-a", dependsOn: [] },
    { id: "task-r", title: "Review task", description: "Review this", state: "review", assignee: "client:worker-a", dependsOn: [] },
    { id: "task-d", title: "Done task", description: "Complete", state: "complete", dependsOn: [] },
  ],
  messages: [{ id: "msg-1", from: "client:worker-a", to: "all", taskId: "task-w", text: "Bearer abc123 is redacted", createdAt: "2026-10-16T10:02:00Z" }],
  artifacts: [{ id: "artifact-1", taskId: "task-r", kind: "branch", reference: "codex/agent-work", title: "Implementation", submittedBy: "client:worker-a", submittedAt: "2026-10-16T10:04:00Z" }],
  reviews: [],
  events: [{ type: "task_claimed", actor: "client:worker-a", taskId: "task-w", createdAt: "2026-10-16T10:01:00Z" }],
};

test("renders AW records in the shared page shell with real workflow columns and participant attribution", () => {
  const html = renderAgentWorkspace(snapshot, options);
  assert.match(html, /<title>Agent workspace · ROTOXY<\/title>/);
  assert.match(html, /Agent workspace/);
  assert.match(html, /href="\/token2oauth\/admin\/workspace"/);
  for (const column of ["Queued", "Working", "Review", "Done"]) assert.match(html, new RegExp(`>${column}<`));
  assert.match(html, /Runner A/);
  assert.match(html, /gpt-reported \(reported\)/);
  assert.match(html, /Account acct-a \(reported\)/);
  assert.match(html, /Blocked task/);
  assert.match(html, /aw-blocked/);
  assert.match(html, /task_claim/);
  assert.match(html, /task_update/);
  assert.match(html, /artifact_submit/);
  assert.match(html, /review_decide/);
  assert.match(html, /message_send/);
  assert.match(html, /task_create/);
  assert.match(html, /participant_upsert/);
  assert.match(html, /Pending review/);
});

test("posts native bounded forms to the project update route with CSRF, revision, and idempotency", () => {
  const html = renderAgentWorkspace({ ...snapshot, projectId: "project:a" }, { ...options, projectId: "project:a", projects: ["project:a"] });
  assert.match(html, /action="\/token2oauth\/admin\/api\/v1\/agent-workspace\/project%3Aa\/update"/);
  assert.match(html, /name="_csrf" value="csrf&lt;&amp;"/);
  assert.match(html, /name="expectedRevision" value="7"/);
  assert.match(html, /name="idempotencyKey" value="[0-9a-f-]{36}"/);
  assert.match(html, /maxlength="2000"/);
  assert.match(html, /maxlength="8000"/);
  assert.doesNotMatch(html, /<script\b/i);
});

test("escapes and redacts user content and never renders arbitrary record fields", () => {
  const dirty = structuredClone(snapshot);
  dirty.messages[0].text = '<img src=x onerror="bad"> access_token=private-value';
  dirty.messages[0].unexpectedSecret = "do-not-render";
  dirty.artifacts[0].reference = "Bearer hidden-token";
  const html = renderAgentWorkspace(dirty, options);
  assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;/);
  assert.match(html, /access_token=\[redacted\]/);
  assert.match(html, /Bearer \[redacted\]/);
  assert.doesNotMatch(html, /private-value|hidden-token|do-not-render|onerror="bad"/);
});

test("project mismatch and empty snapshots show honest empty states without foreign records", () => {
  const mismatch = renderAgentWorkspace({ ...snapshot, projectId: "project-b" }, options);
  assert.match(mismatch, /Workspace snapshot unavailable/);
  assert.doesNotMatch(mismatch, /Queued task|Runner A/);
  const empty = renderAgentWorkspace({ projectId: "project-a", revision: 0 }, options);
  assert.match(empty, /No participants registered yet/);
  assert.match(empty, /No queued tasks reported/);
  assert.match(empty, /No messages in this project snapshot/);
  assert.match(empty, /No artifacts submitted in this project/);
  assert.match(empty, /Participants<\/dt><dd>0/);
});

test("caps rendered collections and includes responsive, reduced-motion, and keyboard affordances", () => {
  const many = structuredClone(snapshot);
  many.participants = Array.from({ length: 120 }, (_, index) => ({ id: `client:${index}`, label: `Runner ${index}`, provider: "Codex" }));
  const html = renderAgentWorkspace(many, options);
  assert.match(html, /Skip to content/);
  assert.match(html, /aria-label="Tasks by workflow state"/);
  assert.match(html, /max-width:720px/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /Runner 99/);
  assert.doesNotMatch(html, /Runner 100/);
});

test("sparse review-only boards use a compact four-state bar and a two-column task grid", () => {
  const reviewOnly = {
    ...structuredClone(snapshot),
    tasks: Array.from({ length: 4 }, (_, index) => ({
      id: `review-${index + 1}`, title: `Review item ${index + 1}`, description: `Long detail ${index + 1}`,
      state: "review", assignee: "client:worker-a", dependsOn: [],
    })),
  };
  const html = renderAgentWorkspace(reviewOnly, options);
  assert.match(html, /class="aw-state-bar" aria-label="Task state counts"/);
  assert.match(html, /href="#aw-state-queued">Queued<span class="aw-count">0/);
  assert.match(html, /id="aw-state-queued">Queued: no tasks reported/);
  assert.match(html, /class="aw-sparse-task-grid"/);
  assert.match(html, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.equal((html.match(/class="aw-task"/g) ?? []).length, 4);
  assert.doesNotMatch(html, /class="aw-column"/);
  assert.match(html, /<details class="aw-task-description"><summary>Description<\/summary>/);
  assert.match(html, /<details class="aw-work-disclosure"><summary>Inbox/);
  assert.match(html, /<details class="aw-work-disclosure"><summary>Activity/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.doesNotMatch(html, /<script\b/i);
});

test("review and artifact controls remain available but closed until selected", () => {
  const reviewOnly = structuredClone(snapshot);
  reviewOnly.tasks = [{ id: "task-r", title: "Review this", description: "Details", state: "review", assignee: "client:worker-a", dependsOn: [] }];
  reviewOnly.artifacts = [{ id: "artifact-r", taskId: "task-r", kind: "text", reference: "artifact ref", title: "Reviewable artifact" }];
  const html = renderAgentWorkspace(reviewOnly, options);
  assert.match(html, /<details class="aw-work-disclosure"><summary>Artifacts &amp; reviews/);
  assert.match(html, /<details class="aw-review-actions"><summary>Review artifact<\/summary>/);
  for (const action of ["review_decide", "artifact_submit", "task_update", "task_create", "participant_upsert", "message_send"]) assert.match(html, new RegExp(`name="action" value="${action}"`));
  assert.match(html, /name="expectedRevision" value="7"/);
  assert.match(html, /name="idempotencyKey" value="[0-9a-f-]{36}"/);
  assert.match(html, /name="_csrf" value="csrf&lt;&amp;"/);
  assert.match(html, /\.aw-description\{[^}]*font-size:12px/);
  assert.match(html, /\.aw-note\{[^}]*font-size:12px/);
  assert.match(html, /\.aw-review-list li,.aw-events li\{[^}]*font-size:12px/);
});
