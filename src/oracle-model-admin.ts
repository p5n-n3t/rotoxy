import express from "express";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc, NAV_GROUPS, withCsrf, type NavGroup } from "./html.js";
import { runtimeStatePath } from "./supervisor-runtime.js";
import type { StateStore } from "./store.js";
import { page } from "./ui.js";

const PYTHON = "/usr/bin/python3", MAX_TIMEOUT = 10_000, MAX_OUTPUT = 256 * 1024;
const REV = /^[A-Za-z0-9_-]{24}$/;
export interface OracleModelCommandRequest { cwd: string; timeoutMs: number; maxOutputBytes: number; signal: AbortSignal }
export type OracleModelCommandRunner = (command: string, args: string[], request: OracleModelCommandRequest, input: string) => Promise<string>;
export interface OracleModelAdminOptions { configPath?: string; dbPath?: string; cachePath?: string; supervisorCwd?: string; commandRunner?: OracleModelCommandRunner; timeoutMs?: number; maxOutputBytes?: number }
type Model = { name: string; size: number | null; modifiedAt: string | null };
type Host = { id: string; enabled: boolean; allowedModels: string[]; hostStatus: string; models: Model[]; observedAt: number | null; load: { running: number; assigned: number } | null };
type View = { cacheRevision: string; configRevision: string; cacheUpdatedAt: number | null; hosts: Host[]; queue: { available: boolean; reason?: string | null; statuses?: Record<string, number>; hosts?: Record<string, { running: number; assigned: number }> }; apply: { mode: "previewOnly"; blockedReason: string } };
function record(x: unknown): x is Record<string, unknown> { return typeof x === "object" && x !== null && !Array.isArray(x); }
function defaultRunner(command: string, args: string[], req: OracleModelCommandRequest, input: string): Promise<string> {
  if (command !== PYTHON) return Promise.reject(new Error("command_not_allowed"));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: req.cwd, stdio: ["pipe", "pipe", "ignore"], shell: false, signal: req.signal });
    const chunks: Buffer[] = []; let bytes = 0, over = false;
    child.stdout.on("data", (part: Buffer | string) => { if (over) return; const data = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += data.length; if (bytes > req.maxOutputBytes) { over = true; child.kill("SIGKILL"); return; } chunks.push(data); });
    child.on("error", () => reject(new Error("oracle_model_admin_unavailable")));
    child.on("close", (code) => code === 0 && !over ? resolvePromise(Buffer.concat(chunks).toString("utf8")) : reject(new Error(over ? "oracle_model_output_too_large" : "oracle_model_admin_unavailable")));
    child.stdin.on("error", () => undefined); child.stdin.end(input);
  });
}
function validate(value: unknown): View {
  if (!record(value) || typeof value.cacheRevision !== "string" || !REV.test(value.cacheRevision) || typeof value.configRevision !== "string" || !REV.test(value.configRevision) ||
      !Array.isArray(value.hosts) || value.hosts.length > 32 || !record(value.queue) || !record(value.apply) || value.apply.mode !== "previewOnly" || typeof value.apply.blockedReason !== "string" || value.apply.blockedReason.length > 200) throw new Error("invalid_oracle_model_response");
  const hosts = value.hosts.map((x): Host => {
    if (!record(x) || typeof x.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(x.id) || typeof x.enabled !== "boolean" || !Array.isArray(x.allowedModels) || x.allowedModels.length > 64 || x.allowedModels.some((m) => typeof m !== "string" || m.length > 160) ||
        typeof x.hostStatus !== "string" || !["unknown", "healthy", "unavailable", "disabled"].includes(x.hostStatus) || !Array.isArray(x.models) || x.models.length > 256 ||
        x.models.some((m) => !record(m) || typeof m.name !== "string" || m.name.length > 160 || !(m.size === null || Number.isSafeInteger(m.size) && Number(m.size) >= 0) || !(m.modifiedAt === null || typeof m.modifiedAt === "string" && m.modifiedAt.length <= 64)) ||
        !(x.observedAt === null || typeof x.observedAt === "number" && Number.isFinite(x.observedAt)) || !(x.load === null || record(x.load) && Number.isSafeInteger(x.load.running) && Number.isSafeInteger(x.load.assigned))) throw new Error("invalid_oracle_model_response");
    return { id: x.id, enabled: x.enabled, allowedModels: x.allowedModels as string[], hostStatus: x.hostStatus, models: x.models as Model[], observedAt: x.observedAt as number | null, load: x.load as Host["load"] };
  });
  const q = value.queue;
  return { cacheRevision: value.cacheRevision, configRevision: value.configRevision, cacheUpdatedAt: value.cacheUpdatedAt as number | null, hosts,
    queue: { available: q.available === true, reason: typeof q.reason === "string" ? q.reason : null, statuses: record(q.statuses) ? q.statuses as Record<string, number> : undefined, hosts: record(q.hosts) ? q.hosts as View["queue"]["hosts"] : undefined },
    apply: { mode: "previewOnly", blockedReason: value.apply.blockedReason } };
}
function render(base: string, csrf: string, view: View, status: string): string {
  const groups: readonly NavGroup[] = NAV_GROUPS.map((g) => g.label === "Resources" ? { ...g, items: [...g.items, { key: "oracle-models", label: "Oracle models", href: "/admin/oracle/models" }] } : g);
  const cards = view.hosts.map((host) => {
    const byName = new Map(host.models.map((m) => [m.name, m]));
    const names = [...new Set([...host.allowedModels, ...host.models.map((m) => m.name)])].sort();
    const rows = names.map((name) => { const model = byName.get(name); return `<tr><th scope="row"><code>${esc(name)}</code></th><td>${model ? "Installed" : "Not in latest catalog"}</td><td>${host.allowedModels.includes(name) ? "Allowed" : "Not allowed"}</td><td>${model?.size === null || !model ? "Unknown" : `${esc(model.size)} bytes`}</td><td>${model?.modifiedAt ? esc(model.modifiedAt) : "Unknown"}</td></tr>`; }).join("");
    return `<section class="card full"><h2>${esc(host.id)} · ${host.enabled ? "Dispatch enabled" : "Dispatch disabled"}</h2><p>Host catalog: <strong>${esc(host.hostStatus)}</strong> · observed ${host.observedAt === null ? "never" : esc(new Date(host.observedAt).toISOString())} · queue history ${host.load ? `${host.load.running} running / ${host.load.assigned} assigned` : "unavailable"}</p><div style="overflow:auto"><table><thead><tr><th>Model name</th><th>Installed</th><th>Fleet allowlist</th><th>Reported size</th><th>Modified</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No cached models or allowed model IDs.</td></tr>'}</tbody></table></div></section>`;
  }).join("");
  const body = `<main class="wrap">${adminNav(base, "oracle-models", groups)}<section class="grid"><section class="card full"><div class="eyebrow">ROTOXY · Private workers</div><h1>Oracle model inventory</h1><p>Installed model names come from the last explicit read-only catalog refresh. The fleet allowlist is shown separately. Size and modified time are reported by Ollama; they are not disk budgets or an identity verification.</p><p>Opening this page does not contact hosts. Refresh makes a bounded GET to the fixed Ollama tags endpoint through each enabled configured host. No model is installed or removed here.</p>${status ? `<p role="status">${esc(status)}</p>` : ""}<form method="post" action="${esc(base)}/admin/oracle/models"><input type="hidden" name="action" value="refresh"><input type="hidden" name="revision" value="${esc(view.cacheRevision)}"><button>Refresh catalog</button></form><p class="muted">Cache refreshed ${view.cacheUpdatedAt === null ? "never" : esc(new Date(view.cacheUpdatedAt).toISOString())} · fleet config revision <code>${esc(view.configRevision)}</code></p></section>${cards}<section class="card full"><h2>Apply to local pool</h2><p>This control is preview-only. ${esc(view.apply.blockedReason)} No service restart or fleet configuration write is available until dispatch has a shared maintenance fence.</p><p>Queue state: ${view.queue.available ? esc(JSON.stringify(view.queue.statuses ?? {})) : `Unavailable (${esc(view.queue.reason ?? "unknown")})`}</p><form method="post" action="${esc(base)}/admin/oracle/models"><input type="hidden" name="action" value="apply"><input type="hidden" name="revision" value="${esc(view.configRevision)}"><button class="secondary">Check apply readiness</button></form></section></section></main>`;
  return page("Oracle model inventory", withCsrf(body, csrf));
}

