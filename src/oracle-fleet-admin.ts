import express from "express";
import { spawn } from "node:child_process";
import { isAbsolute, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc, NAV_GROUPS, withCsrf, type NavGroup } from "./html.js";
import { runtimeStatePath } from "./supervisor-runtime.js";
import type { StateStore } from "./store.js";
import { page } from "./ui.js";

const PYTHON = "/usr/bin/python3";
const MAX_OUTPUT = 32 * 1024;
const MAX_TIMEOUT = 5_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,159}$/;
const REVISION = /^[A-Za-z0-9_-]{24}$/;

export interface OracleFleetCommandRequest { cwd: string; timeoutMs: number; maxOutputBytes: number; signal: AbortSignal }
export type OracleFleetCommandRunner = (command: string, args: string[], request: OracleFleetCommandRequest, input: string) => Promise<string>;
export interface OracleFleetAdminOptions {
  /** Trusted runtime path supplied by the server; never taken from a request. */
  configPath?: string;
  /** Trusted packaged supervisor directory. */
  supervisorCwd?: string;
  commandRunner?: OracleFleetCommandRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
type FleetHost = { id: string; ip: string; ssh_host: string; enabled: boolean; allowedModels: string[] };
type FleetView = { revision: string; version: 1 | 2; default_model: string; hosts: FleetHost[] };

function defaultRunner(command: string, args: string[], request: OracleFleetCommandRequest, input: string): Promise<string> {
  if (command !== PYTHON) return Promise.reject(new Error("command_not_allowed"));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: request.cwd, stdio: ["pipe", "pipe", "ignore"], shell: false, signal: request.signal });
    const chunks: Buffer[] = [];
    let size = 0, oversized = false;
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (oversized) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > request.maxOutputBytes) { oversized = true; child.kill("SIGKILL"); return; }
      chunks.push(bytes);
    });
    child.on("error", () => reject(new Error("fleet_config_unavailable")));
    child.on("close", (code) => {
      if (oversized || code !== 0) return reject(new Error(oversized ? "fleet_output_too_large" : "fleet_config_unavailable"));
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validateView(value: unknown): FleetView {
  if (!isRecord(value) || typeof value.revision !== "string" || !REVISION.test(value.revision) ||
      (value.version !== 1 && value.version !== 2) || typeof value.default_model !== "string" || !MODEL.test(value.default_model) ||
      !Array.isArray(value.hosts) || value.hosts.length < 1 || value.hosts.length > 32) throw new Error("invalid_fleet_response");
  const seen = new Set<string>();
  const hosts: FleetHost[] = [];
  for (const item of value.hosts) {
    if (!isRecord(item) || typeof item.id !== "string" || !ID.test(item.id) || seen.has(item.id) ||
        typeof item.ip !== "string" || item.ip.length > 45 || typeof item.ssh_host !== "string" || item.ssh_host.length > 253 ||
        typeof item.enabled !== "boolean" || !Array.isArray(item.allowedModels) || item.allowedModels.length > 64 ||
        item.allowedModels.some((model) => typeof model !== "string" || !MODEL.test(model))) throw new Error("invalid_fleet_response");
    seen.add(item.id);
    hosts.push({ id: item.id, ip: item.ip, ssh_host: item.ssh_host, enabled: item.enabled, allowedModels: item.allowedModels as string[] });
  }
  return { revision: value.revision, version: value.version, default_model: value.default_model, hosts };
}

function parseHost(body: Record<string, unknown>): FleetHost {
  const id = body.id, ip = body.ip, alias = body.ssh_host, enabled = body.enabled === "1";
  const rawModels = body.allowedModels;
  if (typeof id !== "string" || !ID.test(id) || typeof ip !== "string" || ip.length > 45 ||
      typeof alias !== "string" || alias.length > 253 || typeof rawModels !== "string" || Buffer.byteLength(rawModels) > 8192) throw new Error("invalid_host");
  const models = rawModels.split(/[\r\n,]+/).map((model) => model.trim()).filter(Boolean);
  if (models.length > 64 || models.some((model) => !MODEL.test(model))) throw new Error("invalid_host");
  return { id, ip, ssh_host: alias, enabled, allowedModels: models };
}

function form(base: string, action: string, revision: string, host?: FleetHost, targetId?: string): string {
  const hidden = `<input type="hidden" name="action" value="${esc(action)}"><input type="hidden" name="revision" value="${esc(revision)}">${targetId === undefined ? "" : `<input type="hidden" name="targetId" value="${esc(targetId)}">`}`;
  if (action === "remove") return `<form method="post" action="${esc(base)}/admin/oracle/fleet" class="inline">${hidden}<button class="secondary" type="submit">Remove from registry</button></form>`;
  const current = host;
  return `<form method="post" action="${esc(base)}/admin/oracle/fleet" class="fleet-edit">${hidden}<label>Host ID<input name="id" required maxlength="48" value="${esc(current?.id ?? "")}"></label><label>Tailnet IPv4<input name="ip" required maxlength="45" value="${esc(current?.ip ?? "")}" placeholder="100.64.0.1"></label><label>SSH host alias<input name="ssh_host" required maxlength="253" value="${esc(current?.ssh_host ?? "")}"></label><label class="toggle"><input type="checkbox" name="enabled" value="1"${current?.enabled ? " checked" : ""}>Enabled for new dispatch</label><label>Allowed model IDs, one per line<textarea name="allowedModels" rows="3" maxlength="8192" spellcheck="false">${esc(current?.allowedModels.join("\n") ?? "")}</textarea></label><button type="submit">${action === "add" ? "Add host" : "Save host"}</button></form>`;
}

function renderFleet(base: string, csrf: string, view: FleetView, saved: boolean): string {
  const groups: readonly NavGroup[] = NAV_GROUPS.map((group) => group.label === "Resources"
    ? { ...group, items: [...group.items, { key: "oracle-fleet", label: "Oracle fleet", href: "/admin/oracle/fleet" }] }
    : group);
  const rows = view.hosts.map((host) => `<tr><th scope="row">${esc(host.id)}</th><td>${esc(host.ip)}</td><td>${esc(host.ssh_host)}</td><td>${host.enabled ? "Enabled" : "Disabled"}</td><td>${host.allowedModels.length ? host.allowedModels.map(esc).join(" · ") : "None"}</td><td><details><summary>Edit</summary><p class="muted">Configured models only; installation is not checked here.</p>${form(base, "update", view.revision, host, host.id)}</details></td><td>${form(base, "remove", view.revision, undefined, host.id)}</td></tr>`).join("");
  const body = `<main class="wrap">${adminNav(base, "oracle-fleet", groups)}<section class="grid"><div class="card full"><div class="eyebrow">ROTOXY · Private workers</div><h1>Oracle fleet</h1><p>Manage the private host registry and exact model allowlists. Models shown here are configured for dispatch; this page does not check whether a model is installed.</p><p><strong>Changes apply after the pool restarts.</strong> Saving does not restart services, contact hosts, install models, or alter queued history. Each change is backed up locally and uses a revision check to prevent overwriting a concurrent edit.</p>${saved ? '<p role="status">Fleet configuration saved.</p>' : ""}</div><section class="card full"><h2>Configured hosts · v${view.version}</h2><p class="muted">Removing a host changes only this registry; queued and historical task records remain stored.</p><div style="overflow:auto"><table><thead><tr><th>Host ID</th><th>Tailnet IP</th><th>SSH alias</th><th>Dispatch</th><th>Configured models</th><th>Edit</th><th>Remove</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No hosts are configured.</td></tr>'}</tbody></table></div></section><section class="card full"><details><summary>Add a host</summary><p>Use an owner-approved Tailnet IPv4 address and SSH host alias.</p>${form(base, "add", view.revision)}</details></section></section></main>`;
  return page("Oracle fleet", withCsrf(body, csrf));
}

/** Owner-only private fleet editor. Root separately mounts the returned router and nav entry. */
export function createOracleFleetAdminRouter(store: StateStore, sessions: AdminSessions, options: OracleFleetAdminOptions = {}) {
  const router = express.Router();
  const configPath = options.configPath ?? runtimeStatePath("oracle-pool", "config.json");
  const supervisorCwd = options.supervisorCwd ?? resolve(dirname(fileURLToPath(import.meta.url)), "../supervisor");
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT;
  if (![configPath, supervisorCwd].every((path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0")) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT ||
      !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > MAX_OUTPUT) throw new Error("invalid_trusted_fleet_options");
  const runner = options.commandRunner ?? defaultRunner;

  router.use("/admin/oracle/fleet", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const state = await store.load();
    const token = parseCookies(req.headers.cookie).t2o_admin;
    const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
    if (!sessions.valid(token, adminEpoch(state))) return res.redirect(302, `${base}/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.locals.base = base; res.locals.token = token; res.locals.csrf = sessions.csrfToken(token);
    res.locals.origin = new URL(state.config.publicBaseUrl).origin;
    next();
  });
  router.use("/admin/oracle/fleet", express.urlencoded({ extended: false, limit: "20kb" }));

  async function invoke(input: Record<string, unknown>): Promise<FleetView> {
    const args = ["-m", "snooze.oracle_fleet_config", "--config", configPath];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const output = await runner(PYTHON, args, { cwd: supervisorCwd, timeoutMs, maxOutputBytes, signal: controller.signal }, JSON.stringify(input));
      if (Buffer.byteLength(output, "utf8") > maxOutputBytes) throw new Error("fleet_output_too_large");
      let result: unknown;
      try { result = JSON.parse(output); } catch { throw new Error("fleet_response_invalid"); }
      if (isRecord(result) && typeof result.error === "string") throw new Error(result.error);
      return validateView(result);
    } finally { clearTimeout(timer); }
  }

  router.get("/admin/oracle/fleet", async (req, res) => {
    try { return res.type("html").send(renderFleet(res.locals.base, res.locals.csrf, await invoke({ action: "read" }), req.query.saved === "1")); }
    catch { return res.status(503).type("html").send(page("Oracle fleet", `<main class="wrap">${adminNav(res.locals.base, "oracle")}<h1>Oracle fleet</h1><p>Private fleet configuration is unavailable or invalid. No host was contacted.</p></main>`)); }
  });
  router.post("/admin/oracle/fleet", async (req, res) => {
    const origin = req.get("origin");
    if (!origin || origin !== res.locals.origin) return res.status(403).json({ error: "same_origin_required" });
    if (!sessions.verifyCsrf(res.locals.token, req.body?._csrf)) return res.status(403).json({ error: "csrf_invalid" });
    const body = req.body as Record<string, unknown>;
    try {
      if (typeof body.revision !== "string" || !REVISION.test(body.revision) || typeof body.action !== "string") throw new Error("invalid_request");
      let input: Record<string, unknown>;
      if (body.action === "add") input = { action: "add", revision: body.revision, host: parseHost(body) };
      else if (body.action === "update") {
        if (typeof body.targetId !== "string" || !ID.test(body.targetId)) throw new Error("invalid_host_id");
        input = { action: "update", revision: body.revision, targetId: body.targetId, host: parseHost(body) };
      } else if (body.action === "remove") {
        if (typeof body.targetId !== "string" || !ID.test(body.targetId)) throw new Error("invalid_host_id");
        input = { action: "remove", revision: body.revision, targetId: body.targetId };
      } else throw new Error("invalid_action");
      await invoke(input);
      return res.redirect(303, `${res.locals.base}/admin/oracle/fleet?saved=1`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "fleet_config_failed";
      const status = message === "revision_conflict" ? 409 : message === "config_locked" ? 423 : 400;
      const safe = new Set(["revision_conflict", "config_locked", "host_exists", "host_not_found", "last_host_required", "config_invalid", "invalid_host", "invalid_host_id", "invalid_action", "invalid_revision", "backup_collision"]);
      return res.status(status).type("text").send(safe.has(message) ? message : "fleet_config_operation_failed");
    }
  });
  return { router };
}
