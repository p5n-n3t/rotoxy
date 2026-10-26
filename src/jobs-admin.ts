import express, { type NextFunction, type Request, type Response } from "express";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import type { SupervisorBackend } from "./supervisor-api.js";
import { normalizeSupervisorSnapshot, type SupervisorSnapshot } from "./supervisor-ui.js";
import type { StateStore } from "./store.js";
import { redact } from "./telemetry.js";
import { adminNav, NAV_GROUPS, esc, withCsrf, type NavGroup } from "./html.js";
import { isPrimaryFleet } from "./fleet-identity.js";
import { page } from "./ui.js";

const MAX_PROJECTS = 50;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_STATUS = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

type JobRow = { id: string; state: string };
type TaskRow = { id: string; state: string; updatedAt?: string | number };
type ErrorRow = { id: string; state: string; at?: string | number };
type ProjectRow = {
  id: string; state: string; jobs: JobRow[] | null; tasks: TaskRow[] | null; errors: ErrorRow[];
  counts: { jobs: number | null; tasks: number | null; completed: number | null; active: number | null; pending: number | null };
};
type JobsSnapshot = { available: boolean; observedAt: string; projects: ProjectRow[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function status(value: unknown): string {
  return typeof value === "string" && SAFE_STATUS.test(value) ? value.replaceAll("_", " ") : "Not reported";
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ID.test(value) ? value : undefined;
}

function safeTime(value: unknown): string | number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : undefined;
  if (typeof value !== "string" || value.length > 40) return undefined;
  return /^\d{4}-\d\d-\d\d(?:T[\d:.+-]+Z?)?$/.test(value) ? value : undefined;
}

function safeSnapshot(raw: unknown): Record<string, unknown> | undefined {
  try {
    const cleaned = redact(raw, { maxDepth: 8, maxStringLength: 1000, maxKeys: 100, maxArrayItems: 120 });
    if (!isRecord(cleaned)) return undefined;
    const json = JSON.stringify(cleaned);
    return json && Buffer.byteLength(json) <= MAX_SNAPSHOT_BYTES ? cleaned : undefined;
  } catch { return undefined; }
}

function taskCounts(tasks: readonly TaskRow[] | null, reportedActive?: number): { completed: number | null; active: number | null; pending: number | null } {
  if (!tasks) return { completed: null, active: Number.isSafeInteger(reportedActive) && reportedActive! >= 0 ? reportedActive! : null, pending: null };
  let completed = 0, active = 0, pending = 0;
  for (const task of tasks) {
    const s = task.state.toLowerCase().replaceAll(" ", "_");
    if (["completed", "complete", "done", "succeeded", "success"].includes(s)) completed++;
    else if (["active", "running", "executing", "in_progress"].includes(s)) active++;
    else if (["pending", "queued", "scheduled"].includes(s)) pending++;
  }
  return { completed, active, pending };
}

function projectRow(id: string, raw: unknown): ProjectRow {
  const safe = safeSnapshot(raw);
  if (!safe) return { id, state: "Unavailable", jobs: null, tasks: null, errors: [], counts: { jobs: null, tasks: null, completed: null, active: null, pending: null } };
  const snapshot = normalizeSupervisorSnapshot(safe) as SupervisorSnapshot;
  const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs.slice(0, 40).flatMap((job) => {
    const jobId = safeId(job.id);
    return jobId ? [{ id: jobId, state: status(job.status) }] : [];
  }) : null;
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks.slice(0, 80).flatMap((task) => {
    const taskId = safeId(task.id);
    return taskId ? [{ id: taskId, state: status(task.status), ...(safeTime(task.updatedAt) !== undefined ? { updatedAt: safeTime(task.updatedAt) } : {}) }] : [];
  }) : null;
  const rawEvents = Array.isArray(safe.events) ? safe.events : [];
  const errors: ErrorRow[] = rawEvents.slice(0, 120).flatMap((event) => {
    if (!isRecord(event) || !["error", "critical"].includes(String(event.severity ?? event.level).toLowerCase())) return [];
    const eventId = safeId(event.id ?? event.event_id);
    if (!eventId) return [];
    const at = safeTime(event.at ?? event.timestamp ?? event.createdAt ?? event.created_at);
    return [{ id: eventId, state: status(event.severity ?? event.level), ...(at !== undefined ? { at } : {}) }];
  }).slice(0, 20);
  const control = isRecord(safe.projectControl) ? safe.projectControl : undefined;
  const taskSummary = taskCounts(Array.isArray(snapshot.tasks) ? snapshot.tasks.map((task) => ({ id: task.id, state: status(task.status) })) : null,
    typeof control?.activeTaskCount === "number" ? control.activeTaskCount : undefined);
  const state = typeof control?.state === "string" ? status(control.state) : status(snapshot.supervisor?.status ?? snapshot.state);
  return { id, state, jobs, tasks, errors, counts: {
    jobs: jobs === null ? null : Array.isArray(snapshot.jobs) ? snapshot.jobs.length : jobs.length,
    tasks: tasks === null ? null : Array.isArray(snapshot.tasks) ? snapshot.tasks.length : tasks.length,
    ...taskSummary,
  } };
}

async function readJobsSnapshot(backend?: SupervisorBackend): Promise<JobsSnapshot> {
  let ids: string[] = [];
  try { ids = [...new Set((backend?.listProjects?.() ?? []).filter((id) => typeof id === "string" && PROJECT_ID.test(id)))].slice(0, MAX_PROJECTS); }
  catch { return { available: false, observedAt: new Date().toISOString(), projects: [] }; }
  if (!backend?.readAdmin) return { available: false, observedAt: new Date().toISOString(), projects: ids.map((id) => ({ id, state: "Not connected", jobs: null, tasks: null, errors: [], counts: { jobs: null, tasks: null, completed: null, active: null, pending: null } })) };
  const projects: ProjectRow[] = [];
  // Read at most three project snapshots simultaneously; later batches wait for the prior batch.
  for (let offset = 0; offset < ids.length; offset += 3) {
    const rows = await Promise.all(ids.slice(offset, offset + 3).map(async (id) => {
      try { return projectRow(id, await backend.readAdmin!(id)); }
      catch { return { id, state: "Unavailable", jobs: null, tasks: null, errors: [], counts: { jobs: null, tasks: null, completed: null, active: null, pending: null } } as ProjectRow; }
    }));
    projects.push(...rows);
  }
  return { available: true, observedAt: new Date().toISOString(), projects };
}

function jobsNavigation(): readonly NavGroup[] {
  return NAV_GROUPS.map((group) => ({ ...group, items: group.items.map((item) => item.key === "jobs" ? { ...item, href: "/admin/jobs" } : item) }));
}

function count(value: number | null): string { return value === null ? "Not reported" : String(value); }

function renderProject(project: ProjectRow, base: string): string {
  const tasks = project.tasks === null ? "<p class=\"muted\">Task snapshot unavailable.</p>" : project.tasks.length
    ? `<ul>${project.tasks.map((task) => `<li><code>${esc(task.id)}</code> · ${esc(task.state)}${task.updatedAt !== undefined ? ` <span class="muted">· ${esc(typeof task.updatedAt === "number" ? new Date(task.updatedAt).toISOString() : task.updatedAt)}</span>` : ""}</li>`).join("")}</ul>`
    : `<p class="muted">No tasks reported.</p>`;
  const jobs = project.jobs === null ? "<p class=\"muted\">Job snapshot unavailable.</p>" : project.jobs.length
    ? `<ul>${project.jobs.map((job) => `<li><code>${esc(job.id)}</code> · ${esc(job.state)}</li>`).join("")}</ul>`
    : `<p class="muted">No jobs reported.</p>`;
  const errors = project.errors.length ? `<ul>${project.errors.map((event) => `<li><code>${esc(event.id)}</code> · ${esc(event.state)}${event.at !== undefined ? ` · ${esc(event.at)}` : ""}</li>`).join("")}</ul>` : `<p class="muted">No error events reported.</p>`;
  const destination = isPrimaryFleet(project.id) ? `${base}/admin/fleet` : `${base}/admin/supervisor/${encodeURIComponent(project.id)}`;
  return `<tr><th scope="row"><a href="${esc(destination)}">${esc(project.id)}</a><div class="muted">${esc(project.state)}</div></th><td>${count(project.counts.jobs)}</td><td>${count(project.counts.completed)}</td><td>${count(project.counts.active)}</td><td>${count(project.counts.pending)}</td><td>${project.counts.tasks === null ? "Not reported" : esc(project.counts.tasks)} tasks · ${project.errors.length} listed error events</td></tr><tr><td colspan="6"><details><summary>Inspect reported jobs, tasks, and error events for ${esc(project.id)}</summary><div class="jobs-detail"><section><h3>Jobs</h3>${jobs}</section><section><h3>Tasks</h3>${tasks}</section><section><h3>Error events</h3>${errors}</section></div></details></td></tr>`;
}

function renderJobs(snapshot: JobsSnapshot, base: string, csrf: string): string {
  const body = `<main class="wrap jobs-page">${adminNav(base, "jobs", jobsNavigation())}<header class="ops-head"><div><div class="eyebrow">Work queue</div><h1>Jobs</h1><p class="muted">Read-only view of project supervisor snapshots. Queued means reported queued; it does not mean a worker is executing.</p></div><p class="muted">Snapshot ${esc(snapshot.observedAt)} · ${snapshot.projects.length} projects</p></header>${!snapshot.available ? `<p class="flash">Supervisor snapshots are unavailable; project job and task state is not reported.</p>` : ""}<style>.jobs-page{max-width:1280px}.jobs-table{margin-top:18px;overflow-x:auto}.jobs-table table{min-width:760px}.jobs-detail{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;padding:12px 0}.jobs-detail h3{font-size:14px;margin:0 0 6px}.jobs-detail ul{margin:0;padding-left:20px}.jobs-detail li{overflow-wrap:anywhere;margin:4px 0}.jobs-page details summary{cursor:pointer;font-weight:600}.jobs-page .muted{font-size:12px}@media(max-width:700px){.jobs-detail{grid-template-columns:1fr}.jobs-page .ops-head{align-items:flex-start}}</style><section class="jobs-table" aria-label="Project jobs and task summary"><table><thead><tr><th scope="col">Project / state</th><th scope="col">Jobs</th><th scope="col">Completed tasks</th><th scope="col">Active tasks</th><th scope="col">Pending tasks</th><th scope="col">Reported detail</th></tr></thead><tbody>${snapshot.projects.map((project) => renderProject(project, base)).join("") || `<tr><td colspan="6" class="muted">${snapshot.available ? "No supervised projects are configured." : "Project data unavailable."}</td></tr>`}</tbody></table></section></main>`;
  return withCsrf(page("Jobs", body), csrf);
}

export function createJobsAdminRouter(store: StateStore, sessions: AdminSessions, backend?: SupervisorBackend) {
  const router = express.Router();
  const securityHeaders = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
    next();
  };
  router.use("/admin/jobs", securityHeaders);
  router.use("/admin/api/v1/jobs", securityHeaders);
  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const state = await store.load();
    const token = parseCookies(req.headers.cookie)["t2o_admin"];
    if (!sessions.valid(token, adminEpoch(state))) return res.status(401).json({ error: "admin_session_required" });
    res.locals.jobsCsrf = sessions.csrfToken(token) ?? "";
    res.locals.jobsBase = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
    next();
  };
  router.get("/admin/api/v1/jobs", authenticate, async (_req, res) => {
    res.json(await readJobsSnapshot(backend));
  });
  router.get("/admin/jobs", async (req, res, next) => {
    try {
      const state = await store.load();
      const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
      const token = parseCookies(req.headers.cookie)["t2o_admin"];
      if (!sessions.valid(token, adminEpoch(state))) return res.redirect(302, `${base}/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      res.locals.jobsCsrf = sessions.csrfToken(token) ?? "";
      res.locals.jobsBase = base;
      const snapshot = await readJobsSnapshot(backend);
      return res.type("html").send(renderJobs(snapshot, base, res.locals.jobsCsrf));
    } catch (error) { next(error); }
  });
  return router;
}
