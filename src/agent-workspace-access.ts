import express, { type NextFunction, type Request, type Response } from "express";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc } from "./html.js";
import { page } from "./ui.js";
import { redactString } from "./telemetry.js";
import type { StateStore } from "./store.js";
import type { SupervisorBackend, WorkspaceAccessSnapshot } from "./supervisor-api.js";

const projectLabel = (id: string) => id === "token2oauth" ? "ROTOXY shared workspace" : id;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function headers(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
  next();
}

function render(base: string, csrf: string, snapshot: WorkspaceAccessSnapshot | undefined, selectedProject: string, notice = ""): string {
  const projects = snapshot?.projects ?? [];
  const project = projects.find((item) => item.projectId === selectedProject) ?? projects[0];
  const noticeHtml = notice ? `<p class="notice" role="status">${esc(notice)}</p>` : "";
  const nav = adminNav(base, "agents");
  let content: string;
  if (!snapshot) {
    content = `<section class="card full"><h1>Agent workspace access</h1><p>Workspace access is unavailable because the supervisor backend is not configured.</p></section>`;
  } else if (!project) {
    content = `<section class="card full"><h1>Agent workspace access</h1><p>No supervisor projects are configured. Project access is never granted automatically to new OAuth clients.</p></section>`;
  } else {
    const sharedWorkspace = snapshot.sharedWorkspace?.projectId === project.projectId;
    const accessDescription = sharedWorkspace
      ? "This is the shared ROTOXY provider workspace, not a folder-specific project. Clients with a valid OAuth consent grant automatically access it, subject to token scopes and resource policy. The checkboxes below are legacy explicit grants. Revoking OAuth consent or disabling shared mode prevents new dynamic grants."
      : "Only registered OAuth clients selected here can discover or use this project's Agent Workspace. New clients receive no project access until an administrator grants it.";
    const selector = projects.map((item) => `<a class="project${item.projectId === project.projectId ? " active" : ""}" href="${esc(base)}/admin/agents/access?project=${encodeURIComponent(item.projectId)}">${esc(projectLabel(item.projectId))}</a>`).join("");
    const known = new Map(snapshot.clients.map((client) => [client.clientId, redactString(client.label, 120) || "Unnamed client"]));
    const revoked = project.clientIds.filter((id) => !known.has(id));
    const choices = snapshot.clients.map((client) => `<label class="client"><input type="checkbox" name="clientIds" value="${esc(client.clientId)}"${project.clientIds.includes(client.clientId) ? " checked" : ""}><span><strong>${esc(redactString(client.label, 120) || "Unnamed client")}</strong><code>${esc(client.clientId)}</code></span></label>`).join("");
    const unavailable = revoked.map((id) => `<li><code>${esc(id)}</code> — no longer registered; removed when you save</li>`).join("");
    content = `<section class="card full"><header><p class="eyebrow">Workspace authorization</p><h1>Agent workspace access</h1><p>${esc(accessDescription)}</p></header>${noticeHtml}<nav class="projects" aria-label="Supervisor projects">${selector}</nav><h2>Project: ${esc(projectLabel(project.projectId))}</h2>${snapshot.editable ? `<form method="post" action="${esc(base)}/admin/agents/access"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="expectedRevision" value="${esc(snapshot.revision)}"><input type="hidden" name="projectId" value="${esc(project.projectId)}"><fieldset><legend>Registered OAuth clients</legend><p class="muted">Uncheck a client to revoke its explicit binding; shared OAuth-consented access remains independently governed by shared workspace policy.</p>${choices || "<p>No registered OAuth clients are available.</p>"}${unavailable ? `<ul class="revoked">${unavailable}</ul>` : ""}</fieldset><button type="submit"${snapshot.clients.length ? "" : " disabled"}>Save access</button></form>` : `<p class="notice">This runtime has no safely writable persisted supervisor config. Access is read-only.</p><ul>${project.clientIds.map((id) => `<li><code>${esc(id)}</code></li>`).join("") || "<li>No clients currently have access.</li>"}</ul>`}</section>`;
  }
  return page("Agent workspace access", `<main class="wrap">${nav}${content}</main><style>.full{grid-column:1/-1}.card header{max-width:78ch}.card h1{margin:4px 0 8px;font-size:clamp(26px,4vw,36px)}.card h2{margin:22px 0 10px;font-size:18px}.muted{color:var(--muted)}.projects{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0;padding-bottom:14px;border-bottom:1px solid var(--line)}.project{padding:7px 10px;border:1px solid var(--line);border-radius:4px}.project.active{background:var(--ink);color:var(--paper)}fieldset{border:1px solid var(--line);border-radius:5px;padding:14px;margin:12px 0 18px}.client{display:flex;align-items:center;gap:10px;padding:10px 4px;border-top:1px solid var(--rule);cursor:pointer}.client input{width:auto;min-height:0}.client span{display:grid;gap:3px;min-width:0}.client code,.revoked code{overflow-wrap:anywhere}.revoked{color:var(--muted);font-size:13px}.notice{border-left:3px solid var(--amber);padding:10px;background:var(--amber-soft);overflow-wrap:anywhere}button{margin-top:4px}@media(max-width:520px){.full{padding:16px}.client{align-items:flex-start}.client code{font-size:11px}}</style>`);
}

