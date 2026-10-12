import { page } from "./ui.js";
import { esc, adminNav, withCsrf } from "./html.js";
import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { adminEpoch, parseCookies, AdminSessions } from "./admin-session.js";
import { validateJobToolArguments, type JobToolName } from "./job-submit.js";
import { redact } from "./telemetry.js";
import { normalizeSupervisorSnapshot, renderSupervisorDashboard, renderSupervisorEventFeed, renderSupervisorWorkerView } from "./supervisor-ui.js";
import type { StateStore } from "./store.js";
import type { WorkerGuidanceInput, WorkerGuidanceResult } from "./worker-guidance.js";

export interface SupervisorCaller {
  /** OAuth client id; the durable bridge uses this to enforce project ownership. */
  clientId: string;
  projectId: string;
}

export type SupervisorControlAction = "pause_dispatch" | "resume_dispatch" | "emergency_stop" | "set_concurrency";
export interface SupervisorControlInput {
  projectId: string;
  action: SupervisorControlAction;
  expectedRevision: number;
  value?: number;
}

/** Semantic injection seam. A concrete adapter delegates to the durable supervisor bridge. */
export interface SupervisorBackend {
  callTool(name: JobToolName, args: unknown, caller: SupervisorCaller): Promise<unknown>;
  /** Project-scoped authoritative admin snapshot. */
  listProjects?(): string[];
  readAdmin?(projectId: string): Promise<unknown>;
  controlAdmin?(input: SupervisorControlInput): Promise<unknown>;
  readSupervision?(projectId: string, after: number, limit: number): Promise<unknown>;
  acknowledgeSupervision?(projectId: string, eventId: number): Promise<unknown>;
  /** Admin-only one-shot message to a configured existing worker session. */
  guidanceAdmin?(input: WorkerGuidanceInput): Promise<WorkerGuidanceResult>;
}

export class SupervisorUnavailable extends Error {
  constructor() { super("Durable supervisor bridge is not configured"); this.name = "SupervisorUnavailable"; }
}

export class SupervisorApi {
  constructor(private readonly backend?: SupervisorBackend) {}

  get enabled(): boolean { return Boolean(this.backend); }

  async callTool(name: JobToolName, raw: unknown, clientId: string): Promise<unknown> {
    if (!this.backend) throw new SupervisorUnavailable();
    const args = validateJobToolArguments(name, raw) as Record<string, unknown>;
    const projectId = String(args.projectId);
    return this.backend.callTool(name, args, { clientId, projectId });
  }
}

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const severityLevels = new Set(["all", "debug", "info", "notice", "warning", "error", "critical", "unknown"]);

function setSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  const nonce = randomBytes(18).toString("base64");
  res.locals.supervisorNonce = nonce;
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`);
  next();
}

function queryValue(req: Request, key: string, max: number): string {
  const value = req.query[key];
  return typeof value === "string" ? value.slice(0, max) : "";
}

function dashboardOptions(req: Request, nonce: string, csrfToken: string | undefined, feedUrl?: string, projectId?: string) {
  const severity = queryValue(req, "severity", 16).toLowerCase();
  const pause = queryValue(req, "pause", 16);
  return {
    title: projectId ? `Workforce control desk · ${projectId}` : "Workforce control desk",
    search: queryValue(req, "search", 120),
    severity: severityLevels.has(severity) ? severity : "all",
    pause: pause === "paused" || pause === "active" ? pause : "all",
    maxItems: 60,
    nonce,
    csrfToken: csrfToken ?? "",
    liveFeedUrl: feedUrl,
  } as const;
}

function safeAdminSnapshot(value: unknown): { value: unknown; bytes: number } | undefined {
  try {
    const cleaned = redact(value, { maxDepth: 8, maxStringLength: 1200, maxKeys: 80, maxArrayItems: 199 });
    const encoded = JSON.stringify(cleaned);
    if (encoded === undefined) return undefined;
    const bytes = Buffer.byteLength(encoded);
    return bytes <= MAX_SNAPSHOT_BYTES ? { value: cleaned, bytes } : undefined;
  } catch {
    return undefined;
  }
}

export function createSupervisorAdminRouter(store: StateStore, sessions: AdminSessions, backend?: SupervisorBackend) {
  const router = express.Router();
  // This router is mounted before AdminUi, so it owns the security boundary for every route it adds.
  router.use("/admin/api/v1/supervisor", setSecurityHeaders);
  router.use("/admin/supervisor", setSecurityHeaders);

  const adminSession = async (req: Request, res: Response, next: NextFunction) => {
    const state = await store.load();
    const token = parseCookies(req.headers.cookie)["t2o_admin"];
    if (!sessions.valid(token, adminEpoch(state))) return res.status(401).json({ error: "admin_session_required" });
    res.locals.supervisorAdminToken = token;
    res.locals.supervisorCsrf = sessions.csrfToken(token);
    next();
  };
  const requireAdmin = adminSession;
  const requireAdminPage = async (req: Request, res: Response, next: NextFunction) => {
    const state = await store.load();
    res.locals.supervisorBase = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
    const token = parseCookies(req.headers.cookie)["t2o_admin"];
    if (!sessions.valid(token, adminEpoch(state))) {
      const nextPath = req.originalUrl;
      return res.redirect(302, res.locals.supervisorBase + "/admin/login?next=" + encodeURIComponent(nextPath));
    }
    res.locals.supervisorAdminToken = token;
    res.locals.supervisorCsrf = sessions.csrfToken(token);
    next();
  };
  const requireCsrf = (req: Request, res: Response, next: NextFunction) => {
    const token = res.locals.supervisorAdminToken as string | undefined;
    if (!token || !sessions.verifyCsrf(token, req.header("x-csrf-token"))) return res.status(403).json({ error: "csrf_invalid" });
    next();
  };

  async function readSnapshot(projectId: string, res: Response): Promise<unknown | undefined> {
    if (!backend?.readAdmin) {
      res.status(503).json({ error: "supervisor_unavailable" });
      return undefined;
    }
    let snapshot: unknown;
    try { snapshot = await backend.readAdmin(projectId); }
    catch {
      res.status(404).json({ error: "project_unavailable" });
      return undefined;
    }
    const safe = safeAdminSnapshot(snapshot);
    if (!safe) {
      res.status(502).json({ error: "snapshot_unavailable" });
      return undefined;
    }
    return safe.value;
  }

  router.get("/admin/supervisor", requireAdminPage, (_req, res) => {
    const projects = (backend?.listProjects?.() ?? []).filter(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)).slice(0, 50);
    const content = projects.length ? `<ul>${projects.map(id => `<li><a href="./supervisor/${encodeURIComponent(id)}">${esc(id)}</a></li>`).join("")}</ul>` : '<p class="muted">No supervised projects are configured. Configure the private supervisor runtime to connect this view.</p>';
    res.type("html").send(page("Supervisor", withCsrf(`<main class="wrap">${adminNav(res.locals.supervisorBase, "supervisor")}<section class="card full"><h1>Supervised projects</h1>${content}</section></main>`, res.locals.supervisorCsrf ?? "")));
  });

  router.get("/admin/supervisor/:projectId", requireAdminPage, async (req, res) => {
    const projectId = req.params.projectId;
    if (typeof projectId !== "string" || !projectId || projectId.length > 200) return res.status(404).type("html").send("Project unavailable");
    if (!backend?.readAdmin) {
      const html = renderSupervisorDashboard({ state: "error", error: "Supervisor snapshot is unavailable." }, dashboardOptions(req, res.locals.supervisorNonce, res.locals.supervisorCsrf, undefined, projectId));
      return res.status(503).type("html").send(html);
    }
    let raw: unknown;
    try { raw = await backend.readAdmin(projectId); }
    catch {
      const html = renderSupervisorDashboard({ state: "error", error: "Project snapshot is unavailable." }, dashboardOptions(req, res.locals.supervisorNonce, res.locals.supervisorCsrf, undefined, projectId));
      return res.status(404).type("html").send(html);
    }
    const safe = safeAdminSnapshot(raw);
    if (!safe) {
      const html = renderSupervisorDashboard({ state: "error", error: "Snapshot is unavailable or exceeds the display limit." }, dashboardOptions(req, res.locals.supervisorNonce, res.locals.supervisorCsrf, undefined, projectId));
      return res.status(502).type("html").send(html);
    }
    const feedUrl = `${res.locals.supervisorBase}/admin/api/v1/supervisor/${encodeURIComponent(projectId)}/live`;
    const html = renderSupervisorDashboard(normalizeSupervisorSnapshot(safe.value), dashboardOptions(req, res.locals.supervisorNonce, res.locals.supervisorCsrf, feedUrl, projectId));
    return res.type("html").send(html);
  });

  router.get("/admin/api/v1/supervisor/:projectId", requireAdmin, async (req, res) => {
    const projectId = req.params.projectId;
    if (typeof projectId !== "string" || !projectId || projectId.length > 200) return res.status(404).json({ error: "project_unavailable" });
    const snapshot = await readSnapshot(projectId, res);
    if (snapshot === undefined) return;
    return res.json(snapshot);
  });

  router.get("/admin/api/v1/supervisor/:projectId/live", requireAdmin, async (req, res) => {
    const projectId = req.params.projectId;
    if (typeof projectId !== "string" || !projectId || projectId.length > 200) return res.status(404).json({ error: "project_unavailable" });
    const snapshot = await readSnapshot(projectId, res);
    if (snapshot === undefined) return;
    const normalized = normalizeSupervisorSnapshot(snapshot);
    const options = dashboardOptions(req, res.locals.supervisorNonce, res.locals.supervisorCsrf);
    const workers = renderSupervisorWorkerView(normalized.workers);
    return res.json({
      ok: true,
      eventsHtml: renderSupervisorEventFeed(normalized.events ?? [], options),
      workersHtml: workers.html,
      activeWorkers: workers.active,
      attentionWorkers: workers.attention,
      latestHeartbeat: workers.latestHeartbeat,
      supervisor: normalized.supervisor?.status ?? "unknown",
      orchestrator: normalized.orchestrator?.status ?? "unknown",
      observedAt: normalized.observedAt ?? null,
    });
  });

  router.get("/admin/api/v1/supervisor/:projectId/inbox", requireAdmin, async (req, res) => {
    const projectId = req.params.projectId;
    const afterRaw = queryValue(req, "after", 20) || "0";
    const limitRaw = queryValue(req, "limit", 3) || "20";
    if (typeof projectId !== "string" || !projectId || projectId.length > 200) return res.status(404).json({ error: "project_unavailable" });
    if (!/^(?:0|[1-9][0-9]{0,15})$/.test(afterRaw) || !/^(?:[1-9]|1[0-9]|20)$/.test(limitRaw)) return res.status(400).json({ error: "invalid_inbox_query" });
    if (!backend?.readSupervision) return res.status(503).json({ error: "supervisor_unavailable" });
    try {
      const result = safeAdminSnapshot(await backend.readSupervision(projectId, Number(afterRaw), Number(limitRaw)));
      if (!result) return res.status(502).json({ error: "snapshot_unavailable" });
      return res.json(result.value);
    } catch { return res.status(404).json({ error: "project_unavailable" }); }
  });

  router.post("/admin/api/v1/supervisor/:projectId/inbox/:eventId/ack", express.json({ limit: "8kb" }), requireAdmin, requireCsrf, async (req, res) => {
    const projectId = req.params.projectId;
    const rawEventId = req.params.eventId;
    if (typeof projectId !== "string" || !projectId || projectId.length > 200 || typeof rawEventId !== "string" || !/^[1-9][0-9]{0,18}$/.test(rawEventId) || Object.keys(req.body ?? {}).length !== 0) {
      return res.status(400).json({ error: "invalid_supervision_ack" });
    }
    if (!backend?.acknowledgeSupervision) return res.status(503).json({ error: "supervisor_unavailable" });
    try { return res.json(await backend.acknowledgeSupervision(projectId, Number(rawEventId))); }
    catch { return res.status(404).json({ error: "event_unavailable" }); }
  });

  router.post("/admin/api/v1/supervisor/control", express.json({ limit: "16kb" }), requireAdmin, requireCsrf, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (!backend?.controlAdmin) return res.status(503).json({ error: "supervisor_unavailable" });
    const booleanAction = body?.action === "pause_dispatch" || body?.action === "resume_dispatch" || body?.action === "emergency_stop";
    const concurrencyAction = body?.action === "set_concurrency";
    if (!body || Object.keys(body).some((key) => !["projectId", "action", "expectedRevision", "value"].includes(key)) ||
        typeof body.projectId !== "string" || body.projectId.length < 1 || body.projectId.length > 200 || (!booleanAction && !concurrencyAction) || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 ||
        (concurrencyAction && (!Number.isInteger(body.value) || Number(body.value) < 1 || Number(body.value) > 32)) ||
        (booleanAction && body.value !== undefined)) {
      return res.status(400).json({ error: "invalid_control_request" });
    }
    try {
      const result = await backend.controlAdmin({ projectId: body.projectId, action: body.action as SupervisorControlAction,
        expectedRevision: Number(body.expectedRevision), ...(concurrencyAction ? { value: Number(body.value) } : {}) });
      return res.json(result);
    } catch { return res.status(409).json({ error: "control_conflict" }); }
  });

  router.post("/admin/api/v1/supervisor/:projectId/workers/:workerId/guidance", express.json({ limit: "32kb" }), requireAdmin, requireCsrf, async (req, res) => {
    const { projectId, workerId } = req.params;
    const body = req.body as Record<string, unknown>;
    const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
    if (typeof projectId !== "string" || !id(projectId) || typeof workerId !== "string" || !id(workerId) ||
        !body || Object.keys(body).some((key) => !["requestId", "message", "expectedPromptCount", "expectedQuestionId"].includes(key)) ||
        !id(body.requestId) || typeof body.message !== "string" || Buffer.byteLength(body.message, "utf8") < 1 || Buffer.byteLength(body.message, "utf8") > 20_000 ||
        !Number.isSafeInteger(body.expectedPromptCount) || Number(body.expectedPromptCount) < 0 ||
        (body.expectedQuestionId !== undefined && !id(body.expectedQuestionId))) {
      return res.status(400).json({ error: "invalid_worker_guidance" });
    }
    if (!backend?.guidanceAdmin) return res.status(503).json({ error: "worker_guidance_unavailable" });
    try {
      const result = await backend.guidanceAdmin({ projectId, workerId, requestId: body.requestId, message: body.message,
        expectedPromptCount: Number(body.expectedPromptCount), ...(body.expectedQuestionId ? { expectedQuestionId: body.expectedQuestionId as string } : {}) });
      if (result.requestId !== body.requestId || !["accepted", "rejected", "ambiguous"].includes(result.state)) return res.status(502).json({ error: "worker_guidance_result_invalid" });
      const model = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) ? value : undefined;
      const reason = typeof result.reason === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(result.reason) ? result.reason : undefined;
      const safe = { requestId: body.requestId, state: result.state, ...(reason ? { reason } : {}),
        ...(model(result.requestedModel) ? { requestedModel: model(result.requestedModel) } : {}), ...(model(result.reportedModel) ? { reportedModel: model(result.reportedModel) } : {}) };
      const status = result.state === "rejected" && result.reason === "worker_not_registered" ? 404 : result.state === "ambiguous" ? 202 : result.state === "rejected" ? 409 : 200;
      return res.status(status).json(safe);
    } catch {
      return res.status(404).json({ requestId: typeof body.requestId === "string" ? body.requestId : "unknown", state: "rejected", reason: "project_or_worker_unavailable" });
    }
  });
  return router;
}
