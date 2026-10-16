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
const MAX_TIMEOUT = 10_000, MAX_OUTPUT = 32 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;
const REVISION = /^[A-Za-z0-9_-]{24}$/;
export interface PrivateServiceCommandRequest { cwd: string; timeoutMs: number; maxOutputBytes: number; signal: AbortSignal }
export type PrivateServiceCommandRunner = (command: string, args: string[], request: PrivateServiceCommandRequest, input: string) => Promise<string>;
export interface PrivateServiceAdminOptions {
  registryPath?: string;
  fleetConfigPath?: string;
  supervisorCwd?: string;
  commandRunner?: PrivateServiceCommandRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
type Service = { id: string; kind: "litellm" | "loopback"; label: string; hostId: string; enabled: boolean; probe: { status: string; checkedAt: number | null; aliases: string[] } };
type Registry = { revision: string; registry: { version: 1; services: Service[] } };

function defaultRunner(command: string, args: string[], request: PrivateServiceCommandRequest, input: string): Promise<string> {
  if (command !== PYTHON) return Promise.reject(new Error("command_not_allowed"));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: request.cwd, stdio: ["pipe", "pipe", "ignore"], shell: false, signal: request.signal });
    const chunks: Buffer[] = []; let size = 0, oversized = false;
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (oversized) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength;
      if (size > request.maxOutputBytes) { oversized = true; child.kill("SIGKILL"); return; }
      chunks.push(bytes);
    });
    child.on("error", () => reject(new Error("private_services_unavailable")));
    child.on("close", (code) => {
      if (oversized || code !== 0) return reject(new Error(oversized ? "private_services_output_too_large" : "private_services_unavailable"));
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => undefined); child.stdin.end(input);
  });
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validate(value: unknown): Registry {
  if (!record(value) || typeof value.revision !== "string" || !REVISION.test(value.revision) || !record(value.registry) ||
      value.registry.version !== 1 || !Array.isArray(value.registry.services) || value.registry.services.length > 32) throw new Error("invalid_private_services_response");
  const ids = new Set<string>();
  const services = value.registry.services.map((raw): Service => {
    if (!record(raw) || typeof raw.id !== "string" || !ID.test(raw.id) || ids.has(raw.id) ||
        (raw.kind !== "litellm" && raw.kind !== "loopback") || typeof raw.label !== "string" || raw.label.length < 1 || raw.label.length > 80 ||
        typeof raw.hostId !== "string" || typeof raw.enabled !== "boolean" || !record(raw.probe) ||
        !["unknown", "healthy", "reachable", "unavailable"].includes(String(raw.probe.status)) ||
        !(raw.probe.checkedAt === null || typeof raw.probe.checkedAt === "number" && Number.isFinite(raw.probe.checkedAt)) ||
        !Array.isArray(raw.probe.aliases) || raw.probe.aliases.length > 100 || raw.probe.aliases.some((x) => typeof x !== "string" || x.length > 120)) throw new Error("invalid_private_services_response");
    ids.add(raw.id);
    return { id: raw.id, kind: raw.kind, label: raw.label, hostId: raw.hostId, enabled: raw.enabled,
      probe: { status: String(raw.probe.status), checkedAt: raw.probe.checkedAt as number | null, aliases: raw.probe.aliases as string[] } };
  });
  return { revision: value.revision, registry: { version: 1, services } };
}
function parseService(body: Record<string, unknown>): Omit<Service, "probe"> & { probe: Service["probe"] } {
  const { id, kind, label } = body;
  const hostId = kind === "loopback" ? "desktop" : body.hostId;
  if (typeof id !== "string" || !ID.test(id) || (kind !== "litellm" && kind !== "loopback") ||
      typeof label !== "string" || label.trim().length < 1 || label.trim().length > 80 || !/^[\x20-\x7e]+$/.test(label.trim()) ||
      typeof hostId !== "string" || !ID.test(hostId)) throw new Error("invalid_service");
  return { id, kind, label: label.trim(), hostId, enabled: body.enabled === "1", probe: { status: "unknown", checkedAt: null, aliases: [] } };
}
function render(base: string, csrf: string, view: Registry): string {
  const groups: readonly NavGroup[] = NAV_GROUPS.map((group) => group.label === "Resources"
    ? { ...group, items: [...group.items, { key: "private-services", label: "Private services", href: "/admin/services" }] } : group);
  const serviceForm = (action: string, revision: string, service?: Service) => `<form method="post" action="${esc(base)}/admin/services" class="private-service-form"><input type="hidden" name="action" value="${action}"><input type="hidden" name="revision" value="${esc(revision)}">${service ? `<input type="hidden" name="targetId" value="${esc(service.id)}">` : ""}<label>Inventory ID<input name="id" maxlength="48" required value="${esc(service?.id ?? "")}"></label><label>Kind<select name="kind"><option value="litellm"${service?.kind === "litellm" ? " selected" : ""}>LiteLLM gateway</option><option value="loopback"${service?.kind === "loopback" ? " selected" : ""}>Desktop loopback</option></select></label><label>Label<input name="label" maxlength="80" required value="${esc(service?.label ?? "")}"></label><label>Approved Oracle host ID<input name="hostId" maxlength="48" value="${esc(service?.hostId ?? "ora3")}"></label><label class="toggle"><input type="checkbox" name="enabled" value="1"${(service?.enabled ?? true) ? " checked" : ""}>Enabled in inventory</label><button>${service ? "Save" : "Add service"}</button></form>`;
  const cards = view.registry.services.map((s) => `<section class="card private-service-card"><h2>${esc(s.label)}</h2><p><code>${esc(s.id)}</code> · ${s.kind === "litellm" ? `LiteLLM · approved host ${esc(s.hostId)}` : "Loopback · fixed 127.0.0.1:2026"} · ${s.enabled ? "Enabled" : "Disabled"}</p><p>Last explicit probe: ${esc(s.probe.status)}${s.probe.checkedAt === null ? " · not checked" : ` · ${esc(new Date(s.probe.checkedAt).toISOString())}`}</p>${s.kind === "litellm" ? `<p>Reported aliases: ${s.probe.aliases.length ? s.probe.aliases.map((x) => `<code>${esc(x)}</code>`).join(" · ") : "None reported"}. Aliases are provider-reported names; they do not establish underlying model identity.</p>` : "<p>TCP reachability only; no shell command, service action, or MCP tool invocation.</p>"}<form method="post" action="${esc(base)}/admin/services"><input type="hidden" name="action" value="probe"><input type="hidden" name="revision" value="${esc(view.revision)}"><input type="hidden" name="targetId" value="${esc(s.id)}"><button class="secondary"${s.enabled ? "" : " disabled"}>Probe now</button></form><details><summary>Edit</summary>${serviceForm("update", view.revision, s)}<form method="post" action="${esc(base)}/admin/services"><input type="hidden" name="action" value="remove"><input type="hidden" name="revision" value="${esc(view.revision)}"><input type="hidden" name="targetId" value="${esc(s.id)}"><button class="secondary">Remove inventory entry</button></form></details></section>`).join("");
  const body = `<style>.card.private-service-card{grid-column:span 6}@media(max-width:850px){.card.private-service-card{grid-column:1/-1}}</style><main class="wrap">${adminNav(base, "private-services", groups)}<section class="grid"><section class="card full"><div class="eyebrow">ROTOXY · Private gateways</div><h1>Private services</h1><p>Manage a local inventory of known private gateways. This page performs no network probes when it opens. A manual probe is passive, bounded, and read-only; it does not restart services, change configuration, install models, or call MCP tools.</p><p>LiteLLM probes use only the fixed health and model-list paths on the selected configured Oracle host. Model names are reported aliases, not proof of the underlying vendor or model. The desktop entry checks only TCP reachability at 127.0.0.1:2026. Changes are backed up and revision-checked.</p></section>${cards || '<section class="card full">No private services are configured.</section>'}<section class="card full"><details><summary>Add an inventory entry</summary>${serviceForm("add", view.revision)}</details></section></section></main>`;
  return page("Private services", withCsrf(body, csrf));
}

