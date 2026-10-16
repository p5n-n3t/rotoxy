import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import type { SupervisorBackend } from "./supervisor-api.js";
import type { StateStore } from "./store.js";
import { page } from "./ui.js";
import { esc } from "./html.js";
import { createHash } from "node:crypto";
import { WorkspaceExecutionError, WorkspaceExecutionService, WORKSPACE_EXECUTION_TOOLS, isWorkspaceExecutionToolName, workspaceExecutionRequiredScope, type WorkspaceExecutionToolName } from "./workspace-execution.js";
import { validateJobSubmission, type JobSubmission } from "./job-submit.js";
import { WorkspaceReconciler } from "./workspace-reconciler.js";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_INPUT_BYTES = 32 * 1024;
const TIMEOUT_MS = 10_000;
const PYTHON = "/usr/bin/python3";
const SUPERVISOR_CWD = fileURLToPath(new URL("../supervisor/", import.meta.url));
const ACTIONS = new Set([
  "participant_upsert", "task_create", "task_claim", "task_update", "message_send", "message_ack", "artifact_submit", "review_decide",
]);

export type AgentWorkspaceToolName = "workspace_projects" | "workspace_snapshot" | "workspace_update" | WorkspaceExecutionToolName;
export interface AgentWorkspaceSnapshot {
  projectId: string;
  revision: number;
  participants: unknown[];
  tasks: unknown[];
  messages: unknown[];
  artifacts: unknown[];
  reviews: unknown[];
  events: unknown[];
  nextCursor: number;
  executionSummaries?: unknown[];
}
export interface AgentWorkspaceRenderOptions { projectId: string; base: string; csrf: string; csrfToken: string; projects: string[]; nonce?: string }
export type AgentWorkspaceRenderer = (snapshot: AgentWorkspaceSnapshot, options: AgentWorkspaceRenderOptions) => string;

export interface AgentWorkspaceCommandOptions {
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
}
export type AgentWorkspaceCommandRunner = (
  executable: string,
  args: string[],
  stdin: string,
  options: AgentWorkspaceCommandOptions,
) => Promise<string>;
export interface AgentWorkspaceServiceOptions { runner?: AgentWorkspaceCommandRunner }

export class AgentWorkspaceError extends Error {
  constructor(readonly code: "revision_conflict" | "idempotency_conflict" | "assignee_required" | "independent_reviewer_required" | "task_not_claimable" | "dependencies_incomplete" | "invalid_project" | "project_unavailable" | "invalid_actor" | "invalid_input" | "bridge_unavailable" | "bridge_timeout" | "bridge_output_invalid") {
    super(code); this.name = "AgentWorkspaceError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProjectId(projectId: string): void {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) throw new AgentWorkspaceError("invalid_project");
}

function validateActor(actor: string): void {
  if (actor === "admin:local") return;
  if (typeof actor !== "string" || !actor.startsWith("client:") || !/^[A-Za-z0-9._:-]{1,128}$/.test(actor.slice("client:".length))) {
    throw new AgentWorkspaceError("invalid_actor");
  }
}

function validateUpdateInput(input: Record<string, unknown>): string {
  if (!isRecord(input) || typeof input.action !== "string" || !ACTIONS.has(input.action) ||
      typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128 ||
      /[\r\n\0]/.test(input.idempotencyKey) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 ||
      Object.hasOwn(input, "actor") || Object.hasOwn(input, "projectId")) throw new AgentWorkspaceError("invalid_input");
  let json: string;
  try { json = JSON.stringify(input); } catch { throw new AgentWorkspaceError("invalid_input"); }
  if (Buffer.byteLength(json, "utf8") > MAX_INPUT_BYTES) throw new AgentWorkspaceError("invalid_input");
  return json;
}

async function runPython(executable: string, args: string[], stdin: string, options: AgentWorkspaceCommandOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output ?? "");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new AgentWorkspaceError("bridge_timeout"));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > options.maxStdoutBytes) {
        child.kill("SIGKILL");
        finish(new AgentWorkspaceError("bridge_output_invalid"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.on("error", () => finish(new AgentWorkspaceError("bridge_unavailable")));
    child.on("close", (code) => {
      const output = Buffer.concat(chunks, size).toString("utf8");
      if (code !== 0) {
        try { const failure = JSON.parse(output); if (typeof failure.error === "string" && /^[a-z_]{1,60}$/.test(failure.error)) return finish(new AgentWorkspaceError(["revision_conflict", "idempotency_conflict", "assignee_required", "independent_reviewer_required", "task_not_claimable", "dependencies_incomplete"].includes(failure.error) ? failure.error : "invalid_input")); } catch {}
        return finish(new AgentWorkspaceError("bridge_unavailable"));
      }
      finish(undefined, output);
    });
    child.stdin.on("error", () => finish(new AgentWorkspaceError("bridge_unavailable")));
    child.stdin.end(stdin);
  });
}