export function createAgentWorkspaceAccessRouter(store: StateStore, sessions: AdminSessions, backend?: SupervisorBackend) {
  const router = express.Router();
  router.use("/admin/agents/access", headers);
  const form = express.urlencoded({ extended: false, limit: "32kb" });
  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await store.load();
      const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
      const token = parseCookies(req.headers.cookie)["t2o_admin"];
      if (!sessions.valid(token, adminEpoch(state))) {
        if (req.method === "GET") return res.redirect(302, `${base}/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
        return res.status(401).type("text").send("Admin session required");
      }
      res.locals.accessToken = token;
      res.locals.accessCsrf = sessions.csrfToken(token) ?? "";
      res.locals.accessBase = base;
      res.locals.accessOrigin = new URL(state.config.publicBaseUrl).origin;
      next();
    } catch { res.status(503).type("text").send("Workspace access unavailable"); }
  };
  const csrfOrigin = (req: Request, res: Response, next: NextFunction) => {
    const token = res.locals.accessToken as string | undefined;
    const allowed = [res.locals.accessOrigin, `${req.protocol}://${req.get("host")}`];
    const origin = req.get("origin");
    if (!token || !sessions.verifyCsrf(token, req.body?._csrf) || !origin || !allowed.includes(origin)) return res.status(403).type("text").send("Request verification failed");
    next();
  };
  router.get("/admin/agents/access", authenticate, async (req, res) => {
    let snapshot: WorkspaceAccessSnapshot | undefined;
    try { snapshot = await backend?.workspaceAccessAdmin?.(); } catch { /* show generic unavailable state */ }
    const selected = typeof req.query.project === "string" && SAFE_ID.test(req.query.project) ? req.query.project : "";
    res.type("html").send(render(res.locals.accessBase, res.locals.accessCsrf, snapshot, selected, req.query.saved === "1" ? "Project access updated." : ""));
  });
  router.post("/admin/agents/access", authenticate, form, csrfOrigin, async (req, res) => {
    const projectId = req.body?.projectId;
    const expectedRevision = req.body?.expectedRevision;
    const values = req.body?.clientIds === undefined ? [] : Array.isArray(req.body.clientIds) ? req.body.clientIds : [req.body.clientIds];
    if (Object.keys(req.body ?? {}).some((key) => !["_csrf", "projectId", "expectedRevision", "clientIds"].includes(key)) ||
        typeof projectId !== "string" || !SAFE_ID.test(projectId) || typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision) ||
        values.length > 50 || !values.every((value: unknown) => typeof value === "string" && SAFE_ID.test(value))) {
      return res.status(400).type("text").send("Invalid workspace access update");
    }
    try {
      if (!backend?.updateWorkspaceAccessAdmin) throw new Error("unavailable");
      await backend.updateWorkspaceAccessAdmin({ projectId, clientIds: values as string[], expectedRevision });
      return res.redirect(303, `${res.locals.accessBase}/admin/agents/access?project=${encodeURIComponent(projectId)}&saved=1`);
    } catch (error) {
      const message = error instanceof Error && error.message === "workspace_access_conflict" ? "Access changed elsewhere. Reload and review the current membership before saving." : "Access could not be updated. Verify the selected clients and persisted supervisor configuration.";
      let snapshot: WorkspaceAccessSnapshot | undefined;
      try { snapshot = await backend?.workspaceAccessAdmin?.(); } catch { /* generic response */ }
      const code = error instanceof Error && error.message === "workspace_access_conflict" ? 409 : 400;
      return res.status(code).type("html").send(render(res.locals.accessBase, res.locals.accessCsrf, snapshot, projectId, message));
    }
  });
  return router;
}
