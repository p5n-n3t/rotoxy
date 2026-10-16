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
  executions: [{ jobId: "job-exec-1", state: "running", provider: "Codex", taskCount: 4, updatedAt: "2026-10-16T10:05:00Z" }],
  executionResources: [{ provider: "lightsprint", sessionId: "session-1", workspaceId: "workspace-1", accountId: "acct-a", accountLabel: "Primary account", model: "gpt-reported", modelSource: "registered configuration", executionAvailability: "not checked by this snapshot" }],
};

test("renders AW records in the shared page shell with real workflow columns and participant attribution", () => {
  const html = renderAgentWorkspace(snapshot, options);
  assert.match(html, /<title>Agent workspace · ROTOXY<\/title>/);
  assert.match(html, /Agent workspace/);
  assert.match(html, /href="\/token2oauth\/admin\/workspace"/);
  for (const column of ["Queued", "Working / blocked", "Review"]) assert.match(html, new RegExp(`>${column}<`));
  assert.match(html, /Completed &amp; cancelled/);
  assert.match(html, /Runner A/);
  assert.match(html, /gpt-reported \(reported\)/);
  assert.match(html, /Account acct-a/);
  assert.match(html, /Blocked task/);
  assert.match(html, /aw-blocked/);
  assert.match(html, /task_claim/);
  assert.match(html, /task_update/);
  assert.match(html, /artifact_submit/);
  assert.match(html, /review_decide/);
  assert.match(html, /message_send/);
  assert.match(html, /task_create/);
  assert.match(html, /participant_upsert/);
  assert.match(html, /Pending workspace review/);
  assert.match(html, /Job executions/);
  assert.match(html, /job-exec-1/);
  assert.match(html, /href="\/token2oauth\/admin\/supervisor"/);
  assert.match(html, /href="\/token2oauth\/admin\/jobs"/);
  assert.match(html, /Configured LightSprint resources · 1/);
  assert.match(html, /<details class="aw-resource-disclosure"><summary>/);
  assert.match(html, /do not indicate an active worker/);
  assert.match(html, /Primary account/);
  assert.match(html, /not checked by this snapshot/);
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
  dirty.executions[0].jobId = '<img src=x onerror="run">';
  dirty.executionResources[0].accountLabel = '<svg onload="run">';
  dirty.executionResources[0].executionAvailability = "access_token=private-resource";
  const html = renderAgentWorkspace(dirty, options);
  assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;/);
  assert.match(html, /access_token=\[redacted\]/);
  assert.match(html, /Bearer \[redacted\]/);
  assert.match(html, /&lt;img src=x onerror=&quot;run&quot;&gt;/);
  assert.match(html, /&lt;svg onload=&quot;run&quot;&gt;/);
  assert.match(html, /access_token=\[redacted\]/);
  assert.doesNotMatch(html, /private-value|hidden-token|private-resource|do-not-render|onerror="bad"|onload="run"/);
});