export class AgentWorkspaceService {
  private readonly runner: AgentWorkspaceCommandRunner;
  private readonly execution: WorkspaceExecutionService;

  constructor(private readonly store: StateStore, private readonly backend?: SupervisorBackend, options: AgentWorkspaceServiceOptions = {}) {
    this.runner = options.runner ?? runPython;
    this.execution = new WorkspaceExecutionService(store, backend);
  }

  /** Project discovery comes only from the already-configured supervisor backend. */
  async projects(): Promise<string[]> {
    return this.backend?.listProjects?.() ?? [];
  }

  async authorizedProjects(clientId: string): Promise<Array<{ projectId: string }>> {
    validateActor("client:" + clientId);
    const rows = await this.backend?.workspaceProjects?.(clientId) ?? [];
    const result: Array<{ projectId: string }> = [];
    for (const row of rows.slice(0, 100)) {
      if (typeof row.projectId !== "string" || !PROJECT_ID.test(row.projectId)) continue;
      await this.backend?.authorizeWorkspace?.(row.projectId, clientId);
      result.push({ projectId: row.projectId });
    }
    return result;
  }

  createReconciler(intervalMs = 30_000): WorkspaceReconciler {
    return new WorkspaceReconciler({
      ...this.execution.reconciliationCallbacks(({ projectId, jobId, clientId }) => this.sync(projectId, jobId, clientId)),
      intervalMs,
    });
  }

  private async assertConfiguredProject(projectId: string): Promise<void> {
    validateProjectId(projectId);
    if (!(await this.projects()).includes(projectId)) throw new AgentWorkspaceError("project_unavailable");
  }

