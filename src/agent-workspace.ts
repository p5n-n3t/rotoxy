import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import type { SupervisorBackend } from "./supervisor-api.js";
import type { StateStore } from "./store.js";
import { page } from "./ui.js";
import { esc } from "./html.js";

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

export type AgentWorkspaceToolName = "workspace_snapshot" | "workspace_update";
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
}
export interface AgentWorkspaceRenderOptions { projectId: string; base: string; csrf: string; csrfToken: string; projects: string[] }
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
  if (typeof actor !== "string" || !actor.startsWith("client:") || !SAFE_ID.test(actor.slice("client:".length))) {
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

  constructor(private readonly store: StateStore, private readonly backend?: SupervisorBackend, options: AgentWorkspaceServiceOptions = {}) {
    this.runner = options.runner ?? runPython;
  }

  /** Project discovery comes only from the already-configured supervisor backend. */
  async projects(): Promise<string[]> {
    return this.backend?.listProjects?.() ?? [];
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
    return result as unknown as AgentWorkspaceSnapshot;
  }

  async update(projectId: string, actor: string, input: Record<string, unknown>): Promise<unknown> {
    await this.assertConfiguredProject(projectId);
    validateActor(actor);
    validateUpdateInput(input);
    return this.callPython({ command: "update", projectId, actor, input });
  }
}

export interface AgentWorkspaceToolDefinition {
  name: AgentWorkspaceToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const AW_TOOL_DEFINITIONS: readonly AgentWorkspaceToolDefinition[] = Object.freeze([
  {
    name: "workspace_snapshot",
    description: "Read the bounded project Agent Workspace snapshot and private-to-actor messages.",
    inputSchema: { type: "object", properties: { projectId: { type: "string", minLength: 1, maxLength: 128 }, after: { type: "integer", minimum: 0 } }, required: ["projectId"], additionalProperties: false },
  },
  {
    name: "workspace_update",
    description: "Submit one idempotent Agent Workspace task, message, artifact, participant, or review update.",
    inputSchema: { type: "object", properties: { projectId: { type: "string", minLength: 1, maxLength: 128 }, input: { type: "object", required: ["action", "idempotencyKey", "expectedRevision"], additionalProperties: true } }, required: ["projectId", "input"], additionalProperties: false },
  },
]);

export function isAgentWorkspaceToolName(name: unknown): name is AgentWorkspaceToolName {
  return name === "workspace_snapshot" || name === "workspace_update";
}

export function awRequiredScope(name: AgentWorkspaceToolName): "jobs:read" | "jobs:write" {
  return name === "workspace_update" ? "jobs:write" : "jobs:read";
}

export function validateAgentWorkspaceToolArguments(name: AgentWorkspaceToolName, raw: unknown): Record<string, unknown> {
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
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
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
      const content = renderer?.(snapshot, { projectId: selected, base, csrf, csrfToken: csrf, projects }) ?? `<main class="wrap"><h1>Agent Workspace · ${esc(selected)}</h1><p>Durable workspace data is available. Detailed rendering is not connected yet.</p><pre>${esc(JSON.stringify(snapshot, null, 2))}</pre><p><a href="${esc(base)}/admin/agents">All projects</a></p></main>`;
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
