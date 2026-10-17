import express from "express";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc, NAV_GROUPS, withCsrf, type NavGroup } from "./html.js";
import { runtimeStatePath } from "./supervisor-runtime.js";
import type { StateStore } from "./store.js";
import { page } from "./ui.js";

const PYTHON = "/usr/bin/python3", MAX_TIMEOUT = 40_000, MAX_OUTPUT = 256 * 1024;
const REV = /^[A-Za-z0-9_-]{24}$/;
export interface OracleModelCommandRequest { cwd: string; timeoutMs: number; maxOutputBytes: number; signal: AbortSignal }
export type OracleModelCommandRunner = (command: string, args: string[], request: OracleModelCommandRequest, input: string) => Promise<string>;
export interface OracleModelAdminOptions { configPath?: string; dbPath?: string; cachePath?: string; supervisorCwd?: string; commandRunner?: OracleModelCommandRunner; timeoutMs?: number; maxOutputBytes?: number }
type Model = { name: string; size: number | null; modifiedAt: string | null };
type Host = { id: string; enabled: boolean; allowedModels: string[]; hostStatus: string; models: Model[]; observedAt: number | null; load: { running: number; assigned: number } | null };
type Maintenance = { epoch: number; paused: boolean; configRevision: string | null; acknowledged: boolean; blockers: { running: number; ambiguous: number; dispatching: number }; reason: string | null };
type DaemonStatus = { available: boolean; instanceId: string | null; loadedRevision: string | null; heartbeatAt: number | null; observedEpoch: number | null; alive: boolean };
type ApplyOperation = { applyId: string; epoch: number; targetRevision: string; previousInstance: string | null; status: "prepared" | "complete" | "failed"; error: string | null };
type ApplyStatus = { daemon: DaemonStatus; operation: ApplyOperation | null; maintenance: unknown; ready: boolean; reason: string | null };
type View = { cacheRevision: string; configRevision: string; cacheUpdatedAt: number | null; hosts: Host[]; queue: { available: boolean; reason?: string | null; statuses?: Record<string, number>; hosts?: Record<string, { running: number; assigned: number }> }; apply: { mode: "previewOnly"; blockedReason: string }; applyStatus: ApplyStatus | null; maintenance: Maintenance | null };
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
  const rawMaintenance = value.maintenance;
  let maintenance: Maintenance | null = null;
  if (rawMaintenance !== null) {
    if (!record(rawMaintenance) || !Number.isSafeInteger(rawMaintenance.epoch) || Number(rawMaintenance.epoch) < 0 || typeof rawMaintenance.paused !== "boolean" ||
        !(rawMaintenance.configRevision === null || typeof rawMaintenance.configRevision === "string" && rawMaintenance.configRevision.length <= 64) || typeof rawMaintenance.acknowledged !== "boolean" || !record(rawMaintenance.blockers) ||
        !["running", "ambiguous", "dispatching"].every((key) => Number.isSafeInteger((rawMaintenance.blockers as Record<string, unknown>)[key]) && Number((rawMaintenance.blockers as Record<string, unknown>)[key]) >= 0) ||
        !(rawMaintenance.reason === null || typeof rawMaintenance.reason === "string" && rawMaintenance.reason.length <= 200)) throw new Error("invalid_oracle_maintenance_response");
    maintenance = { epoch: Number(rawMaintenance.epoch), paused: rawMaintenance.paused, configRevision: rawMaintenance.configRevision as string | null,
      acknowledged: rawMaintenance.acknowledged, blockers: rawMaintenance.blockers as Maintenance["blockers"], reason: rawMaintenance.reason as string | null };
  }
  let applyStatus: ApplyStatus | null = null;
  if (value.applyStatus !== undefined && value.applyStatus !== null) {
    const a = value.applyStatus;
    if (!record(a) || !record(a.daemon) || typeof a.daemon.available !== "boolean" || !(a.daemon.instanceId === null || typeof a.daemon.instanceId === "string" && a.daemon.instanceId.length <= 128) ||
        !(a.daemon.loadedRevision === null || typeof a.daemon.loadedRevision === "string" && a.daemon.loadedRevision.length <= 64) || !(a.daemon.heartbeatAt === null || typeof a.daemon.heartbeatAt === "number" && Number.isFinite(a.daemon.heartbeatAt)) ||
        !(a.daemon.observedEpoch === null || Number.isSafeInteger(a.daemon.observedEpoch) && Number(a.daemon.observedEpoch) >= 0) || typeof a.daemon.alive !== "boolean" || typeof a.ready !== "boolean" || !(a.reason === null || typeof a.reason === "string" && a.reason.length <= 200)) throw new Error("invalid_oracle_apply_status");
    let operation: ApplyOperation | null = null;
    if (a.operation !== null) {
      const o = a.operation;
      if (!record(o) || typeof o.applyId !== "string" || o.applyId.length > 128 || !Number.isSafeInteger(o.epoch) || Number(o.epoch) < 0 || typeof o.targetRevision !== "string" || o.targetRevision.length > 64 || !(o.previousInstance === null || typeof o.previousInstance === "string" && o.previousInstance.length <= 128) || !["prepared", "complete", "failed"].includes(String(o.status)) || !(o.error === null || typeof o.error === "string" && o.error.length <= 200)) throw new Error("invalid_oracle_apply_status");
      operation = o as ApplyOperation;
    }
    applyStatus = { daemon: a.daemon as unknown as DaemonStatus, operation, maintenance: a.maintenance ?? null, ready: a.ready, reason: a.reason as string | null };
  }
  const q = value.queue;
  return { cacheRevision: value.cacheRevision, configRevision: value.configRevision, cacheUpdatedAt: value.cacheUpdatedAt as number | null, hosts,
    queue: { available: q.available === true, reason: typeof q.reason === "string" ? q.reason : null, statuses: record(q.statuses) ? q.statuses as Record<string, number> : undefined, hosts: record(q.hosts) ? q.hosts as View["queue"]["hosts"] : undefined },
    apply: { mode: "previewOnly", blockedReason: value.apply.blockedReason }, applyStatus, maintenance };
}
function render(base: string, csrf: string, view: View, status: string): string {
  const groups: readonly NavGroup[] = NAV_GROUPS.map((g) => g.label === "Resources" ? { ...g, items: [...g.items, { key: "oracle-models", label: "Oracle models", href: "/admin/oracle/models" }] } : g);
  const cards = view.hosts.map((host) => {
    const byName = new Map(host.models.map((m) => [m.name, m]));
    const names = [...new Set([...host.allowedModels, ...host.models.map((m) => m.name)])].sort();
    const rows = names.map((name) => { const model = byName.get(name); return `<tr><th scope="row"><code>${esc(name)}</code></th><td>${model ? "Installed" : "Not in latest catalog"}</td><td>${host.allowedModels.includes(name) ? "Allowed" : "Not allowed"}</td><td>${model?.size === null || !model ? "Unknown" : `${esc(model.size)} bytes`}</td><td>${model?.modifiedAt ? esc(model.modifiedAt) : "Unknown"}</td></tr>`; }).join("");
    return `<section class="card full"><h2>${esc(host.id)} · ${host.enabled ? "Dispatch enabled" : "Dispatch disabled"}</h2><p>Host catalog: <strong>${esc(host.hostStatus)}</strong> · observed ${host.observedAt === null ? "never" : esc(new Date(host.observedAt * 1000).toISOString())} · queue history ${host.load ? `${host.load.running} running / ${host.load.assigned} assigned` : "unavailable"}</p><div style="overflow:auto"><table><thead><tr><th>Model name</th><th>Installed</th><th>Fleet allowlist</th><th>Reported size</th><th>Modified</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No cached models or allowed model IDs.</td></tr>'}</tbody></table></div></section>`;
  }).join("");
  const m = view.maintenance;
  const maintenanceBlockers = m ? m.blockers.running + m.blockers.ambiguous + m.blockers.dispatching : 0;
  const maintenanceState = !m ? "Maintenance state unavailable" : m.paused
    ? m.blockers.ambiguous > 0 ? "Paused; unresolved ambiguous work" : maintenanceBlockers > 0 ? "Paused; draining" : m.acknowledged ? "Paused; drained and acknowledged" : "Paused; awaiting drain acknowledgement"
    : m.blockers.ambiguous > 0 ? "Dispatch enabled; unresolved ambiguous work" : "Dispatch enabled; no acknowledgement pending";
  const op = view.applyStatus?.operation;
  const abortBlocked = !view.applyStatus || op?.status === "prepared" || op?.status === "failed";
  const daemon = view.applyStatus?.daemon;
  const processIdentity = !view.applyStatus ? "status unsupported" : daemon?.alive ? "process identity alive" : daemon?.available ? "process identity not alive" : "process unavailable";
  const applyLabel = view.applyStatus?.reason === "reconcile_ready" ? "Reconcile previous apply" : "Apply this configuration";
  const readiness = !view.applyStatus ? "Coordinator unsupported or unavailable; apply is disabled." : view.applyStatus.ready ? "Ready to apply." : esc((view.applyStatus.reason ?? "not ready").replaceAll("_", " "));
  const detail = `<details class="oa-details"><summary>Daemon and operation details</summary><dl><div><dt>Process</dt><dd>${processIdentity}</dd></div><div><dt>Heartbeat</dt><dd>${daemon?.heartbeatAt == null ? "unknown" : esc(new Date(daemon.heartbeatAt * 1000).toISOString())}</dd></div><div><dt>Instance</dt><dd><code>${esc(daemon?.instanceId ?? "unknown")}</code></dd></div><div><dt>Operation</dt><dd>${op ? `<code>${esc(op.applyId)}</code> · ${esc(op.status)} · epoch ${op.epoch}${op.error ? ` · ${esc(op.error)}` : ""}` : "none reported"}${op?.status === "failed" ? " · recovery required" : ""}</dd></div></dl></details>`;
  const applyCard = `<section class="card oa-controls"><h2>Apply configuration</h2><p>Requested <code>${esc(view.configRevision)}</code> · loaded <code>${esc(daemon?.loadedRevision ?? "unknown")}</code></p><p>Readiness: <strong>${readiness}</strong></p><p class="muted">${esc(view.apply.blockedReason)}</p>${detail}<div class="actions"><form method="post" action="${esc(base)}/admin/oracle/models"><input type="hidden" name="action" value="apply"><input type="hidden" name="revision" value="${esc(view.configRevision)}"><button class="secondary">Check apply readiness</button></form><form method="post" action="${esc(base)}/admin/oracle/models"><input type="hidden" name="action" value="apply-config"><input type="hidden" name="revision" value="${esc(view.configRevision)}"><input type="hidden" name="epoch" value="${daemon?.observedEpoch ?? ""}"><button${view.applyStatus?.ready === true && daemon?.observedEpoch !== null && daemon?.observedEpoch !== undefined ? "" : " disabled"}>${applyLabel}</button></form></div></section>`;
  const maintenanceCard = m ? `<section class="card full oa-controls"><h2>Pool dispatch maintenance</h2><p>State: <strong>${maintenanceState}</strong> · epoch ${m.epoch}${m.reason ? ` · ${esc(m.reason)}` : ""}</p><p>Blockers: ${m.blockers.running} running · ${m.blockers.ambiguous} ambiguous · ${m.blockers.dispatching} dispatching.</p><p>Pause prevents new claims; it does not stop queueing, cancel tasks, or stop running tasks. Resume aborts maintenance and resumes dispatch without applying changes.</p><div class="actions"><form method="post" action="${esc(base)}/admin/oracle/models"><input type="hidden" name="action" value="maintenance-request"><input type="hidden" name="revision" value="${esc(view.configRevision)}"><input type="hidden" name="epoch" value="${m.epoch}"><button${m.paused ? " disabled" : ""}>Pause dispatch and drain</button></form><form method="post" action="${esc(base)}/admin/oracle/models"><input type="hidden" name="action" value="maintenance-release"><input type="hidden" name="revision" value="${esc(view.configRevision)}"><input type="hidden" name="epoch" value="${m.epoch}"><button class="secondary"${m.paused && !abortBlocked ? "" : " disabled"}>Abort maintenance and resume dispatch</button></form></div>${abortBlocked && m.paused ? '<p class="muted">Resume is disabled while apply reservation state is unavailable or prepared/failed.</p>' : ""}</section>` : `<section class="card full"><h2>Pool dispatch maintenance</h2><p>Maintenance state unavailable. No epoch is assumed; controls remain disabled until the core fence state is readable.</p><button disabled>Pause dispatch and drain</button><button class="secondary" disabled>Abort maintenance and resume dispatch</button></section>`;
  const style = `<style>.oa-controls,.full.oa-controls{grid-column:span 6}.oa-controls .actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1rem}.oa-controls form{min-width:min(100%,14rem)}.oa-controls button{max-width:100%;white-space:normal;overflow-wrap:anywhere}.oa-details{margin-top:.85rem}.oa-details summary{cursor:pointer;font-weight:600}.oa-details dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.4rem .8rem;margin:.8rem 0 0}.oa-details dl div{display:contents}.oa-details dt{font-weight:600}.oa-details dd{margin:0;overflow-wrap:anywhere}@media(max-width:850px){.oa-controls,.full.oa-controls{grid-column:1 / -1}}@media(max-width:420px){.oa-controls .actions{display:grid;grid-template-columns:minmax(0,1fr)}.oa-controls form,.oa-controls button{width:100%;min-width:0}.oa-details dl{grid-template-columns:1fr}.oa-details dt{margin-top:.4rem}}</style>`;
  const body = `<main class="wrap">${adminNav(base, "oracle-models", groups)}${style}<section class="grid"><section class="card full"><div class="eyebrow">ROTOXY · Private workers</div><h1>Oracle model inventory</h1><p>Installed model names come from the last explicit catalog refresh. Compare them with the fleet allowlist below.</p><p>Refresh reads each enabled host without installing or removing models. Opening this page uses the cached catalog.</p>${status ? `<p role="status">${esc(status)}</p>` : ""}<form method="post" action="${esc(base)}/admin/oracle/models"><input type="hidden" name="action" value="refresh"><input type="hidden" name="revision" value="${esc(view.cacheRevision)}"><button>Refresh catalog</button></form><p class="muted">Cache refreshed ${view.cacheUpdatedAt === null ? "never" : esc(new Date(view.cacheUpdatedAt * 1000).toISOString())} · fleet config revision <code>${esc(view.configRevision)}</code></p></section>${maintenanceCard}${applyCard}${cards}</section></main>`;
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
    try { return res.type("html").send(render(res.locals.base, res.locals.csrf, await invoke({ action: "read" }), req.query.refreshed === "1" ? "Catalog refresh completed." : req.query.applyProcessed === "1" ? "Apply request processed; inspect the current operation and daemon status below." : req.query.preview === "1" ? "Readiness checked; no apply request was made." : "")); }
    catch { return res.status(503).type("html").send(page("Oracle model inventory", `<main class="wrap">${adminNav(res.locals.base, "oracle")}<h1>Oracle model inventory</h1><p>Inventory or local queue state is unavailable. No host was contacted.</p></main>`)); }
  });
  router.post("/admin/oracle/models", async (req, res) => {
    if (req.get("origin") !== res.locals.origin) return res.status(403).json({ error: "same_origin_required" });
    if (!sessions.verifyCsrf(res.locals.token, req.body?._csrf)) return res.status(403).json({ error: "csrf_invalid" });
    const b = req.body as Record<string, unknown>;
    try {
      const fields = Object.keys(b).sort().join(",");
      const expected = b.action === "maintenance-request" || b.action === "maintenance-release" || b.action === "apply-config" ? "_csrf,action,epoch,revision" : "_csrf,action,revision";
      if (fields !== expected) throw new Error("request_invalid");
      if (!record(b) || typeof b.revision !== "string" || !REV.test(b.revision)) throw new Error("revision_invalid");
      if (b.action === "refresh") await invoke({ action: "refresh", expectedCacheRevision: b.revision });
      else if (b.action === "apply") await invoke({ action: "apply", expectedConfigRevision: b.revision });
      else if (b.action === "maintenance-request" || b.action === "maintenance-release" || b.action === "apply-config") {
        if (typeof b.epoch !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(b.epoch) || !Number.isSafeInteger(Number(b.epoch))) throw new Error("maintenance_epoch_invalid");
        const action = b.action === "apply-config" ? "apply-config" : b.action;
        await invoke({ action, expectedConfigRevision: b.revision, expectedEpoch: Number(b.epoch) });
      }
      else throw new Error("request_invalid");
      return res.redirect(303, `${res.locals.base}/admin/oracle/models?${b.action === "refresh" ? "refreshed=1" : b.action === "apply-config" ? "applyProcessed=1" : "preview=1"}`);
    } catch (error) {
      const code = error instanceof Error ? error.message : "oracle_model_admin_failed";
      const status = code === "cache_revision_conflict" || code === "config_revision_conflict" || code === "maintenance_epoch_conflict" || code === "maintenance_revision_conflict" || code === "apply_epoch_conflict" ? 409 : code === "cache_locked" ? 423 : 400;
      const safe = new Set(["request_invalid", "revision_invalid", "cache_revision_conflict", "config_revision_conflict", "maintenance_revision_invalid", "maintenance_epoch_invalid", "maintenance_epoch_conflict", "maintenance_revision_conflict", "maintenance_api_unavailable", "apply_coordinator_unavailable", "apply_not_ready", "apply_epoch_invalid", "apply_revision_invalid", "apply_revision_conflict", "apply_epoch_conflict", "cache_locked", "queue_state_unavailable"]);
      return res.status(status).type("text").send(safe.has(code) ? code : "oracle_model_operation_failed");
    }
  });
  return { router };
}