test("project mismatch and empty snapshots show honest empty states without foreign records", () => {
  const mismatch = renderAgentWorkspace({ ...snapshot, projectId: "project-b" }, options);
  assert.match(mismatch, /Workspace snapshot unavailable/);
  assert.doesNotMatch(mismatch, /Queued task|Runner A/);
  const empty = renderAgentWorkspace({ projectId: "project-a", revision: 0 }, options);
  assert.match(empty, /No participants registered yet/);
  assert.match(empty, /No queued, working, blocked, or review tasks reported/);
  assert.match(empty, /No messages in this project snapshot/);
  assert.match(empty, /No artifacts submitted in this project/);
  assert.match(empty, /Participants<\/dt><dd>0/);
  assert.match(empty, /Execution rows were not included in this snapshot/);
  assert.match(empty, /Resource configuration was not included in this snapshot/);
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
  assert.match(html, /<details class="aw-task-description"><summary>Task description<\/summary>/);
  assert.match(html, /<details class="aw-work-disclosure"><summary>Inbox/);
  assert.match(html, /<details class="aw-work-disclosure"><summary>Activity/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.doesNotMatch(html, /<script\b/i);
});

test("review and artifact controls remain available but closed until selected", () => {
  const reviewOnly = structuredClone(snapshot);
  reviewOnly.tasks = [
    { id: "task-r", title: "Review this", description: "Details", state: "review", assignee: "client:worker-a", dependsOn: [] },
    { id: "task-d", title: "Already complete", description: "Done", state: "complete", dependsOn: [] },
  ];
  reviewOnly.artifacts = [
    { id: "artifact-old", taskId: "task-d", kind: "text", reference: "done ref", title: "Completed artifact" },
    { id: "artifact-r", taskId: "task-r", kind: "text", reference: "artifact ref", title: "Reviewable artifact" },
  ];
  const html = renderAgentWorkspace(reviewOnly, options);
  assert.ok(html.indexOf("artifact-r") < html.indexOf("artifact-old"), "actionable reviews should lead the artifact list");
  assert.match(html, /<details class="aw-work-disclosure"><summary>Artifacts &amp; reviews/);
  assert.match(html, /<details class="aw-review-actions"><summary>Workspace review<\/summary>/);
  assert.match(html, /does not approve a provider request or merge a pull request/);
  for (const action of ["review_decide", "artifact_submit", "task_update", "task_create", "participant_upsert", "message_send"]) assert.match(html, new RegExp(`name="action" value="${action}"`));
  assert.match(html, /name="expectedRevision" value="7"/);
  assert.match(html, /name="idempotencyKey" value="[0-9a-f-]{36}"/);
  assert.match(html, /name="_csrf" value="csrf&lt;&amp;"/);
  assert.match(html, /\.aw-description\{[^}]*font-size:12px/);
  assert.match(html, /\.aw-note\{[^}]*font-size:12px/);
  assert.match(html, /\.aw-review-list li,.aw-events li\{[^}]*font-size:12px/);
});

test("keeps the nonce-protected refresh poll and explicit unknown execution fields", () => {
  const html = renderAgentWorkspace({ ...snapshot, executions: [{}] }, { ...options, nonce: "0123456789abcdef" });
  assert.match(html, /<script nonce="0123456789abcdef">/);
  assert.match(html, /Execution ID unknown/);
  assert.match(html, /State unknown/);
  assert.match(html, /Provider unknown/);
  assert.match(html, /<dt>Tasks<\/dt><dd>Unknown<\/dd>/);
  assert.match(html, /location\.reload\(\)/);
  assert.match(html, /\.closest\("form"\)/);
});

test("bounds optional execution and configured-resource metadata to fifty rows", () => {
  const executions = Array.from({ length: 55 }, (_, index) => ({ jobId: `bounded-job-${index}`, state: "queued", provider: "bridge" }));
  const resources = Array.from({ length: 55 }, (_, index) => ({ sessionId: `bounded-session-${index}`, accountLabel: `Account ${index}` }));
  const html = renderAgentWorkspace({ ...snapshot, executions, executionResources: resources }, options);
  assert.match(html, /bounded-job-49/);
  assert.doesNotMatch(html, /bounded-job-50/);
  assert.match(html, /bounded-session-49/);
  assert.doesNotMatch(html, /bounded-session-50/);
});

test("puts actionable tasks first, archives done work, and keeps secondary records closed", () => {
  const firstScreen = structuredClone(snapshot);
  firstScreen.participants = Array.from({ length: 10 }, (_, index) => ({
    id: index === 0 ? "admin:local" : `client:reviewer-${index}`,
    label: index === 0 ? "Local orchestrator" : `Reviewer ${index}`,
    provider: index === 0 ? "local" : "Codex",
    ...(index === 1 ? { model: "review-model", accountId: "acct-a" } : {}),
  }));
  firstScreen.tasks = [
    ...Array.from({ length: 4 }, (_, index) => ({ id: `review-${index}`, title: `Review ${index}`, description: "Needs collaboration", state: "review", assignee: "client:reviewer-1", dependsOn: [] })),
    ...Array.from({ length: 5 }, (_, index) => ({ id: `complete-${index}`, title: `Complete ${index}`, description: "Archived", state: "complete", dependsOn: [] })),
    { id: "cancelled-1", title: "Cancelled work", description: "Archived", state: "cancelled", dependsOn: [] },
  ];
  firstScreen.executions = [];
  const html = renderAgentWorkspace(firstScreen, options);
  const taskBoard = html.indexOf('<section class="aw-tasks">');
  assert.ok(taskBoard > html.indexOf('class="aw-metrics"'));
  assert.ok(taskBoard < html.indexOf('<details class="aw-archive"'));
  assert.ok(taskBoard < html.indexOf('<details class="aw-participants"'));
  assert.ok(taskBoard < html.indexOf('<details class="aw-resource-disclosure"'));
  assert.ok(taskBoard < html.indexOf('<details class="aw-executions aw-executions-compact"'));
  assert.match(html, /href="#aw-state-done">Done<span class="aw-count">6/);
  assert.match(html, /<details class="aw-archive" id="aw-state-done"><summary>Completed &amp; cancelled · 6/);
  assert.match(html, /<details class="aw-executions aw-executions-compact"><summary>Job executions · 0 reported/);
  assert.match(html, /Codex · review-model \(reported\) · Account acct-a/);
  assert.doesNotMatch(html, /Model unknown|Account unknown/);
  assert.match(html, /\.aw-page \[data-refresh-workspace\]\[hidden\]\{display:none!important\}/);
  assert.match(html, /data-execution-revision=/);
  assert.match(html, /@media\(max-width:390px\)/);
  assert.match(html, /\.aw-task-meta\{grid-template-columns:1fr\}/);
});
