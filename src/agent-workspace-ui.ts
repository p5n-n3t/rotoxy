import { randomUUID } from "node:crypto";
import { adminNav, esc, NAV_GROUPS, withCsrf, type NavGroup } from "./html.js";
import { page } from "./ui.js";

export type AgentWorkspaceRenderOptions = { base: string; csrfToken: string; projects: string[]; projectId: string; nonce?: string };

type Participant = { id: string; label: string; provider: string; model?: string; accountId?: string; updatedAt?: string };
type TaskState = "queued" | "running" | "blocked" | "review" | "complete" | "cancelled" | "unknown";
type Task = { id: string; title: string; description: string; state: TaskState; assignee?: string; jobId?: string; externalTaskId?: string; dependsOn: string[]; revision?: number; updatedAt?: string };
type Message = { id: string; from?: string; to: string; taskId?: string; text: string; createdAt?: string };
type Artifact = { id: string; taskId?: string; kind: "text" | "branch" | "pull_request" | "unknown"; reference: string; title: string; submittedBy?: string; submittedAt?: string; state?: string };
type Review = { artifactId: string; reviewer?: string; decision: string; note?: string; createdAt?: string };
type Event = { type: string; actor?: string; taskId?: string; artifactId?: string; createdAt?: string };
type Execution = { jobId: string; state: string; provider: string; taskCount?: number; updatedAt?: string };
type ExecutionResource = { provider: string; sessionId: string; workspaceId: string; accountId: string; accountLabel: string; model: string; source: string; availability: string };
type Workspace = { projectId: string; revision: number; participants: Participant[]; tasks: Task[]; messages: Message[]; artifacts: Artifact[]; reviews: Review[]; events: Event[]; executions: Execution[]; executionsReported: boolean; executionResources: ExecutionResource[]; resourcesReported: boolean };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_STATES = new Set<TaskState>(["queued", "running", "blocked", "review", "complete", "cancelled"]);

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeId(value: unknown): string | undefined { return typeof value === "string" && SAFE_ID.test(value) ? value : undefined; }
function cleanText(value: unknown, max = 2000): string {
  if (typeof value !== "string") return "";
  return value.slice(0, max)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]");
}
function safeDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 8640000000000) return new Date(value < 100000000000 ? value * 1000 : value).toISOString();
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d\d-\d\d(?:T[\d:.+-]+Z?)?$/.test(value)) return undefined;
  return value;
}
function safeArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.slice(0, 100).filter(record) : [];
}
function normalizeWorkspace(raw: unknown, projectId: string): Workspace | undefined {
  if (!record(raw) || raw.projectId !== projectId || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) return undefined;
  const participants: Participant[] = safeArray(raw.participants).flatMap((row) => {
    const id = safeId(row.id), label = cleanText(row.label, 120), provider = cleanText(row.provider, 80);
    if (!id || !label || !provider) return [];
    const model = cleanText(row.model, 100), accountId = safeId(row.accountId), updatedAt = safeDate(row.updatedAt);
    return [{ id, label, provider, ...(model ? { model } : {}), ...(accountId ? { accountId } : {}), ...(updatedAt ? { updatedAt } : {}) }];
  });
  const tasks: Task[] = safeArray(raw.tasks).flatMap((row) => {
    const id = safeId(row.id), title = cleanText(row.title, 200);
    if (!id || !title) return [];
    const rawState = typeof row.state === "string" ? row.state as TaskState : "unknown";
    const state = TASK_STATES.has(rawState) ? rawState : "unknown";
    const assignee = safeId(row.assignee), jobId = safeId(row.jobId), externalTaskId = safeId(row.externalTaskId);
    const dependsOn = Array.isArray(row.dependsOn) ? row.dependsOn.slice(0, 16).flatMap((item) => safeId(item) ?? []) : [];
    const revision = Number.isSafeInteger(row.revision) && Number(row.revision) >= 0 ? Number(row.revision) : undefined;
    const updatedAt = safeDate(row.updatedAt);
    return [{ id, title, description: cleanText(row.description, 8000), state, ...(assignee ? { assignee } : {}), ...(jobId ? { jobId } : {}), ...(externalTaskId ? { externalTaskId } : {}), dependsOn, ...(revision !== undefined ? { revision } : {}), ...(updatedAt ? { updatedAt } : {}) }];
  });
  const messages: Message[] = safeArray(raw.messages).flatMap((row) => {
    const id = safeId(row.id), to = (row.to ?? row.recipient) === "all" ? "all" : safeId(row.to ?? row.recipient), text = cleanText(row.text, 2000);
    if (!id || !to || !text) return [];
    const from = safeId(row.from ?? row.sender), taskId = safeId(row.taskId), createdAt = safeDate(row.createdAt ?? row.at);
    return [{ id, to, text, ...(from ? { from } : {}), ...(taskId ? { taskId } : {}), ...(createdAt ? { createdAt } : {}) }];
  });
  const artifacts: Artifact[] = safeArray(raw.artifacts).flatMap((row) => {
    const id = safeId(row.id), reference = cleanText(row.reference, 500), title = cleanText(row.title, 200);
    if (!id || !reference || !title) return [];
    const kind = row.kind === "text" || row.kind === "branch" || row.kind === "pull_request" ? row.kind : "unknown";
    const taskId = safeId(row.taskId), submittedBy = safeId(row.submittedBy ?? row.submitter), submittedAt = safeDate(row.submittedAt ?? row.createdAt);
    const state = typeof row.state === "string" && /^[a-z_]{1,32}$/.test(row.state) ? row.state : undefined;
    return [{ id, reference, title, kind, ...(taskId ? { taskId } : {}), ...(submittedBy ? { submittedBy } : {}), ...(submittedAt ? { submittedAt } : {}), ...(state ? { state } : {}) }];
  });
  const reviews: Review[] = safeArray(raw.reviews).flatMap((row) => {
    const artifactId = safeId(row.artifactId);
    if (!artifactId) return [];
    const reviewer = safeId(row.reviewer), decision = typeof row.decision === "string" && /^[a-z_]{1,32}$/.test(row.decision) ? row.decision : "unknown";
    const note = cleanText(row.note, 2000), createdAt = safeDate(row.createdAt ?? row.at);
    return [{ artifactId, decision, ...(reviewer ? { reviewer } : {}), ...(note ? { note } : {}), ...(createdAt ? { createdAt } : {}) }];
  });
  const events: Event[] = safeArray(raw.events).flatMap((row) => {
    const rawType = row.type ?? row.kind;
    const type = typeof rawType === "string" && /^[a-z_]{1,48}$/.test(rawType) ? rawType : undefined;
    if (!type) return [];
    const actor = safeId(row.actor), taskId = safeId(row.taskId), artifactId = safeId(row.artifactId), createdAt = safeDate(row.createdAt ?? row.at);
    return [{ type, ...(actor ? { actor } : {}), ...(taskId ? { taskId } : {}), ...(artifactId ? { artifactId } : {}), ...(createdAt ? { createdAt } : {}) }];
  });
  const executions: Execution[] = safeArray(raw.executions).slice(0, 50).map((row) => {
    const taskCount = Number.isSafeInteger(row.taskCount) && Number(row.taskCount) >= 0 && Number(row.taskCount) <= 100000 ? Number(row.taskCount) : undefined;
    const updatedAt = safeDate(row.updatedAt);
    return {
      jobId: cleanText(row.jobId, 128) || "Execution ID unknown",
      state: cleanText(row.state, 48) || "State unknown",
      provider: cleanText(row.provider, 80) || "Provider unknown",
      ...(taskCount !== undefined ? { taskCount } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  });
  const executionResources: ExecutionResource[] = safeArray(raw.executionResources).slice(0, 50).map((row) => ({
    provider: cleanText(row.provider, 80) || "Provider unknown",
    sessionId: cleanText(row.sessionId, 180) || "Session unknown",
    workspaceId: cleanText(row.workspaceId, 180) || "Workspace unknown",
    accountId: cleanText(row.accountId, 128) || "Account unknown",
    accountLabel: cleanText(row.accountLabel, 120) || "Account label unknown",
    model: cleanText(row.model, 120) || "Model unknown",
    source: cleanText(row.modelSource, 120) || cleanText(row.source, 120) || "Source not reported",
    availability: cleanText(row.executionAvailability, 160) || "Availability not reported",
  }));
  return { projectId, revision: Number(raw.revision), participants, tasks, messages, artifacts, reviews, events, executions, executionsReported: Array.isArray(raw.executions), executionResources, resourcesReported: Array.isArray(raw.executionResources) };
}

function workspaceNavigation(): readonly NavGroup[] {
  return NAV_GROUPS.map((group) => {
    if (group.label === "Command") return { ...group, items: group.items.map((item) => item.key === "workspace" ? { key: "agents", label: "Agent workspace", href: "/admin/agents" } : item) };
    
    return group;
  });
}

function actionForm(action: string, endpoint: string, revision: number, contents: string, label: string, secondary = true): string {
  return `<form class="aw-form" method="post" action="${esc(endpoint)}"><input type="hidden" name="action" value="${esc(action)}"><input type="hidden" name="expectedRevision" value="${revision}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}">${contents}<button type="submit"${secondary ? " class=\"secondary\"" : ""}>${esc(label)}</button></form>`;
}
function labelFor(id: string | undefined, byId: Map<string, Participant>): string { return id ? byId.get(id)?.label ?? id : "Unassigned"; }
function field(label: string, name: string, options: { type?: string; value?: string; max?: number; required?: boolean; placeholder?: string } = {}): string {
  const id = `aw-${name}-${randomUUID()}`;
  const common = `id="${id}" name="${esc(name)}" maxlength="${options.max ?? 200}"${options.required ? " required" : ""}${options.placeholder ? ` placeholder="${esc(options.placeholder)}"` : ""}`;
  return `<label for="${id}">${esc(label)}</label>${options.type === "textarea" ? `<textarea ${common} rows="3">${esc(options.value ?? "")}</textarea>` : `<input ${common} type="${esc(options.type ?? "text")}" value="${esc(options.value ?? "")}">`}`;
}
function executionSummary(workspace: Workspace, base: string): string {
  const rows = workspace.executions.map((execution) => `<article class="aw-execution-card"><div><strong>${esc(execution.jobId)}</strong><span class="aw-execution-state">${esc(execution.state)}</span></div><dl><div><dt>Provider</dt><dd>${esc(execution.provider)}</dd></div><div><dt>Tasks</dt><dd>${execution.taskCount === undefined ? "Unknown" : execution.taskCount}</dd></div><div><dt>Updated</dt><dd>${execution.updatedAt ? esc(execution.updatedAt) : "Unknown"}</dd></div></dl></article>`).join("");
  const body = rows || `<p class="aw-empty">${workspace.executionsReported ? "No executions reported in this snapshot." : "Execution rows were not included in this snapshot."}</p>`;
  return `<section class="aw-executions" aria-labelledby="aw-executions-title"><header class="aw-execution-head"><div><p class="eyebrow">Connected work</p><h2 id="aw-executions-title">Job executions <span class="aw-count">${workspace.executionsReported ? workspace.executions.length : "?"}</span></h2></div><nav aria-label="Execution tools"><a href="${esc(base)}/admin/supervisor">Supervisor</a><a href="${esc(base)}/admin/jobs">Jobs</a></nav></header>${body}</section>`;
}
function configuredResources(workspace: Workspace): string {
  const rows = workspace.executionResources.map((resource) => `<li><div class="aw-resource-primary"><strong>${esc(resource.accountLabel)}</strong><span>${esc(resource.accountId)}</span><span>${esc(resource.provider)}</span></div><dl><div><dt>Model</dt><dd>${esc(resource.model)}</dd></div><div><dt>Session</dt><dd>${esc(resource.sessionId)}</dd></div><div><dt>Workspace</dt><dd>${esc(resource.workspaceId)}</dd></div><div><dt>Availability</dt><dd>${esc(resource.availability)}</dd></div><div><dt>Source</dt><dd>${esc(resource.source)}</dd></div></dl></li>`).join("");
  const summary = workspace.resourcesReported ? `Configured LightSprint resources · ${workspace.executionResources.length}` : "Configured LightSprint resources · status unknown";
  const content = rows ? `<ul class="aw-resource-list">${rows}</ul>` : `<p class="aw-empty">${workspace.resourcesReported ? "No configured resources reported." : "Resource configuration was not included in this snapshot."}</p>`;
  return `<details class="aw-resource-disclosure"><summary>${esc(summary)}</summary><p class="aw-note">Configured account sessions are resource metadata; they do not indicate an active worker or verified execution availability.</p>${content}</details>`;
}
function taskCard(task: Task, endpoint: string, workspace: Workspace, byId: Map<string, Participant>): string {
  const state = task.state === "unknown" ? "unknown" : task.state;
  const claim = task.state === "queued" ? actionForm("task_claim", endpoint, workspace.revision, `<input type="hidden" name="taskId" value="${esc(task.id)}">`, "Claim task") : "";
  const update = actionForm("task_update", endpoint, workspace.revision, `<input type="hidden" name="taskId" value="${esc(task.id)}"><label for="state-${esc(task.id)}">Set state</label><select id="state-${esc(task.id)}" name="state"><option value="running">Working</option><option value="blocked">Blocked</option><option value="cancelled">Cancel</option></select>${field("Note (optional)", "note", { max: 2000 })}`, "Update");
  const deliver = actionForm("artifact_submit", endpoint, workspace.revision, `<input type="hidden" name="taskId" value="${esc(task.id)}">${field("Artifact ID", "artifactId", { value: randomUUID(), max: 128, required: true })}${field("Title", "title", { max: 200, required: true })}<label for="kind-${esc(task.id)}">Type</label><select id="kind-${esc(task.id)}" name="kind"><option value="text">Text</option><option value="branch">Branch</option><option value="pull_request">Pull request reference</option></select>${field("Reference", "reference", { max: 500, required: true })}`, "Submit artifact");
  const deps = task.dependsOn.length ? `<div class="aw-detail"><dt>Depends on</dt><dd>${task.dependsOn.map((id) => `<code>${esc(id)}</code>`).join(", ")}</dd></div>` : "";
  return `<article class="aw-task"><div class="aw-task-head"><code>${esc(task.id)}</code><span class="aw-state aw-${esc(state)}">${esc(state.replaceAll("_", " "))}</span></div><h3>${esc(task.title)}</h3>${task.description ? `<details class="aw-task-description"><summary>Task description</summary><p class="aw-description">${esc(task.description)}</p></details>` : ""}<dl class="aw-task-meta"><div class="aw-detail"><dt>Assignee</dt><dd>${esc(labelFor(task.assignee, byId))}</dd></div>${task.jobId ? `<div class="aw-detail"><dt>Job</dt><dd><code>${esc(task.jobId)}</code></dd></div>` : ""}${task.externalTaskId ? `<div class="aw-detail"><dt>External task</dt><dd><code>${esc(task.externalTaskId)}</code></dd></div>` : ""}${deps}</dl><details class="aw-task-actions"><summary>Task actions</summary><div class="aw-actions">${claim}${update}${deliver}</div></details></article>`;
}

function renderBoard(workspace: Workspace, endpoint: string, byId: Map<string, Participant>): string {
  const columns: { id: string; title: string; states: TaskState[] }[] = [
    { id: "queued", title: "Queued", states: ["queued"] },
    { id: "working", title: "Working", states: ["running", "blocked"] },
    { id: "review", title: "Review", states: ["review"] },
    { id: "done", title: "Done", states: ["complete", "cancelled"] },
  ];
  const known = new Set(columns.flatMap((column) => column.states));
  const populated = columns.filter((column) => workspace.tasks.some((task) => column.states.includes(task.state)));
  const sparse = populated.length === 1;
  const columnsHtml = columns.map((column) => {
    const tasks = workspace.tasks.filter((task) => column.states.includes(task.state));
    if (sparse) return tasks.length ? `<section class="aw-sparse-state" id="aw-state-${column.id}" aria-labelledby="aw-heading-${column.id}"><header><h2 id="aw-heading-${column.id}">${column.title}</h2><span class="aw-count">${tasks.length}</span></header><div class="aw-sparse-task-grid">${tasks.map((task) => taskCard(task, endpoint, workspace, byId)).join("")}</div></section>` : "";
    return `<section class="aw-column" aria-labelledby="aw-column-${column.id}"><header><h2 id="aw-column-${column.id}">${column.title}</h2><span class="aw-count">${tasks.length}</span></header><div class="aw-column-body">${tasks.length ? tasks.map((task) => taskCard(task, endpoint, workspace, byId)).join("") : `<p class="aw-empty">No ${column.title.toLowerCase()} tasks reported.</p>`}</div></section>`;
  }).join("");
  const unknown = workspace.tasks.filter((task) => !known.has(task.state));
  const stateBar = sparse ? `<nav class="aw-state-bar" aria-label="Task state counts">${columns.map((column) => { const count = workspace.tasks.filter((task) => column.states.includes(task.state)).length; return `<a href="#aw-state-${column.id}">${column.title}<span class="aw-count">${count}</span></a>`; }).join("")}</nav><div class="aw-empty-destinations">${columns.filter((column) => !populated.includes(column)).map((column) => `<span id="aw-state-${column.id}">${column.title}: no tasks reported</span>`).join("")}</div>` : "";
  return `${stateBar}<section class="${sparse ? "aw-sparse-board" : "aw-board"}" aria-label="Tasks by workflow state">${columnsHtml}</section>${unknown.length ? `<section class="aw-unclassified"><h2>Unclassified state</h2>${unknown.map((task) => taskCard(task, endpoint, workspace, byId)).join("")}</section>` : ""}`;
}

function participantRoster(workspace: Workspace, endpoint: string, byId: Map<string, Participant>): string {
  const rows = workspace.participants.map((person) => `<li><div><strong>${esc(person.label)}</strong><small>${esc(person.id)} · ${esc(person.provider)}${person.model ? ` · ${esc(person.model)} (reported)` : " · Model unknown"}${person.accountId ? ` · Account ${esc(person.accountId)} (reported)` : " · Account unknown"}</small></div>${person.updatedAt ? `<time datetime="${esc(person.updatedAt)}">${esc(person.updatedAt)}</time>` : ""}</li>`).join("");
  const register = actionForm("participant_upsert", endpoint, workspace.revision, `${field("Display label", "label", { max: 120, required: true })}<div class="aw-form-row">${field("Provider", "provider", { max: 80, required: true, placeholder: "codex, claude, or other" })}${field("Model (reported, optional)", "model", { max: 100 })}</div>${field("Account ID (reported, optional)", "accountId", { max: 128 })}`, "Register participant");
  return `<section class="aw-participants" aria-labelledby="aw-participants-title"><header class="aw-section-head"><div><p class="eyebrow">Project collaborators</p><h2 id="aw-participants-title">Participants <span class="aw-count">${workspace.participants.length}</span></h2></div><details class="aw-add-person"><summary>Register participant</summary>${register}</details></header>${rows ? `<ul class="aw-roster">${rows}</ul>` : `<p class="aw-empty">No participants registered yet.</p>`}</section>`;
}

function taskCreate(workspace: Workspace, endpoint: string): string {
  return `<details class="aw-create"><summary>Create task</summary>${actionForm("task_create", endpoint, workspace.revision, `${field("Task ID", "taskId", { value: randomUUID(), max: 128, required: true })}${field("Title", "title", { max: 200, required: true })}${field("Description", "description", { type: "textarea", max: 8000 })}${field("Depends on task IDs (comma separated, up to 16)", "dependsOn", { max: 2200, placeholder: "task-a, task-b" })}${field("Job ID (optional)", "jobId", { max: 128 })}${field("External task ID (optional)", "externalTaskId", { max: 128 })}`, "Create task", false)}</details>`;
}

function inbox(workspace: Workspace, endpoint: string, byId: Map<string, Participant>): string {
  const messages = workspace.messages.map((message) => `<article class="aw-message"><div class="aw-message-head"><strong>${esc(labelFor(message.from, byId))}</strong><span>to ${esc(message.to === "all" ? "all participants" : labelFor(message.to, byId))}</span>${message.taskId ? `<code>${esc(message.taskId)}</code>` : ""}</div><p>${esc(message.text)}</p>${message.createdAt ? `<time datetime="${esc(message.createdAt)}">${esc(message.createdAt)}</time>` : ""}</article>`).join("");
  const recipients = `<label for="aw-message-to">Recipient</label><select id="aw-message-to" name="to"><option value="all">All participants</option>${workspace.participants.map((person) => `<option value="${esc(person.id)}">${esc(person.label)}</option>`).join("")}</select>`;
  const tasks = `<label for="aw-message-task">Task (optional)</label><select id="aw-message-task" name="taskId"><option value="">No task</option>${workspace.tasks.map((task) => `<option value="${esc(task.id)}">${esc(task.title)} · ${esc(task.id)}</option>`).join("")}</select>`;
  const compose = actionForm("message_send", endpoint, workspace.revision, `${field("Message ID", "messageId", { value: randomUUID(), max: 128, required: true })}${recipients}${tasks}${field("Message", "text", { type: "textarea", max: 2000, required: true })}`, "Send message", false);
  return `<section class="aw-panel-grid"><section class="aw-panel-block"><header class="aw-section-head"><div><p class="eyebrow">Project coordination</p><h2>Inbox <span class="aw-count">${workspace.messages.length}</span></h2></div></header>${messages || `<p class="aw-empty">No messages in this project snapshot.</p>`}</section><section class="aw-panel-block"><h2>Send a message</h2><p class="aw-note">Messages are attributed to the authenticated workspace participant.</p>${compose}</section></section>`;
}

function deliverables(workspace: Workspace, endpoint: string, byId: Map<string, Participant>): string {
  const taskById = new Map(workspace.tasks.map((task) => [task.id, task]));
  const reviewByArtifact = new Map(workspace.reviews.map((review) => [review.artifactId, review]));
  const pending = workspace.artifacts.filter((artifact) => taskById.get(artifact.taskId ?? "")?.state === "review" && !reviewByArtifact.has(artifact.id));
  const pendingIds = new Set(pending.map((artifact) => artifact.id));
  const orderedArtifacts = [...workspace.artifacts].sort((left, right) => Number(pendingIds.has(right.id)) - Number(pendingIds.has(left.id)));
  const cards = orderedArtifacts.map((artifact) => {
    const task = taskById.get(artifact.taskId ?? ""), review = reviewByArtifact.get(artifact.id);
    const decision = review ? `<p class="aw-review-state">Workspace review: ${esc(review.decision.replaceAll("_", " "))}${review.reviewer ? ` · ${esc(labelFor(review.reviewer, byId))}` : ""}</p>${review.note ? `<p>${esc(review.note)}</p>` : ""}` : task?.state === "review" ? "<p class=\"aw-review-state\">Pending workspace review</p>" : "";
    const controls = task?.state === "review" && !review ? `<details class="aw-review-actions"><summary>Workspace review</summary><p class="aw-review-note">This records an Agent Workspace decision only. It does not approve a provider request or merge a pull request.</p>${actionForm("review_decide", endpoint, workspace.revision, `<input type="hidden" name="artifactId" value="${esc(artifact.id)}"><label for="decision-${esc(artifact.id)}">Workspace decision</label><select id="decision-${esc(artifact.id)}" name="decision"><option value="approved">Approve in workspace</option><option value="changes_requested">Request changes in workspace</option></select>${field("Review note (optional)", "note", { max: 2000 })}`, "Record workspace review")}</details>` : "";
    return `<article class="aw-artifact"><div class="aw-artifact-head"><span class="aw-state">${esc(artifact.kind.replaceAll("_", " "))}</span><code>${esc(artifact.id)}</code></div><h3>${esc(artifact.title)}</h3><p class="aw-artifact-ref">${esc(artifact.reference)}</p><small>Task ${esc(artifact.taskId ?? "unknown")} · submitted by ${esc(labelFor(artifact.submittedBy, byId))}</small>${decision}${controls}</article>`;
  }).join("");
  const reviews = workspace.reviews.map((review) => `<li><strong>${esc(review.decision.replaceAll("_", " "))}</strong> · artifact ${esc(review.artifactId)}${review.reviewer ? ` · ${esc(labelFor(review.reviewer, byId))}` : ""}${review.note ? `<p>${esc(review.note)}</p>` : ""}</li>`).join("");
  return `<section class="aw-panel-grid"><section class="aw-panel-block"><header class="aw-section-head"><div><p class="eyebrow">Deliverables</p><h2>Artifacts <span class="aw-count">${workspace.artifacts.length}</span></h2></div></header>${cards || `<p class="aw-empty">No artifacts submitted in this project.</p>`}</section><section class="aw-panel-block"><header class="aw-section-head"><div><p class="eyebrow">Review queue</p><h2>Reviews <span class="aw-count">${pending.length}</span></h2></div></header>${pending.length ? `<p class="aw-note">Review actions are checked by the server against task ownership.</p>` : `<p class="aw-empty">No pending reviews reported.</p>`}${reviews ? `<ul class="aw-review-list">${reviews}</ul>` : ""}</section></section>`;
}

function activity(workspace: Workspace, byId: Map<string, Participant>): string {
  const rows = workspace.events.map((event) => `<li><span class="aw-state">${esc(event.type.replaceAll("_", " "))}</span><span>${event.actor ? esc(labelFor(event.actor, byId)) : "Actor unknown"}${event.taskId ? ` · task ${esc(event.taskId)}` : ""}${event.artifactId ? ` · artifact ${esc(event.artifactId)}` : ""}</span>${event.createdAt ? `<time datetime="${esc(event.createdAt)}">${esc(event.createdAt)}</time>` : ""}</li>`).join("");
  return `<section class="aw-panel-block"><header class="aw-section-head"><div><p class="eyebrow">Audit trail</p><h2>Recent activity <span class="aw-count">${workspace.events.length}</span></h2></div></header>${rows ? `<ul class="aw-events">${rows}</ul>` : `<p class="aw-empty">No activity events in this snapshot.</p>`}</section>`;
}


function liveWorkspaceScript(nonce?: string): string {
  if (!nonce || !/^[A-Za-z0-9+/=]{16,80}$/.test(nonce)) return "";
  const code = (() => {
    const root = document.querySelector<HTMLElement>(".aw-page[data-workspace-api]");
    if (!root?.dataset.workspaceApi) return;
    let dirty = false;
    root.addEventListener("input", () => { dirty = true; });
    root.addEventListener("change", () => { dirty = true; });
    const button = root.querySelector<HTMLButtonElement>("[data-refresh-workspace]");
    button?.addEventListener("click", () => location.reload());
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(root.dataset.workspaceApi!, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(7500) });
          if (response.ok) {
            const data = await response.json();
            if ((Number.isSafeInteger(data.revision) && data.revision > Number(root.dataset.workspaceRevision)) ||
                (Number.isSafeInteger(data.executionRevision) && data.executionRevision > Number(root.dataset.executionRevision ?? 0))) {
              if (!dirty && !(document.activeElement instanceof Element && document.activeElement.closest("form"))) { location.reload(); return; }
              if (button) button.hidden = false;
            }
          }
        } catch { /* A transient read failure never mutates work or discards an edit. */ }
      }
      setTimeout(poll, 10000);
    };
    setTimeout(poll, 10000);
  }).toString();
  return '<script nonce="' + esc(nonce) + '">(' + code + ')();</script>';
}

