import express, { type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { chmod, lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc, withCsrf } from "./html.js";
import { fleetLabel } from "./fleet-identity.js";
import { LightSprintJobsAdapter } from "./providers/lightsprint-jobs.js";
import { readSupervisorRuntimeConfig, type SupervisorRuntimeConfig } from "./supervisor-runtime.js";
import type { StateStore } from "./store.js";
import type { UpstreamAccount } from "./types.js";
import { page } from "./ui.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const STACK_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
const FRESH_PROVIDERS = ["claude", "codex", "auto", "pi"] as const;
const MAX_CONFIG_BYTES = 64 * 1024;
type VerifiedSession = { accountId: string; workspaceId: string; sessionId: string; reportedModel: string };
type VerifiedFreshBinding = { accountId: string; workspaceId: string; stackId: string; provider: typeof FRESH_PROVIDERS[number] };
type AccountView = { id: string; label: string; enabled: boolean; provider: string };
type BindingView = VerifiedSession & { projectId: string; accountLabel: string };
type FreshBindingView = VerifiedFreshBinding & { projectId: string; accountLabel: string };
type View = { revision: string; editable: boolean; projects: string[]; accounts: AccountView[]; bindings: BindingView[]; freshBindings: FreshBindingView[] };
export type LightSprintSessionVerifier = (accountId: string, sessionId: string) => Promise<VerifiedSession>;
export type LightSprintFreshBindingVerifier = (binding: VerifiedFreshBinding) => Promise<VerifiedFreshBinding>;
export interface LightSprintSessionBindingsOptions { configPath: string; verifySession?: LightSprintSessionVerifier; verifyFreshBinding?: LightSprintFreshBindingVerifier }

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validText(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && value.trim() === value && pattern.test(value); }
function revision(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }
function candidates(value: unknown, keys: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 5 || !object(node)) return;
    for (const [key, item] of Object.entries(node)) {
      if (keys.includes(key) && typeof item === "string" && item.trim() === item && item.length <= 160) found.push(item);
      if (object(item)) visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return [...new Set(found)];
}
function verifiedMetadata(accountId: string, sessionId: string, value: unknown): VerifiedSession {
  const actualIds = candidates(value, ["sessionId", "session_id"]);
  if (!actualIds.length && object(value) && typeof value.id === "string") actualIds.push(value.id);
  const workspaces = candidates(value, ["workspaceId", "workspace_id"]);
  const models = candidates(value, ["reportedModel", "registeredModel", "model"]);
  if (actualIds.length !== 1 || actualIds[0] !== sessionId || workspaces.length !== 1 || !ID.test(workspaces[0]) || models.length !== 1 || !MODEL.test(models[0])) {
    throw new Error("session_metadata_unverified");
  }
  const providerAccountIds = candidates(value, ["accountId", "account_id"]);
  if (providerAccountIds.length > 1 || providerAccountIds.length === 1 && providerAccountIds[0] !== accountId) throw new Error("session_account_mismatch");
  return { accountId, workspaceId: workspaces[0], sessionId, reportedModel: models[0] };
}
function listedStackIds(value: unknown): string[] {
  const source = Array.isArray(value) ? value : object(value) && Array.isArray(value.stacks) ? value.stacks : object(value) && Array.isArray(value.items) ? value.items : object(value) && Array.isArray(value.data) ? value.data : undefined;
  if (!source || source.length > 1000) return [];
  const ids: string[] = [];
  for (const item of source) {
    if (!object(item)) continue;
    const id = typeof item.stackId === "string" ? item.stackId : typeof item.id === "string" ? item.id : typeof item.ref === "string" ? item.ref : undefined;
    if (id && STACK_ID.test(id)) ids.push(id);
  }
  return [...new Set(ids)];
}
function accountsFrom(state: Awaited<ReturnType<StateStore["load"]>>): AccountView[] {
  const native = state.config.upstreamUrl;
  let nativeLightSprint = false;
  try { const actual = new URL(native), expected = new URL("https://app.lightsprint.ai/mcp"); nativeLightSprint = actual.href === expected.href && actual.protocol === "https:" && actual.pathname === "/mcp" && !actual.search && !actual.hash; } catch { /* no native endpoint */ }
  return state.accounts.filter((account) => account.provider === "lightsprint" || account.provider === "generic-bearer-mcp" && nativeLightSprint)
    .map(({ id, label, enabled, provider }) => ({ id, label, enabled, provider }));
}
function accountFor(accounts: readonly UpstreamAccount[], id: string): UpstreamAccount | undefined {
  return accounts.find((item) => item.id === id && item.enabled && (item.provider === "lightsprint" || item.provider === "generic-bearer-mcp"));
}

async function readConfig(configPath: string): Promise<{ raw: string; config: SupervisorRuntimeConfig; revision: string }> {
  const info = await lstat(configPath);
  if (info.isSymbolicLink() || !info.isFile() || typeof process.getuid === "function" && info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > MAX_CONFIG_BYTES) throw new Error("config_unavailable");
  const raw = await readFile(configPath, "utf8");
  return { raw, config: await readSupervisorRuntimeConfig(configPath), revision: revision(raw) };
}

/** Explicit, admin-only binding to a session whose identity is confirmed through its account-pinned status API. */
export function createLightSprintSessionBindingsRouter(store: StateStore, sessions: AdminSessions, options: LightSprintSessionBindingsOptions) {
  if (!isAbsolute(options.configPath) || options.configPath.includes("\0")) throw new Error("invalid_session_bindings_options");
  const router = express.Router();
  const configPath = resolve(options.configPath);
  const verifySession: LightSprintSessionVerifier = options.verifySession ?? (async (accountId, sessionId) => {
    const result = await new LightSprintJobsAdapter(store, accountId, { timeoutMs: 15_000 }).sessionStatus(sessionId);
    if (result.classification !== "accepted") throw new Error("session_status_unavailable");
    return verifiedMetadata(accountId, sessionId, result.value);
  });
  const verifyFreshBinding: LightSprintFreshBindingVerifier = options.verifyFreshBinding ?? (async (binding) => {
    const route = `/api/workspaces/${binding.workspaceId}/stacks`;
    const adapter = new LightSprintJobsAdapter(store, binding.accountId, { timeoutMs: 15_000, trustedWorkspacePermit: (request) =>
      request.accountId === binding.accountId && request.workspaceId === binding.workspaceId && request.method === "GET" && request.path === route && request.body === undefined });
    const contract = await adapter.discoverProvisioningContract();
    if (contract.status !== "documented" || contract.family !== "workspace-task" || contract.workspaceId !== binding.workspaceId) throw new Error("workspace_contract_unverified");
    const stacks = await adapter.listWorkspaceStacks(binding.workspaceId);
    if (stacks.classification !== "accepted") throw new Error("stack_catalog_unavailable");
    if (!listedStackIds(stacks.value).includes(binding.stackId)) throw new Error("stack_unverified");
    return binding;
  });
  router.use(["/admin/lightsprint/sessions", "/admin/api/v1/lightsprint/session-bindings"], async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store, max-age=0"); res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
    try {
      const state = await store.load();
      const token = parseCookies(req.headers.cookie).t2o_admin;
      const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
      if (!sessions.valid(token, adminEpoch(state))) return req.method === "GET" && req.path.startsWith("/admin/lightsprint/sessions")
        ? res.redirect(302, `${base}/admin/login?next=${encodeURIComponent(req.originalUrl)}`)
        : res.status(401).json({ error: "admin_session_required" });
      res.locals.lsSessionToken = token; res.locals.lsSessionCsrf = sessions.csrfToken(token) ?? "";
      res.locals.lsSessionBase = base; res.locals.lsSessionOrigin = new URL(state.config.publicBaseUrl).origin;
      next();
    } catch { res.status(503).type("text").send("Session binding inventory unavailable"); }
  });
  router.use("/admin/lightsprint/sessions", express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 20 }));

  async function view(): Promise<View> {
    const [file, state] = await Promise.all([readConfig(configPath), store.load()]);
    const accounts = accountsFrom(state);
    const labels = new Map(accounts.map((account) => [account.id, account.label]));
    return { revision: file.revision, editable: true, projects: file.config.projects.map((item) => item.projectId), accounts,
      bindings: file.config.projects.flatMap((project) => project.registeredSessions.map((item) => ({ sessionId: item.sessionId, accountId: item.accountId, workspaceId: item.workspaceId, reportedModel: item.model, projectId: project.projectId, accountLabel: labels.get(item.accountId) ?? "Unlisted account" }))),
      freshBindings: file.config.projects.flatMap((project) => (project.freshProvisioningBindings ?? []).map((item) => ({ ...item, projectId: project.projectId, accountLabel: labels.get(item.accountId) ?? "Unlisted account" }))) };
  }
  function render(base: string, csrf: string, data: View, selectedProject: string, message = ""): string {
    const projectId = data.projects.includes(selectedProject) ? selectedProject : data.projects[0] ?? "";
    const accounts = data.accounts.filter((account) => account.enabled);
    const bindings = data.bindings.filter((binding) => binding.projectId === projectId).map((binding) => `<tr><td>${esc(binding.accountLabel)}<br><code>${esc(binding.accountId)}</code></td><td><code>${esc(binding.workspaceId)}</code></td><td><code>${esc(binding.sessionId)}</code></td><td><code>${esc(binding.reportedModel)}</code></td><td><form method="post" action="${esc(base)}/admin/lightsprint/sessions"><input type="hidden" name="action" value="unbind"><input type="hidden" name="expectedRevision" value="${esc(data.revision)}"><input type="hidden" name="projectId" value="${esc(projectId)}"><input type="hidden" name="sessionId" value="${esc(binding.sessionId)}"><button class="secondary">Unbind</button></form></td></tr>`).join("");
    const projectLinks = data.projects.map((id) => `<a class="ls-project${id === projectId ? " active" : ""}" href="${esc(base)}/admin/lightsprint/sessions?project=${encodeURIComponent(id)}">${esc(fleetLabel(id))}</a>`).join("");
    const inventory = data.accounts.map((account) => `<tr><td>${esc(account.label)}</td><td><code>${esc(account.id)}</code></td><td>${esc(account.provider)}</td><td>${account.enabled ? "Enabled" : "Disabled"}</td></tr>`).join("");
    const options = accounts.map((account) => `<option value="${esc(account.id)}">${esc(account.label)} · ${esc(account.id)}</option>`).join("");
    const freshBindings = data.freshBindings.filter((binding) => binding.projectId === projectId).map((binding) => `<tr><td>${esc(binding.accountLabel)}<br><code>${esc(binding.accountId)}</code></td><td><code>${esc(binding.workspaceId)}</code></td><td><code>${esc(binding.stackId)}</code></td><td><code>${esc(binding.provider)}</code></td><td><form method="post" action="${esc(base)}/admin/lightsprint/sessions"><input type="hidden" name="action" value="unbind_fresh"><input type="hidden" name="expectedRevision" value="${esc(data.revision)}"><input type="hidden" name="projectId" value="${esc(projectId)}"><input type="hidden" name="accountId" value="${esc(binding.accountId)}"><input type="hidden" name="provider" value="${esc(binding.provider)}"><button class="secondary">Remove</button></form></td></tr>`).join("");
    const providerOptions = FRESH_PROVIDERS.map((provider) => `<option value="${esc(provider)}">${esc(provider)}</option>`).join("");
    const freshSection = `<section class="card full"><h2>Fresh worker provisioning</h2><p>Each account needs one independently verified workspace and stack before ROTOXY may create a new task on it. Saving performs only account-pinned, read-only contract and stack-catalog checks; it does not launch a worker.</p><div class="ls-table"><table><thead><tr><th>Account</th><th>Workspace</th><th>Stack</th><th>Provider</th><th>Action</th></tr></thead><tbody>${freshBindings || '<tr><td colspan="5">No accounts are enabled for fresh worker creation yet.</td></tr>'}</tbody></table></div>${projectId && options ? `<form method="post" action="${esc(base)}/admin/lightsprint/sessions"><input type="hidden" name="action" value="bind_fresh"><input type="hidden" name="expectedRevision" value="${esc(data.revision)}"><input type="hidden" name="projectId" value="${esc(projectId)}"><label>Enabled LightSprint account<select name="accountId" required>${options}</select></label><label>Verified workspace ID<input name="workspaceId" maxlength="128" required autocomplete="off"></label><label>Verified stack ID<input name="stackId" maxlength="128" required autocomplete="off"></label><label>LightSprint provider<select name="provider" required>${providerOptions}</select></label><button>Verify catalog and enable fresh workers</button></form>` : '<p>No enabled LightSprint accounts or supervisor projects are available.</p>'}<p class="muted">A failed or ambiguous read leaves the supervisor policy unchanged. Model selection remains provider-reported; the documented launch API does not offer an enforceable exact model or effort pin.</p></section>`;
    const body = `<main class="wrap">${adminNav(base, "lightsprint-sessions")}<section class="grid"><section class="card full"><h1>LightSprint bindings</h1><p>Register existing sessions for monitoring, or independently verify an account workspace and stack before fresh worker creation. This page does not create, launch, message, or stop provider sessions, estimate slots, or expose credentials.</p>${message ? `<p class="ls-notice" role="status">${esc(message)}</p>` : ""}<p>Supervisor config revision <code>${esc(data.revision)}</code>. Updates are revision-checked and preserve a private backup. A saved binding becomes dispatchable only after the supervisor reloads its configuration; this page never restarts it.</p></section><section class="card full"><h2>Fleet / task context</h2><nav class="ls-projects" aria-label="Fleet and task contexts">${projectLinks || "No configured projects."}</nav><h2>Existing session bindings · ${esc(projectId ? fleetLabel(projectId) : "No context selected")}</h2><div class="ls-table"><table><thead><tr><th>Account</th><th>Workspace</th><th>Session</th><th>Reported model</th><th>Action</th></tr></thead><tbody>${bindings || '<tr><td colspan="5">No sessions bound to this project.</td></tr>'}</tbody></table></div></section><section class="card full"><h2>Bind an existing session</h2>${projectId && options ? `<form method="post" action="${esc(base)}/admin/lightsprint/sessions"><input type="hidden" name="action" value="bind"><input type="hidden" name="expectedRevision" value="${esc(data.revision)}"><input type="hidden" name="projectId" value="${esc(projectId)}"><label>Enabled LightSprint account<select name="accountId" required>${options}</select></label><label>Workspace ID<input name="workspaceId" maxlength="128" required autocomplete="off"></label><label>Existing session ID<input name="sessionId" maxlength="128" required autocomplete="off"></label><label>Reported model<input name="reportedModel" maxlength="160" required autocomplete="off"></label><button>Verify and bind</button></form>` : '<p>No enabled LightSprint accounts or supervisor projects are available.</p>'}<p class="muted">The submitted values must exactly match a successful read-only session-status response. Ambiguous, missing, or mismatched metadata is rejected.</p></section>${freshSection}<section class="card full"><h2>Known LightSprint account inventory</h2><div class="ls-table"><table><thead><tr><th>Label</th><th>Account ID</th><th>Provider entry</th><th>State</th></tr></thead><tbody>${inventory || '<tr><td colspan="4">No LightSprint accounts are configured.</td></tr>'}</tbody></table></div></section></section></main><style>.ls-projects{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 16px}.ls-project{padding:6px 9px;border:1px solid var(--line);border-radius:4px}.ls-table{max-width:100%;overflow:auto}.ls-table table{width:100%;border-collapse:collapse}.ls-table th,.ls-table td{padding:9px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.ls-table td form{margin:0}.ls-notice{padding:10px;border-left:3px solid var(--signal);background:var(--signal-soft)}.card form label{display:block;margin:10px 0}.card form input,.card form select{display:block;width:100%;max-width:680px;min-width:0}.muted{color:var(--muted)}</style>`;
    return page("LightSprint session bindings", withCsrf(body, csrf));
  }

  router.get("/admin/lightsprint/sessions", async (req, res) => {
    try { const data = await view(); const project = typeof req.query.project === "string" && ID.test(req.query.project) ? req.query.project : ""; return res.type("html").send(render(res.locals.lsSessionBase, res.locals.lsSessionCsrf, data, project, req.query.saved === "1" ? "LightSprint binding updated." : "")); }
    catch { return res.status(503).type("html").send(page("LightSprint bindings", `<main class="wrap">${adminNav(res.locals.lsSessionBase, "lightsprint-sessions")}<section class="card full"><h1>LightSprint bindings</h1><p>Supervisor configuration is unavailable or invalid. No changes were made.</p></section></main>`)); }
  });
  router.get("/admin/api/v1/lightsprint/session-bindings", async (_req, res) => {
    try { return res.json(await view()); } catch { return res.status(503).json({ error: "session_binding_inventory_unavailable" }); }
  });
  router.post("/admin/lightsprint/sessions", async (req, res) => {
    if (req.get("origin") !== res.locals.lsSessionOrigin) return res.status(403).type("text").send("Request origin rejected");
    if (!sessions.verifyCsrf(res.locals.lsSessionToken, req.body?._csrf)) return res.status(403).type("text").send("Request verification failed");
    const body = req.body as Record<string, unknown>;
    const action = body.action;
    const allowed = action === "bind" ? ["_csrf", "action", "expectedRevision", "projectId", "accountId", "workspaceId", "sessionId", "reportedModel"]
      : action === "unbind" ? ["_csrf", "action", "expectedRevision", "projectId", "sessionId"]
        : action === "bind_fresh" ? ["_csrf", "action", "expectedRevision", "projectId", "accountId", "workspaceId", "stackId", "provider"]
          : action === "unbind_fresh" ? ["_csrf", "action", "expectedRevision", "projectId", "accountId", "provider"] : [];
    const isSessionAction = action === "bind" || action === "unbind";
    const isFreshAction = action === "bind_fresh" || action === "unbind_fresh";
    if (!isSessionAction && !isFreshAction || Object.keys(body).some((key) => !allowed.includes(key)) || typeof body.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedRevision) || !validText(body.projectId, ID) ||
        isSessionAction && !validText(body.sessionId, SESSION_ID) ||
        action === "bind" && (!validText(body.accountId, ACCOUNT_ID) || !validText(body.workspaceId, ID) || !validText(body.reportedModel, MODEL)) ||
        action === "bind_fresh" && (!validText(body.accountId, ACCOUNT_ID) || !validText(body.workspaceId, ID) || !validText(body.stackId, STACK_ID) || typeof body.provider !== "string" || !(FRESH_PROVIDERS as readonly string[]).includes(body.provider)) ||
        action === "unbind_fresh" && (!validText(body.accountId, ACCOUNT_ID) || typeof body.provider !== "string" || !(FRESH_PROVIDERS as readonly string[]).includes(body.provider))) return res.status(400).type("text").send("Invalid LightSprint binding request");
    let lock;
    const lockPath = `${configPath}.access.lock`, tempPath = `${configPath}.binding.tmp.${process.pid}.${Date.now()}`, backupPath = `${configPath}.bak`, backupTemp = `${backupPath}.binding.tmp.${process.pid}.${Date.now()}`;
    try {
      lock = await open(lockPath, "wx", 0o600);
      const current = await readConfig(configPath);
      if (current.revision !== body.expectedRevision) throw new Error("revision_conflict");
      const state = await store.load();
      const raw = JSON.parse(current.raw) as Record<string, unknown>;
      const projects = raw.projects as Array<Record<string, unknown>>;
      const project = projects.find((item) => item.projectId === body.projectId);
      if (!project || !Array.isArray(project.accountIds) || !Array.isArray(project.registeredSessions) || project.freshProvisioningBindings !== undefined && !Array.isArray(project.freshProvisioningBindings)) throw new Error("project_unavailable");
      const registeredSessions = project.registeredSessions as unknown[];
      if (action === "bind") {
        const account = accountsFrom(state).some((item) => item.id === body.accountId && item.enabled) ? accountFor(state.accounts, body.accountId as string) : undefined;
        if (!account) throw new Error("account_unavailable");
        const verified = await verifySession(account.id, body.sessionId as string);
        if (verified.accountId !== account.id || verified.sessionId !== body.sessionId || verified.workspaceId !== body.workspaceId || verified.reportedModel !== body.reportedModel) throw new Error("session_metadata_mismatch");
        const owner = projects.find((candidate) => Array.isArray(candidate.registeredSessions) && (candidate.registeredSessions as unknown[]).some((item) => object(item) && item.sessionId === verified.sessionId));
        if (owner) throw new Error("session_already_bound");
        if (project.accountIds.length >= 50 && !project.accountIds.includes(account.id)) throw new Error("project_account_limit");
        if (registeredSessions.length >= 100) throw new Error("project_session_limit");
        if (!project.accountIds.includes(account.id)) project.accountIds.push(account.id);
        registeredSessions.push({ sessionId: verified.sessionId, accountId: verified.accountId, workspaceId: verified.workspaceId, model: verified.reportedModel });
      } else if (action === "unbind") {
        const before = registeredSessions.length;
        project.registeredSessions = registeredSessions.filter((item) => !object(item) || item.sessionId !== body.sessionId);
        if (before === (project.registeredSessions as unknown[]).length) throw new Error("binding_not_found");
      } else if (action === "bind_fresh") {
        const account = accountsFrom(state).some((item) => item.id === body.accountId && item.enabled) ? accountFor(state.accounts, body.accountId as string) : undefined;
        if (!account) throw new Error("account_unavailable");
        const requested: VerifiedFreshBinding = { accountId: account.id, workspaceId: body.workspaceId as string, stackId: body.stackId as string, provider: body.provider as VerifiedFreshBinding["provider"] };
        const verified = await verifyFreshBinding(requested);
        if (verified.accountId !== requested.accountId || verified.workspaceId !== requested.workspaceId || verified.stackId !== requested.stackId || verified.provider !== requested.provider) throw new Error("fresh_binding_mismatch");
        const bindings = project.freshProvisioningBindings ?? [];
        if (bindings.some((item) => !object(item)) || bindings.some((item) => object(item) && item.accountId === account.id && item.provider === requested.provider)) throw new Error("fresh_binding_exists");
        if (bindings.length >= 50 || project.accountIds.length >= 50 && !project.accountIds.includes(account.id)) throw new Error("project_account_limit");
        if (!project.accountIds.includes(account.id)) project.accountIds.push(account.id);
        bindings.push({ accountId: verified.accountId, workspaceId: verified.workspaceId, stackId: verified.stackId, provider: verified.provider });
        project.freshProvisioningBindings = bindings;
      } else {
        const bindings = project.freshProvisioningBindings ?? [];
        const next = bindings.filter((item) => !object(item) || item.accountId !== body.accountId || item.provider !== body.provider);
        if (next.length === bindings.length) throw new Error("fresh_binding_not_found");
        project.freshProvisioningBindings = next;
      }
      const nextRaw = JSON.stringify(raw, null, 2) + "\n";
      if (Buffer.byteLength(nextRaw) > MAX_CONFIG_BYTES) throw new Error("config_limit");
      await writeFile(tempPath, nextRaw, { flag: "wx", mode: 0o600 }); await chmod(tempPath, 0o600);
      await readSupervisorRuntimeConfig(tempPath);
      await writeFile(backupTemp, current.raw, { flag: "wx", mode: 0o600 }); await chmod(backupTemp, 0o600);
      await rename(backupTemp, backupPath); await chmod(backupPath, 0o600);
      await rename(tempPath, configPath); await chmod(configPath, 0o600);
      return res.redirect(303, `${res.locals.lsSessionBase}/admin/lightsprint/sessions?project=${encodeURIComponent(body.projectId as string)}&saved=1`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "update_failed";
      const safe = new Set(["revision_conflict", "project_unavailable", "account_unavailable", "session_status_unavailable", "session_metadata_unverified", "session_account_mismatch", "session_metadata_mismatch", "session_already_bound", "project_account_limit", "project_session_limit", "binding_not_found", "workspace_contract_unverified", "stack_catalog_unavailable", "stack_unverified", "fresh_binding_mismatch", "fresh_binding_exists", "fresh_binding_not_found", "config_limit"]);
      const status = message === "revision_conflict" ? 409 : 400;
      return res.status(status).type("text").send(safe.has(message) ? message : "lightsprint_binding_update_failed");
    } finally {
      await unlink(tempPath).catch(() => undefined); await unlink(backupTemp).catch(() => undefined);
      if (lock) { await lock.close().catch(() => undefined); await unlink(lockPath).catch(() => undefined); }
    }
  });
  return { router };
}