/** Owner-only, explicit-refresh inventory route. Root mounts this router and its nav entry. */
export function createOracleModelAdminRouter(store: StateStore, sessions: AdminSessions, options: OracleModelAdminOptions = {}) {
  const router = express.Router();
  const configPath = options.configPath ?? runtimeStatePath("oracle-pool", "config.json");
  const dbPath = options.dbPath ?? runtimeStatePath("oracle-pool", "queue.sqlite3");
  const cachePath = options.cachePath ?? resolve(store.dir, "oracle-model-inventory.json");
  const supervisorCwd = options.supervisorCwd ?? resolve(dirname(fileURLToPath(import.meta.url)), "../supervisor");
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT, maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT;
  if (![configPath, dbPath, cachePath, supervisorCwd].every((p) => typeof p === "string" && isAbsolute(p) && !p.includes("\0")) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 2048 || maxOutputBytes > MAX_OUTPUT) throw new Error("invalid_oracle_model_admin_options");
  const runner = options.commandRunner ?? defaultRunner;
  router.use("/admin/oracle/models", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    const state = await store.load(), token = parseCookies(req.headers.cookie).t2o_admin, base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
    if (!sessions.valid(token, adminEpoch(state))) return res.redirect(302, `${base}/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.locals.base = base; res.locals.token = token; res.locals.csrf = sessions.csrfToken(token); res.locals.origin = new URL(state.config.publicBaseUrl).origin; next();
  });
  router.use("/admin/oracle/models", express.urlencoded({ extended: false, limit: "8kb" }));
  async function invoke(input: Record<string, unknown>): Promise<View> {
    const args = ["-m", "snooze.oracle_model_admin", "--config", configPath, "--db", dbPath, "--cache", cachePath];
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const output = await runner(PYTHON, args, { cwd: supervisorCwd, timeoutMs, maxOutputBytes, signal: controller.signal }, JSON.stringify(input));
      if (Buffer.byteLength(output) > maxOutputBytes) throw new Error("oracle_model_output_too_large");
      let result: unknown; try { result = JSON.parse(output); } catch { throw new Error("oracle_model_response_invalid"); }
      if (record(result) && typeof result.error === "string") throw new Error(result.error);
      return validate(result);
    } finally { clearTimeout(timer); }
  }
  router.get("/admin/oracle/models", async (req, res) => {
    try { return res.type("html").send(render(res.locals.base, res.locals.csrf, await invoke({ action: "read" }), req.query.refreshed === "1" ? "Catalog refresh completed." : req.query.preview === "1" ? "Apply readiness checked; changes remain preview-only." : "")); }
    catch { return res.status(503).type("html").send(page("Oracle model inventory", `<main class="wrap">${adminNav(res.locals.base, "oracle")}<h1>Oracle model inventory</h1><p>Inventory or local queue state is unavailable. No host was contacted.</p></main>`)); }
  });
  router.post("/admin/oracle/models", async (req, res) => {
    if (req.get("origin") !== res.locals.origin) return res.status(403).json({ error: "same_origin_required" });
    if (!sessions.verifyCsrf(res.locals.token, req.body?._csrf)) return res.status(403).json({ error: "csrf_invalid" });
    const b = req.body as Record<string, unknown>;
    try {
      if (typeof b.revision !== "string" || !REV.test(b.revision)) throw new Error("revision_invalid");
      if (b.action === "refresh") await invoke({ action: "refresh", expectedCacheRevision: b.revision });
      else if (b.action === "apply") await invoke({ action: "apply", expectedConfigRevision: b.revision });
      else throw new Error("request_invalid");
      return res.redirect(303, `${res.locals.base}/admin/oracle/models?${b.action === "refresh" ? "refreshed=1" : "preview=1"}`);
    } catch (error) {
      const code = error instanceof Error ? error.message : "oracle_model_admin_failed";
      const status = code === "cache_revision_conflict" || code === "config_revision_conflict" ? 409 : code === "cache_locked" ? 423 : 400;
      const safe = new Set(["request_invalid", "revision_invalid", "cache_revision_conflict", "config_revision_conflict", "cache_locked", "queue_state_unavailable"]);
      return res.status(status).type("text").send(safe.has(code) ? code : "oracle_model_operation_failed");
    }
  });
  return { router };
}