  private async callPython(payload: Record<string, unknown>): Promise<unknown> {
    const dbPath = resolve(this.store.dir, "agent-workspace.sqlite3");
    const args = ["-m", "snooze.agent_workspace", "--db", dbPath];
    let stdin: string;
    try { stdin = JSON.stringify(payload); } catch { throw new AgentWorkspaceError("invalid_input"); }
    if (Buffer.byteLength(stdin, "utf8") > MAX_INPUT_BYTES + 1024) throw new AgentWorkspaceError("invalid_input");
    let stdout: string;
    try {
      stdout = await this.runner(PYTHON, args, stdin, { cwd: SUPERVISOR_CWD, timeoutMs: TIMEOUT_MS, maxStdoutBytes: MAX_OUTPUT_BYTES });
    } catch (error) {
      if (error instanceof AgentWorkspaceError) throw error;
      throw new AgentWorkspaceError("bridge_unavailable");
    }
    if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) throw new AgentWorkspaceError("bridge_output_invalid");
    try {
      const result: unknown = JSON.parse(stdout);
      if (!isRecord(result)) throw new Error("shape");
      return result;
    } catch { throw new AgentWorkspaceError("bridge_output_invalid"); }
  }

  async snapshot(projectId: string, actor: string, after = 0): Promise<AgentWorkspaceSnapshot> {
    await this.assertConfiguredProject(projectId);
    validateActor(actor);
    if (!Number.isSafeInteger(after) || after < 0) throw new AgentWorkspaceError("invalid_input");
    const result = await this.callPython({ command: "snapshot", projectId, actor, after });
    if (!isRecord(result) || result.projectId !== projectId || !Number.isSafeInteger(result.revision) ||
        !Number.isSafeInteger(result.nextCursor) || !["participants", "tasks", "messages", "artifacts", "reviews", "events"].every((key) => Array.isArray(result[key]))) {
      throw new AgentWorkspaceError("bridge_output_invalid");
    }
    const executionSummaries = await this.execution.summaries(projectId);
    return { ...result, executionResources: await this.backend?.workspaceResources?.(projectId) ?? [], executions: executionSummaries, executionRevision: Math.max(0, ...executionSummaries.map(row => row.updatedAt)), ...(executionSummaries.length ? { executionSummaries } : {}) } as unknown as AgentWorkspaceSnapshot;
  }

  async update(projectId: string, actor: string, input: Record<string, unknown>): Promise<unknown> {
    await this.assertConfiguredProject(projectId);
    validateActor(actor);
    validateUpdateInput(input);
    return this.callPython({ command: "update", projectId, actor, input });
  }

  async dispatch(raw: unknown, clientId: string): Promise<unknown> {
    if (!this.backend?.authorizeWorkspace) throw new WorkspaceExecutionError("supervisor_unavailable");
    const submission = validateJobSubmission(raw);
    await this.backend.authorizeWorkspace(submission.projectId, clientId);
    const result = await this.execution.dispatch(submission, { projectId: submission.projectId, clientId });
    // Replays can race the original submit. Avoid concurrent projection writes;
    // explicit workspace_sync repairs a missing projection after a crash.
    let projectionPending = false;
    if (result.accepted && !result.replayed) {
      await this.backend.authorizeWorkspace(submission.projectId, clientId);
      try { projectionPending = await this.projectSubmission(submission, `client:${clientId}`, [], []); }
      catch { projectionPending = true; }
    }
    return { dispatch: result.dispatch, accepted: result.accepted, replayed: result.replayed, projectionPending, ...(result.providerError ? { providerError: result.providerError } : {}) };
  }

  async sync(projectId: string, jobId: string, clientId: string): Promise<unknown> {
    if (!this.backend?.authorizeWorkspace) throw new WorkspaceExecutionError("supervisor_unavailable");
    await this.backend.authorizeWorkspace(projectId, clientId);
    const result = await this.execution.sync(projectId, jobId, { projectId, clientId });
    const stored = await this.execution.getOwned(projectId, jobId, clientId);
    await this.backend.authorizeWorkspace(projectId, clientId);
    if (stored.actor !== `client:${clientId}`) throw new WorkspaceExecutionError("execution_not_found");
    let projectionPending = false;
    try { projectionPending = await this.projectSubmission(stored.submission, stored.actor, result.results, result.status.tasks); }
    catch { projectionPending = true; }
    return { dispatch: result.dispatch, status: result.status, results: result.results, projectionPending, resultsUnavailable: result.resultsUnavailable, resultsTruncated: result.resultsTruncated, ...(result.resultError ? { resultError: result.resultError } : {}) };
  }

  private async projectSubmission(submission: JobSubmission, actor: string, results: { taskId: string; text: string }[], taskStatuses: { taskId: string; state?: string }[]): Promise<boolean> {
    let snapshot = await this.snapshot(submission.projectId, actor);
    let pending = false;
    // Bind every projected identifier to the verified dispatch author and project.
    // A second OAuth client reusing a public job/task id must not collide with it.
    const projectionKey = createHash("sha256").update(`rotoxy:workspace-projection:v1\0${submission.projectId}\0${actor}\0${submission.jobId}`).digest("hex");
    const projectedTaskId = (taskId: string) => "exec-" + createHash("sha256").update(`${projectionKey}\0${taskId}`).digest("hex").slice(0, 32);
    const apply = async (input: Record<string, unknown>) => {
      await this.update(submission.projectId, actor, { ...input, idempotencyKey: `exec-${createHash("sha256").update(`${projectionKey}:${String(input.action)}:${String(input.taskId ?? input.artifactId ?? "")}`).digest("hex").slice(0, 48)}`, expectedRevision: snapshot.revision });
      snapshot = await this.snapshot(submission.projectId, actor);
    };
    if (!(snapshot.participants as any[]).some(row => row.id === actor)) await apply({ action: "participant_upsert", label: "ROTOXY execution owner", provider: "lightsprint" });
    const taskById = new Map(submission.tasks.map(task => [task.taskId, task]));
    const ordered: typeof submission.tasks = [];
    const visited = new Set<string>();
    const visit = (taskId: string) => { if (visited.has(taskId)) return; visited.add(taskId); for (const dep of taskById.get(taskId)?.dependsOn ?? []) visit(dep); const item = taskById.get(taskId); if (item) ordered.push(item); };
    for (const task of submission.tasks) visit(task.taskId);
    for (const task of ordered) {
      const workspaceTaskId = projectedTaskId(task.taskId);
      let projected = (snapshot.tasks as any[]).find(row => row.id === workspaceTaskId);
      if (!projected) {
        await apply({ action: "task_create", taskId: workspaceTaskId, title: `Published execution · ${task.taskId}`,
          description: `Published task ${task.taskId} from execution ${submission.jobId}. Instructions remain private to the execution owner.`,
          jobId: submission.jobId, externalTaskId: task.taskId,
          dependsOn: task.dependsOn.map(projectedTaskId) });
        projected = (snapshot.tasks as any[]).find(row => row.id === workspaceTaskId);
      }
      const reportedState = taskStatuses.find(row => row.taskId === task.taskId)?.state?.toLowerCase();
      const result = results.find(row => row.taskId === task.taskId);
      if (projected?.state === "queued" && (result || ["reserved", "starting", "running", "awaiting_output", "blocked", "failed", "completed", "complete", "succeeded", "done"].includes(reportedState ?? ""))) {
        // Provider execution dependencies and independent workspace reviews are
        // separate barriers. Keep later artifacts pending until local review
        // prerequisites are satisfied; never forge an approval to import them.
        if (task.dependsOn.some(dep => !(snapshot.tasks as any[]).some(row => row.id === projectedTaskId(dep) && row.state === "complete"))) { pending = true; continue; }
        await apply({ action: "task_claim", taskId: workspaceTaskId });
        projected = (snapshot.tasks as any[]).find(row => row.id === workspaceTaskId);
      }
      if (projected?.state === "running" && ["blocked", "failed"].includes(reportedState ?? "")) {
        await apply({ action: "task_update", taskId: workspaceTaskId, state: "blocked" });
        projected = (snapshot.tasks as any[]).find(row => row.id === workspaceTaskId);
      }
      if (result && projected?.assignee === actor && ["running", "blocked"].includes(projected.state) &&
          !(snapshot.artifacts as any[]).some(row => row.id === `result-${workspaceTaskId}`)) {
        const suffix = "\n[truncated; full output is available only through owner-scoped workspace_sync]";
        const reference = result.text.length > 1000 ? result.text.slice(0, 1000 - suffix.length) + suffix : result.text;
        await apply({ action: "artifact_submit", artifactId: `result-${workspaceTaskId}`, taskId: workspaceTaskId,
          kind: "text", reference: reference || "(empty result)", title: `Execution result · ${task.taskId}` });
      }
      if (projected?.assignee && projected.assignee !== actor && result) pending = true;
      if (!result && ["completed", "complete", "succeeded", "done"].includes(reportedState ?? "") && !["review", "complete"].includes(projected?.state)) pending = true;
    }
    return pending;
  }
}