/** Authenticated private inventory manager; the caller mounts its router and navigation entry. */
export function createPrivateServiceAdminRouter(store: StateStore, sessions: AdminSessions, options: PrivateServiceAdminOptions = {}) {
  const router = express.Router();
  const registryPath = options.registryPath ?? resolve(store.dir, "private-services.json");
  const fleetConfigPath = options.fleetConfigPath ?? runtimeStatePath("oracle-pool", "config.json");
  const supervisorCwd = options.supervisorCwd ?? resolve(dirname(fileURLToPath(import.meta.url)), "../supervisor");
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT, maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT;
  if (![registryPath, fleetConfigPath, supervisorCwd].every((p) => typeof p === "string" && isAbsolute(p) && !p.includes("\0")) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > MAX_OUTPUT) throw new Error("invalid_private_service_options");
  const runner = options.commandRunner ?? defaultRunner;
  router.use("/admin/services", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    const state = await store.load(), token = parseCookies(req.headers.cookie).t2o_admin;
    const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
    if (!sessions.valid(token, adminEpoch(state))) return res.redirect(302, `${base}/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.locals.base = base; res.locals.token = token; res.locals.csrf = sessions.csrfToken(token); res.locals.origin = new URL(state.config.publicBaseUrl).origin; next();
  });
  router.use("/admin/services", express.urlencoded({ extended: false, limit: "16kb" }));
  async function invoke(input: Record<string, unknown>): Promise<Registry> {
    const args = ["-m", "snooze.private_services", "--registry", registryPath, "--fleet-config", fleetConfigPath];
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const output = await runner(PYTHON, args, { cwd: supervisorCwd, timeoutMs, maxOutputBytes, signal: controller.signal }, JSON.stringify(input));
      if (Buffer.byteLength(output) > maxOutputBytes) throw new Error("private_services_output_too_large");
      let result: unknown; try { result = JSON.parse(output); } catch { throw new Error("private_services_response_invalid"); }
      if (record(result) && typeof result.error === "string") throw new Error(result.error);
      return validate(result);
    } finally { clearTimeout(timer); }
  }
  router.get("/admin/services", async (_req, res) => {
    try { return res.type("html").send(render(res.locals.base, res.locals.csrf, await invoke({ action: "read" }))); }
    catch { return res.status(503).type("html").send(page("Private services", `<main class="wrap">${adminNav(res.locals.base, "private-services")}<h1>Private services</h1><p>Private inventory is unavailable or invalid. Opening this page did not contact a gateway.</p></main>`)); }
  });
  router.post("/admin/services", async (req, res) => {
    if (req.get("origin") !== res.locals.origin) return res.status(403).json({ error: "same_origin_required" });
    if (!sessions.verifyCsrf(res.locals.token, req.body?._csrf)) return res.status(403).json({ error: "csrf_invalid" });
    const body = req.body as Record<string, unknown>;
    try {
      if (typeof body.revision !== "string" || !REVISION.test(body.revision) || typeof body.action !== "string") throw new Error("request_invalid");
      let input: Record<string, unknown>;
      if (body.action === "add") input = { action: "add", revision: body.revision, service: parseService(body) };
      else if (body.action === "update") {
        if (typeof body.targetId !== "string" || !ID.test(body.targetId)) throw new Error("service_id_invalid");
        input = { action: "update", revision: body.revision, targetId: body.targetId, service: parseService(body) };
      } else if (body.action === "remove" || body.action === "probe") {
        if (typeof body.targetId !== "string" || !ID.test(body.targetId)) throw new Error("service_id_invalid");
        input = { action: body.action, revision: body.revision, targetId: body.targetId };
      } else throw new Error("request_invalid");
      await invoke(input); return res.redirect(303, `${res.locals.base}/admin/services`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "private_services_failed";
      const status = message === "revision_conflict" ? 409 : message === "registry_locked" ? 423 : 400;
      const safe = new Set(["request_invalid", "revision_invalid", "revision_conflict", "service_id_invalid", "service_kind_invalid", "service_label_invalid", "service_host_invalid", "service_host_unapproved", "service_enabled_invalid", "service_exists", "service_not_found", "service_disabled", "fleet_host_not_enabled", "fleet_host_invalid", "fleet_config_unavailable", "probe_response_invalid", "backup_collision"]);
      return res.status(status).type("text").send(safe.has(message) ? message : "private_services_operation_failed");
    }
  });
  return { router };
}