export function renderAgentWorkspace(snapshot: unknown, options: AgentWorkspaceRenderOptions): string {
  const projects = [...new Set(options.projects.filter((project) => typeof project === "string" && SAFE_ID.test(project)))].slice(0, 50);
  const projectId = SAFE_ID.test(options.projectId) && projects.includes(options.projectId) ? options.projectId : "";
  const workspace = projectId ? normalizeWorkspace(snapshot, projectId) : undefined;
  const base = options.base.replace(/\/$/, "");
  const endpoint = projectId ? `${base}/admin/api/v1/agent-workspace/${encodeURIComponent(projectId)}/update` : "";
  const selectedProject = projectId ? `<option value="${esc(projectId)}" selected>${esc(projectId === "token2oauth" ? "ROTOXY" : projectId)}</option>` : "<option value=\"\" selected>Select a project</option>";
  const projectSelect = `<form class="aw-project-select" method="get" action="${esc(base)}/admin/agents"><label for="aw-project">Project</label><select id="aw-project" name="project">${selectedProject}${projects.filter((id) => id !== projectId).map((id) => `<option value="${esc(id)}">${esc(id === "token2oauth" ? "ROTOXY" : id)}</option>`).join("")}</select><button type="submit" class="secondary">Open</button></form>`;
  const bodyContent = workspace ? (() => {
    const byId = new Map(workspace.participants.map((person) => [person.id, person]));
    const counts = `<dl class="aw-metrics"><div><dt>Participants</dt><dd>${workspace.participants.length}</dd></div><div><dt>Tasks</dt><dd>${workspace.tasks.length}</dd></div><div><dt>Messages</dt><dd>${workspace.messages.length}</dd></div><div><dt>Artifacts</dt><dd>${workspace.artifacts.length}</dd></div><div><dt>Revision</dt><dd>${workspace.revision}</dd></div></dl>`;
    return `${counts}${executionSummary(workspace, base)}${configuredResources(workspace)}${participantRoster(workspace, endpoint, byId)}<section class="aw-tasks"><header class="aw-board-head"><div><p class="eyebrow">Project delivery</p><h2>Tasks <span class="aw-count">${workspace.tasks.length}</span></h2><p class="aw-note">Claims and updates are attributed to the signed-in participant. Dependencies and permissions are enforced by the workspace service.</p></div>${taskCreate(workspace, endpoint)}</header>${renderBoard(workspace, endpoint, byId)}</section><section class="aw-workarea" aria-label="Workspace records"><details class="aw-work-disclosure"><summary>Inbox <span class="aw-count">${workspace.messages.length}</span></summary>${inbox(workspace, endpoint, byId)}</details><details class="aw-work-disclosure"><summary>Artifacts &amp; reviews <span class="aw-count">${workspace.artifacts.length}</span></summary>${deliverables(workspace, endpoint, byId)}</details><details class="aw-work-disclosure"><summary>Activity <span class="aw-count">${workspace.events.length}</span></summary>${activity(workspace, byId)}</details></section>`;
  })() : `<section class="aw-empty-project"><p class="eyebrow">Agent workspace</p><h2>${projectId ? "Workspace snapshot unavailable" : "Choose a project"}</h2><p>${projectId ? "The requested project snapshot did not match this page, so no records are shown." : projects.length ? "Select a registered project to open its participants, tasks, messages, and deliverables." : "No supervised projects are registered."}</p></section>`;
  const body = `<main class="wrap aw-page" data-workspace-api="${esc(projectId ? base + "/admin/api/v1/agent-workspace/" + encodeURIComponent(projectId) : "")}" data-workspace-revision="${workspace?.revision ?? 0}" data-execution-revision="${record(snapshot) && Number.isSafeInteger(snapshot.executionRevision) ? snapshot.executionRevision : 0}">${adminNav(base, "agents", workspaceNavigation())}<header class="aw-heading"><div><p class="eyebrow">Collaborative operations</p><h1>Agent workspace</h1><p>Coordinate registered agents through attributed tasks, messages, artifacts, and reviews.</p><p><a href="${esc(base)}/admin/workspace">Resource map</a> · <a href="${esc(base)}/admin/codex">Connect ChatGPT accounts</a> · <a href="${esc(base)}/admin/agents/access">Client access</a></p></div>${projectSelect}</header><button type="button" class="secondary" data-refresh-workspace hidden>New agent updates are available · Refresh</button>${bodyContent}</main><style>.aw-page{max-width:1500px}.aw-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;padding:16px 0 18px;border-bottom:1px solid var(--line)}.aw-heading h1{margin:3px 0;font-size:clamp(27px,3vw,36px)}.aw-heading p:not(.eyebrow){margin:4px 0 0;color:var(--muted);font-size:13px}.aw-project-select{display:grid;grid-template-columns:minmax(160px,260px) auto;gap:6px 9px;align-items:end;min-width:min(360px,100%)}.aw-project-select label{grid-column:1/-1;margin:0}.aw-project-select button{min-height:40px}.aw-page h2{font-size:18px;margin:0}.aw-count{display:inline-grid;min-width:24px;height:24px;place-items:center;border:1px solid var(--line);border-radius:4px;font:600 11px var(--mono);color:var(--muted);vertical-align:middle}.aw-section-head,.aw-board-head{display:flex;align-items:center;justify-content:space-between;gap:14px}.aw-executions{padding:12px 0;border-bottom:1px solid var(--line)}.aw-execution-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.aw-execution-head nav{display:flex;flex-wrap:wrap;gap:7px}.aw-execution-head nav a{padding:5px 8px;border:1px solid var(--line);border-radius:4px;font-size:12px;font-weight:650;text-decoration:none}.aw-execution-card{padding:8px 10px;border:1px solid var(--rule);border-radius:4px;background:var(--surface)}.aw-execution-card>div{display:flex;justify-content:space-between;gap:8px;overflow-wrap:anywhere}.aw-execution-state{font-size:12px;font-weight:650}.aw-execution-card dl,.aw-resource-list dl{display:flex;flex-wrap:wrap;gap:4px 18px;margin:6px 0 0}.aw-execution-card dl div,.aw-resource-list dl div{min-width:90px;max-width:100%;overflow-wrap:anywhere}.aw-execution-card dt,.aw-resource-list dt{color:var(--muted);font:600 11px var(--mono);text-transform:uppercase}.aw-execution-card dd,.aw-resource-list dd{margin:1px 0 0;font-size:12px;overflow-wrap:anywhere}.aw-resource-disclosure{margin-top:8px;border:1px solid var(--line);border-radius:4px;background:var(--surface)}.aw-resource-disclosure>summary{padding:7px 9px;cursor:pointer;font-size:12px;font-weight:650}.aw-resource-disclosure[open]{padding:0 9px 8px}.aw-resource-disclosure[open]>summary{margin:0 -9px 7px;border-bottom:1px solid var(--line)}.aw-resource-list{display:grid;gap:6px;margin:0;padding:0;list-style:none}.aw-resource-list li{padding:7px 0;border-bottom:1px solid var(--rule);overflow-wrap:anywhere}.aw-resource-primary{display:flex;flex-wrap:wrap;gap:5px 12px;align-items:center}.aw-resource-primary span{color:var(--muted);font-size:12px}.aw-review-note{margin:5px 0;color:var(--muted);font-size:12px}.aw-participants{padding:15px 0;border-bottom:1px solid var(--line)}.aw-roster{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:0 14px;padding:0;margin:10px 0 0;list-style:none}.aw-roster li{display:flex;justify-content:space-between;align-items:center;gap:10px;min-width:0;padding:9px 0;border-top:1px solid var(--rule)}.aw-roster li>div{display:grid;min-width:0}.aw-roster strong{font-size:13px}.aw-roster small,.aw-roster time{color:var(--muted);font-size:12px;overflow-wrap:anywhere}.aw-add-person>summary,.aw-create>summary,.aw-task-actions>summary{cursor:pointer;color:var(--signal);font-size:12px;font-weight:650;list-style:none}.aw-add-person>summary::-webkit-details-marker,.aw-create>summary::-webkit-details-marker,.aw-task-actions>summary::-webkit-details-marker{display:none}.aw-add-person[open],.aw-create[open]{width:min(440px,100%)}.aw-form{display:grid;gap:4px;margin-top:9px;padding:11px;background:var(--sunk);border:1px solid var(--line);border-radius:5px}.aw-form label{margin:5px 0 0;font-size:12px}.aw-form input,.aw-form select,.aw-form textarea{font-size:12.5px;min-height:36px;padding:6px 8px}.aw-form textarea{resize:vertical}.aw-form button{justify-self:start;min-height:34px;margin-top:5px;font-size:12px}.aw-form-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.aw-tasks{padding:16px 0;border-bottom:1px solid var(--line)}.aw-board-head{margin-bottom:12px}.aw-board-head .aw-note{max-width:74ch;margin:5px 0 0}.aw-create{flex:0 0 auto}.aw-create[open]{width:min(430px,100%)}.aw-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;align-items:start}.aw-sparse-board{display:block}.aw-state-bar{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:0 0 8px}.aw-state-bar a{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:var(--sunk);font-size:12px;font-weight:650;text-decoration:none}.aw-empty-destinations{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 0 8px;color:var(--muted);font-size:11px}.aw-sparse-state{padding:8px;border:1px solid var(--line);border-radius:5px;background:var(--surface)}.aw-sparse-state>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.aw-sparse-task-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.aw-column{min-width:0;border:1px solid var(--line);border-radius:5px;background:var(--surface)}.aw-column>header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 9px;border-bottom:1px solid var(--line);background:var(--sunk)}.aw-column>header h2{font-size:12px;text-transform:uppercase;letter-spacing:.04em}.aw-column-body{display:grid;align-content:start;gap:8px;max-height:640px;overflow:auto;padding:8px}.aw-task{min-width:0;padding:9px;border:1px solid var(--rule);border-radius:4px;background:var(--paper)}.aw-task-head,.aw-artifact-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.aw-task-head code,.aw-artifact-head code{font-size:12px;overflow-wrap:anywhere}.aw-task h3,.aw-artifact h3{margin:7px 0 4px;font-size:13px;line-height:1.35;overflow-wrap:anywhere}.aw-task-description>summary,.aw-review-actions>summary,.aw-work-disclosure>summary{cursor:pointer;color:var(--signal);font-size:12px;font-weight:650;list-style-position:inside}.aw-description{margin:4px 0 8px;color:var(--muted);font-size:12px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}.aw-state{display:inline-flex;align-items:center;padding:2px 6px;border:1px solid var(--line);border-radius:3px;color:var(--muted);font:600 11px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.03em}.aw-blocked,.aw-cancelled,.aw-unknown{border-color:var(--amber);color:var(--amber);background:var(--amber-soft)}.aw-review,.aw-complete{border-color:var(--signal);color:var(--signal);background:var(--signal-soft)}.aw-task-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;margin:7px 0}.aw-detail{min-width:0}.aw-detail dt{color:var(--muted);font:600 11px var(--mono);text-transform:uppercase}.aw-detail dd{margin:2px 0 0;font-size:12px;overflow-wrap:anywhere}.aw-task-actions{border-top:1px solid var(--rule);padding-top:6px;margin-top:7px}.aw-task-actions[open] .aw-actions{display:grid;gap:6px}.aw-actions .aw-form{padding:7px}.aw-empty{margin:0;padding:10px 6px;color:var(--muted);font-size:12px}.aw-unclassified{padding-top:12px}.aw-workarea{display:grid;gap:7px;padding:12px 0}.aw-work-disclosure{border:1px solid var(--line);border-radius:5px;background:var(--surface)}.aw-work-disclosure>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 11px;color:var(--ink);font-size:13px}.aw-work-disclosure[open]{padding:0 10px 10px}.aw-work-disclosure[open]>summary{margin:0 -10px 8px;border-bottom:1px solid var(--line)}.aw-panel-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(260px,.8fr);gap:14px;align-items:start}.aw-panel-block{min-width:0;padding:12px;border:1px solid var(--line);border-radius:5px;background:var(--surface)}.aw-panel-block h2{margin-bottom:7px}.aw-message,.aw-artifact{padding:9px 0;border-top:1px solid var(--rule);overflow-wrap:anywhere}.aw-message-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px}.aw-message-head span,.aw-message time,.aw-artifact small{color:var(--muted);font-size:12px}.aw-message p,.aw-artifact p{margin:5px 0;font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere}.aw-message time{display:block}.aw-note{margin:4px 0 8px;color:var(--muted);font-size:12px}.aw-artifact-ref{padding:6px;background:var(--sunk);border-radius:3px;font:11px var(--mono);overflow-wrap:anywhere}.aw-artifact .aw-form{margin-top:8px}.aw-review-state{color:var(--amber);font-weight:650}.aw-review-list,.aw-events{margin:8px 0 0;padding:0;list-style:none}.aw-review-list li,.aw-events li{padding:7px 0;border-top:1px solid var(--rule);font-size:12px;overflow-wrap:anywhere}.aw-review-list p{margin:4px 0;color:var(--muted)}.aw-events li{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:9px;align-items:center}.aw-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:0;padding:0;border-top:1px solid var(--line)}.aw-metrics div{padding:8px 5px;border-right:1px solid var(--rule)}.aw-metrics dt{color:var(--muted);font:600 11px var(--mono);text-transform:uppercase}.aw-metrics dd{margin:3px 0 0;font:650 16px var(--mono)}.aw-empty-project{padding:32px 0;color:var(--muted)}.aw-empty-project h2{margin:6px 0;color:var(--ink)}.aw-empty-project p:not(.eyebrow){max-width:60ch;font-size:13px}@media(max-width:1020px){.aw-board{grid-template-columns:repeat(2,minmax(0,1fr))}.aw-column-body{max-height:500px}}@media(max-width:720px){.aw-heading{align-items:stretch;flex-direction:column}.aw-project-select{min-width:0}.aw-board-head{align-items:flex-start;flex-direction:column}.aw-create{width:100%}.aw-create[open]{width:100%}.aw-board{grid-template-columns:1fr}.aw-sparse-task-grid{grid-template-columns:1fr}.aw-state-bar{grid-template-columns:repeat(2,minmax(0,1fr))}.aw-column-body{max-height:none}.aw-panel-grid{grid-template-columns:1fr}.aw-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.aw-events li{grid-template-columns:auto minmax(0,1fr)}.aw-events time{grid-column:2}.aw-form-row{grid-template-columns:1fr}.aw-execution-head{align-items:flex-start;flex-direction:column}.aw-execution-card dl,.aw-resource-list dl{gap:6px 12px}}@media(max-width:390px){.aw-page{padding-inline:12px}.aw-roster{grid-template-columns:1fr}.aw-task-meta{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){.aw-page *, .aw-page *::before,.aw-page *::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}</style>`;
  return withCsrf(page("Agent workspace", body + liveWorkspaceScript(options.nonce)), options.csrfToken);
}