export interface AgentWorkspaceToolDefinition {
  name: AgentWorkspaceToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

const workspaceText = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const workspaceId = workspaceText(128);
const updateCommon = { idempotencyKey: workspaceId, expectedRevision: { type: "integer", minimum: 0 } };
const updateActions: Record<string, { fields: Record<string, unknown>; required: string[] }> = {
  participant_upsert: { fields: { label: workspaceText(120), provider: workspaceText(80), model: workspaceText(128), accountId: workspaceId }, required: ["label", "provider"] },
  task_create: { fields: { taskId: workspaceId, title: workspaceText(200), description: workspaceText(8000), dependsOn: { type: "array", items: workspaceId, maxItems: 16 }, jobId: workspaceId, externalTaskId: workspaceId }, required: ["taskId", "title", "description"] },
  task_claim: { fields: { taskId: workspaceId }, required: ["taskId"] },
  task_update: { fields: { taskId: workspaceId, state: { enum: ["running", "blocked", "cancelled"] }, note: workspaceText(2000) }, required: ["taskId", "state"] },
  message_send: { fields: { messageId: workspaceId, to: workspaceId, taskId: workspaceId, text: workspaceText(2000) }, required: ["messageId", "to", "text"] },
  message_ack: { fields: { messageId: workspaceId }, required: ["messageId"] },
  artifact_submit: { fields: { artifactId: workspaceId, taskId: workspaceId, kind: { enum: ["text", "branch", "pull_request"] }, reference: workspaceText(1000), title: workspaceText(200) }, required: ["artifactId", "taskId", "kind", "reference", "title"] },
  review_decide: { fields: { artifactId: workspaceId, decision: { enum: ["approved", "changes_requested"] }, note: workspaceText(2000) }, required: ["artifactId", "decision"] },
};
const workspaceUpdateSchema = { oneOf: Object.entries(updateActions).map(([action, contract]) => ({ type: "object", properties: { action: { const: action }, ...updateCommon, ...contract.fields }, required: ["action", "idempotencyKey", "expectedRevision", ...contract.required], additionalProperties: false })) };

export const AW_TOOL_DEFINITIONS: readonly AgentWorkspaceToolDefinition[] = Object.freeze([
  {
    name: "workspace_projects",
    description: "Discover only Agent Workspace projects explicitly authorized for this OAuth client. An empty list means an administrator must grant project access.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "workspace_snapshot",
    description: "Read the bounded project Agent Workspace snapshot and private-to-actor messages.",
    inputSchema: { type: "object", properties: { projectId: { type: "string", minLength: 1, maxLength: 128 }, after: { type: "integer", minimum: 0 } }, required: ["projectId"], additionalProperties: false },
  },
  {
    name: "workspace_update",
    description: "Collaborate through task_create/claim/update, message_send/ack, artifact_submit, review_decide, and participant_upsert. Read snapshot revision first. Actor is verified OAuth client; participant model labels are reported metadata. Review decisions never merge PRs.",
    inputSchema: { type: "object", properties: { projectId: { type: "string", minLength: 1, maxLength: 128 }, input: workspaceUpdateSchema }, required: ["projectId", "input"], additionalProperties: false },
  },
]);
export const ALL_AGENT_WORKSPACE_TOOL_DEFINITIONS = Object.freeze([...AW_TOOL_DEFINITIONS, ...WORKSPACE_EXECUTION_TOOLS]);

export function isAgentWorkspaceToolName(name: unknown): name is AgentWorkspaceToolName {
  return name === "workspace_projects" || name === "workspace_snapshot" || name === "workspace_update" || isWorkspaceExecutionToolName(name);
}

export function awRequiredScope(name: AgentWorkspaceToolName): "jobs:read" | "jobs:write" {
  return name === "workspace_update" || isWorkspaceExecutionToolName(name) && workspaceExecutionRequiredScope(name) === "jobs:write" ? "jobs:write" : "jobs:read";
}

export function validateAgentWorkspaceToolArguments(name: AgentWorkspaceToolName, raw: unknown): Record<string, unknown> {
  if (name === "workspace_projects") {
    if (!isRecord(raw) || Object.keys(raw).length) throw new AgentWorkspaceError("invalid_input");
    return {};
  }
  if (!isRecord(raw) || Object.keys(raw).some((key) => !["projectId", ...(name === "workspace_snapshot" ? ["after"] : ["input"])].includes(key)) || typeof raw.projectId !== "string") {
    throw new AgentWorkspaceError("invalid_input");
  }
  validateProjectId(raw.projectId);
  if (name === "workspace_snapshot") {
    const after = raw.after === undefined ? 0 : raw.after;
    if (!Number.isSafeInteger(after) || Number(after) < 0) throw new AgentWorkspaceError("invalid_input");
    return { projectId: raw.projectId, after };
  }
  if (!isRecord(raw.input)) throw new AgentWorkspaceError("invalid_input");
  validateUpdateInput(raw.input);
  return { projectId: raw.projectId, input: raw.input };
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  const nonce = randomBytes(18).toString("base64");
  res.locals.awNonce = nonce;
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`);
  next();
}

export function createAgentWorkspaceRouter(
  store: StateStore,
  sessions: AdminSessions,
  service: AgentWorkspaceService,
  renderer?: AgentWorkspaceRenderer,
) {
  const router = express.Router();
  router.use("/admin/agents", securityHeaders);
  router.use("/admin/api/v1/agent-workspace", securityHeaders);

  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await store.load();
      const token = parseCookies(req.headers.cookie)["t2o_admin"];
      if (!sessions.valid(token, adminEpoch(state))) return res.status(401).json({ error: "admin_session_required" });
      res.locals.awToken = token;
      res.locals.awCsrf = sessions.csrfToken(token) ?? "";
      res.locals.awState = state;
      res.locals.awBase = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
      next();
    } catch { res.status(503).json({ error: "agent_workspace_unavailable" }); }
  };
  const csrfAndOrigin = (req: Request, res: Response, next: NextFunction) => {
    const token = res.locals.awToken as string | undefined;
    const state = res.locals.awState as Awaited<ReturnType<StateStore["load"]>> | undefined;
    let allowedOrigins: string[] = [];
    try {
      const configuredOrigin = state ? new URL(state.config.publicBaseUrl).origin : "";
      const requestOrigin = req.get("host") ? `${req.protocol}://${req.get("host")}` : "";
      allowedOrigins = [configuredOrigin, requestOrigin].filter(Boolean);
    } catch { /* fail closed */ }
    if (!token || !sessions.verifyCsrf(token, req.get("x-csrf-token") ?? (typeof req.body?._csrf === "string" ? req.body._csrf : undefined)) || !req.get("origin") || !allowedOrigins.includes(req.get("origin")!)) {
      return res.status(403).json({ error: "csrf_or_origin_invalid" });
    }
    next();
  };
  const json = express.json({ limit: "32kb", strict: true });
  const errorResponse = (res: Response, error: unknown) => {
    const code = error instanceof AgentWorkspaceError ? error.code : "agent_workspace_unavailable";
    const status = ["revision_conflict", "idempotency_conflict", "task_not_claimable", "dependencies_incomplete"].includes(code) ? 409 : ["assignee_required", "independent_reviewer_required"].includes(code) ? 403 : code === "invalid_input" || code === "invalid_actor" || code === "invalid_project" ? 400 : code === "project_unavailable" ? 404 : 503;
    return res.status(status).json({ error: code });
  };

  router.get("/admin/agents", async (req, res) => {
    try {
      const state = await store.load();
      const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
      const token = parseCookies(req.headers.cookie)["t2o_admin"];
      if (!sessions.valid(token, adminEpoch(state))) return res.redirect(302, `${base}/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      const csrf = sessions.csrfToken(token) ?? "";
      const projects = await service.projects();
      const selected = typeof req.query.project === "string" ? req.query.project : projects[0] ?? "";
      if (!selected) {
        const body = `<main class="wrap"><h1>Agent Workspace</h1><p>Choose a configured supervisor project to view durable participants, tasks, messages, artifacts, reviews, and events.</p><ul>${projects.map((id) => `<li><a href="${esc(base)}/admin/agents?project=${encodeURIComponent(id)}">${esc(id)}</a></li>`).join("") || "<li>No configured projects.</li>"}</ul></main>`;
        return res.type("html").send(page("Agent Workspace", body));
      }
      if (!PROJECT_ID.test(selected) || !projects.includes(selected)) return res.status(404).type("html").send(page("Agent Workspace", "<main><h1>Project unavailable</h1></main>"));
      const snapshot = await service.snapshot(selected, "admin:local", 0);
      const content = renderer?.(snapshot, { projectId: selected, base, csrf, csrfToken: csrf, projects, nonce: res.locals.awNonce }) ?? `<main class="wrap"><h1>Agent Workspace · ${esc(selected)}</h1><p>Durable workspace data is available. Detailed rendering is not connected yet.</p><pre>${esc(JSON.stringify(snapshot, null, 2))}</pre><p><a href="${esc(base)}/admin/agents">All projects</a></p></main>`;
      return res.type("html").send(renderer ? content : page("Agent Workspace", content));
    } catch (error) { return errorResponse(res, error); }
  });

  router.get("/admin/api/v1/agent-workspace/:projectId", authenticate, async (req, res) => {
    try {
      const projectId = req.params.projectId;
      if (typeof projectId !== "string") throw new AgentWorkspaceError("invalid_project");
      const after = req.query.after === undefined ? 0 : typeof req.query.after === "string" && /^\d{1,16}$/.test(req.query.after) ? Number(req.query.after) : NaN;
      if (!Number.isSafeInteger(after) || after < 0) throw new AgentWorkspaceError("invalid_input");
      return res.json(await service.snapshot(projectId, "admin:local", after));
    } catch (error) { return errorResponse(res, error); }
  });

  router.post("/admin/api/v1/agent-workspace/:projectId/update", authenticate, json, express.urlencoded({ extended: false, limit: "32kb" }), csrfAndOrigin, async (req, res) => {
    try {
      const projectId = req.params.projectId;
      if (typeof projectId !== "string") throw new AgentWorkspaceError("invalid_project");
      const form = req.is("application/x-www-form-urlencoded");
      let input: Record<string, unknown>;
      if (form) {
        if (!isRecord(req.body)) throw new AgentWorkspaceError("invalid_input");
        const { _csrf, ...fields } = req.body;
        input = { ...fields, expectedRevision: /^\d+$/.test(String(fields.expectedRevision)) ? Number(fields.expectedRevision) : NaN };
        if (fields.action === "task_create") {
          input.dependsOn = typeof fields.dependsOn === "string" ? fields.dependsOn.split(",").map(x => x.trim()).filter(Boolean) : [];
          for (const key of ["jobId", "externalTaskId"]) if (input[key] === "") delete input[key];
        }
        for (const key of ["model", "accountId", "taskId", "note"]) if (input[key] === "") delete input[key];
      } else {
        if (!isRecord(req.body) || Object.keys(req.body).some((key) => key !== "input") || !isRecord(req.body.input)) throw new AgentWorkspaceError("invalid_input");
        input = req.body.input;
      }
      const result = await service.update(projectId, "admin:local", input);
      if (form) return res.redirect(303, res.locals.awBase + "/admin/agents?project=" + encodeURIComponent(projectId));
      return res.json(result);
    } catch (error) { return errorResponse(res, error); }
  });

  return router;
}
