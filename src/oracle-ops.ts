import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { adminNav, esc } from "./html.js";

/** Legacy empty-store inventory; configured and historical hosts are accepted dynamically below. */
export const ORACLE_OPS_HOSTS = ["ora1", "ora3", "ora5"] as const;
export const ORACLE_OPS_MODELS = ["qwen3.5:9b", "gpt-oss:20b", "tev1:0.8b"] as const;
export const ORACLE_OPS_MAX_PAGE_SIZE = 50;
export const ORACLE_OPS_MAX_OFFSET = 10_000;
export const ORACLE_OPS_MAX_OUTPUT_BYTES = 256 * 1024;

/** Host identities come from the validated private fleet registry. */
export type OracleOpsHost = string;
/** Model names are sourced from bounded configured/catalog/task snapshots, not a compiled enum. */
export type OracleOpsModel = string;

export interface OracleOpsHostSnapshot {
  host: OracleOpsHost;
  models: OracleOpsModel[];
  lastCatalogCheck: number | null;
  catalogCheckState: "checked" | "check_failed" | "never_checked" | "unknown";
  catalogError?: string;
  configured?: boolean;
  enabled?: boolean;
  provider?: string | null;
  assignedTasks: number;
  completedTasks: number;
  runningTasks: number;
}

export interface OracleOpsTaskSnapshot {
  status: string;
  model: OracleOpsModel | null;
  assignedHost: OracleOpsHost | null;
  createdAt: number | null;
  updatedAt: number | null;
  attempts: number | null;
  actualModel: OracleOpsModel | null;
  promptTokens: number | null;
  evalTokens: number | null;
  remoteSeconds: number | null;
  elapsedSeconds: number | null;
  errorCode: string | null;
}

export interface OracleOpsEventSnapshot {
  eventId: number;
  kind: string;
  at: number | null;
  status: string | null;
  host: OracleOpsHost | null;
  model: OracleOpsModel | null;
  actualModel: OracleOpsModel | null;
  errorCode: string | null;
}

export interface OracleOpsSnapshot {
  available: boolean;
  availabilityReason?: string;
  hosts: OracleOpsHostSnapshot[];
  summary: {
    totalTasks: number | null;
    taskCounts: Record<string, number> | null;
    completedLastHour: number | null;
    throughputWindowSeconds: number;
    promptTokens: { total: number | null; observations: number };
    evalTokens: { total: number | null; observations: number };
    assignmentDenominator: number | null;
    assignmentDistribution: { host: OracleOpsHost; count: number | null; share: number | null }[];
  };
  tasks: { items: OracleOpsTaskSnapshot[]; limit: number; offset: number; total: number | null; hasMore: boolean; nextOffset: number | null };
  events: { items: OracleOpsEventSnapshot[]; limit: number; after: number; nextCursor: number; hasMore: boolean };
  advisoryModel: { model: OracleOpsModel; availability: "available" | "unknown" };
}

export interface OracleOpsCommandRequest {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

export type OracleOpsCommandRunner = (command: string, args: string[], request: OracleOpsCommandRequest) => Promise<string>;

export interface OracleOpsLoaderOptions {
  /** Supplied by trusted server configuration, never by the HTTP query string. */
  supervisorCwd: string;
  /** Supplied by trusted server configuration; Python opens it read-only. */
  configPath: string;
  /** Supplied by trusted server configuration; Python opens it read-only. */
  dbPath: string;
  commandRunner?: OracleOpsCommandRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface OracleOpsPageOptions {
  limit?: number;
  offset?: number;
  afterEvent?: number;
}

export class OracleOpsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OracleOpsError";
  }
}

function defaultRunner(command: string, args: string[], request: OracleOpsCommandRequest): Promise<string> {
  if (command !== "/usr/bin/python3") return Promise.reject(new OracleOpsError("command_not_allowed"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: request.cwd, stdio: ["ignore", "pipe", "ignore"], shell: false, signal: request.signal });
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    child.stdout.on("data", (part: Buffer | string) => {
      if (tooLarge) return;
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += bytes.byteLength;
      if (size > request.maxOutputBytes) {
        tooLarge = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(bytes);
    });
    child.on("error", () => reject(new OracleOpsError("snapshot_unavailable")));
    child.on("close", (code) => {
      if (tooLarge) return reject(new OracleOpsError("snapshot_output_too_large"));
      if (code !== 0) return reject(new OracleOpsError("snapshot_unavailable"));
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{0,127}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,95}$/;
function validNullable(value: unknown, predicate: (item: unknown) => boolean): boolean { return value === null || predicate(value); }
function validCount(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0; }
function validMetric(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function validModel(value: unknown): boolean { return typeof value === "string" && MODEL_ID.test(value); }
function validHost(value: unknown): boolean { return typeof value === "string" && HOST_ID.test(value); }
function validSnapshot(value: unknown): value is OracleOpsSnapshot {
  if (!record(value) || typeof value.available !== "boolean" || !Array.isArray(value.hosts) || value.hosts.length > 128 ||
      !record(value.summary) || !record(value.tasks) || !record(value.events) || !record(value.advisoryModel)) return false;
  const hosts = value.hosts;
  if (!hosts.every((item) => record(item) && validHost(item.host) && Array.isArray(item.models) && item.models.length <= 128 &&
      item.models.every(validModel) && validNullable(item.lastCatalogCheck, validMetric) &&
      ["checked", "check_failed", "never_checked", "unknown"].includes(String(item.catalogCheckState)) &&
      validCount(item.assignedTasks) && validCount(item.completedTasks) && validCount(item.runningTasks) &&
      (item.catalogError === undefined || typeof item.catalogError === "string" && item.catalogError.length <= 96) &&
      (item.configured === undefined || typeof item.configured === "boolean") &&
      (item.enabled === undefined || typeof item.enabled === "boolean") &&
      (item.provider === undefined || item.provider === null || typeof item.provider === "string" && SAFE_LABEL.test(item.provider)))) return false;
  const summary = value.summary;
  const pagination = (row: Record<string, unknown>, keys: string[]) => keys.every((key) => validCount(row[key]));
  if (!validNullable(summary.totalTasks, validCount) || !validNullable(summary.completedLastHour, validCount) ||
      !validMetric(summary.throughputWindowSeconds) || !validNullable(summary.assignmentDenominator, validCount) ||
      !record(summary.promptTokens) || !validNullable(summary.promptTokens.total, validMetric) || !validCount(summary.promptTokens.observations) ||
      !record(summary.evalTokens) || !validNullable(summary.evalTokens.total, validMetric) || !validCount(summary.evalTokens.observations) ||
      !(summary.taskCounts === null || record(summary.taskCounts) && Object.values(summary.taskCounts).every(validCount)) ||
      !Array.isArray(summary.assignmentDistribution) || summary.assignmentDistribution.length > 128 ||
      !summary.assignmentDistribution.every((item) => record(item) && validHost(item.host) && validNullable(item.count, validCount) &&
        validNullable(item.share, (share) => typeof share === "number" && Number.isFinite(share) && share >= 0 && share <= 1))) return false;
  const tasks = value.tasks;
  if (!Array.isArray(tasks.items) || tasks.items.length > ORACLE_OPS_MAX_PAGE_SIZE || !pagination(tasks, ["limit", "offset"]) ||
      !validNullable(tasks.total, validCount) || typeof tasks.hasMore !== "boolean" || !validNullable(tasks.nextOffset, validCount) ||
      !tasks.items.every((item) => record(item) && typeof item.status === "string" && SAFE_LABEL.test(item.status) &&
        validNullable(item.model, validModel) && validNullable(item.actualModel, validModel) && validNullable(item.assignedHost, validHost) &&
        validNullable(item.createdAt, validMetric) && validNullable(item.updatedAt, validMetric) && validNullable(item.attempts, validCount) &&
        validNullable(item.promptTokens, validCount) && validNullable(item.evalTokens, validCount) && validNullable(item.remoteSeconds, validMetric) &&
        validNullable(item.elapsedSeconds, validMetric) && validNullable(item.errorCode, (code) => typeof code === "string" && SAFE_LABEL.test(code)))) return false;
  const events = value.events;
  if (!Array.isArray(events.items) || events.items.length > ORACLE_OPS_MAX_PAGE_SIZE || !pagination(events, ["limit", "after", "nextCursor"]) ||
      typeof events.hasMore !== "boolean" || !events.items.every((item) => record(item) && validCount(item.eventId) && Number(item.eventId) > 0 &&
        typeof item.kind === "string" && SAFE_LABEL.test(item.kind) && validNullable(item.at, validMetric) &&
        validNullable(item.status, (status) => typeof status === "string" && SAFE_LABEL.test(status)) &&
        validNullable(item.host, validHost) && validNullable(item.model, validModel) && validNullable(item.actualModel, validModel) &&
        validNullable(item.errorCode, (code) => typeof code === "string" && SAFE_LABEL.test(code)))) return false;
  return validModel(value.advisoryModel.model) && ["available", "unknown"].includes(String(value.advisoryModel.availability));
}

function boundedInteger(value: number | undefined, name: string, min: number, max: number, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new OracleOpsError(`invalid_${name}`);
  return result;
}

/** Read persisted state only. This never constructs StateStore or performs an SSH/model call. */
export async function loadOracleOpsSnapshot(
  options: OracleOpsLoaderOptions,
  page: OracleOpsPageOptions = {},
): Promise<OracleOpsSnapshot> {
  if (![options.supervisorCwd, options.configPath, options.dbPath].every((path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0"))) {
    throw new OracleOpsError("invalid_trusted_paths");
  }
  const limit = boundedInteger(page.limit, "limit", 1, ORACLE_OPS_MAX_PAGE_SIZE, 20);
  const offset = boundedInteger(page.offset, "offset", 0, ORACLE_OPS_MAX_OFFSET, 0);
  const afterEvent = boundedInteger(page.afterEvent, "event_cursor", 0, Number.MAX_SAFE_INTEGER, 0);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxOutputBytes = options.maxOutputBytes ?? ORACLE_OPS_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000 ||
      !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > ORACLE_OPS_MAX_OUTPUT_BYTES) {
    throw new OracleOpsError("invalid_bounds");
  }
  const args = ["-m", "snooze.oracle_ops", "--config", options.configPath, "--db", options.dbPath,
    "snapshot", "--limit", String(limit), "--offset", String(offset), "--after-event", String(afterEvent)];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new OracleOpsError("snapshot_timeout")); }, timeoutMs);
  });
  let stdout: string;
  try {
    stdout = await Promise.race([(options.commandRunner ?? defaultRunner)("/usr/bin/python3", args, {
      cwd: options.supervisorCwd, timeoutMs, maxOutputBytes, signal: controller.signal,
    }), timeout]);
  } catch (error) {
    if (error instanceof OracleOpsError) throw error;
    throw new OracleOpsError("snapshot_unavailable");
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes) throw new OracleOpsError("snapshot_output_too_large");
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new OracleOpsError("invalid_snapshot"); }
  if (!validSnapshot(parsed)) {
    throw new OracleOpsError("invalid_snapshot");
  }
  return parsed;
}

function timeLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unknown";
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "Unknown";
}

function metric(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "Unknown" : value.toLocaleString("en-US");
}

/** Pure HTML renderer compatible with ui-pages; every persisted string is escaped. */
export function renderOracleOpsPage(input: { base: string; snapshot: OracleOpsSnapshot }): string {
  const { base, snapshot } = input;
  const summary = snapshot.summary;
  const cards = [
    ["Queued", summary.taskCounts?.queued ?? null], ["Running", summary.taskCounts?.running ?? null],
    ["Completed", summary.taskCounts?.complete ?? null], ["Completed in last hour", summary.completedLastHour],
    ["Prompt tokens observed", summary.promptTokens.total], ["Evaluation tokens observed", summary.evalTokens.total],
  ].map(([label, value]) => `<div class="card"><div class="eyebrow">${esc(label)}</div><div class="metric">${esc(metric(value as number | null))}</div></div>`).join("");
  const pageStats = new Map<string, { completed: number; errors: number }>();
  for (const task of snapshot.tasks.items) if (task.assignedHost) {
    const stats = pageStats.get(task.assignedHost) ?? { completed: 0, errors: 0 };
    if (task.status === "complete") stats.completed++;
    if (task.errorCode !== null || task.status === "error" || task.status === "failed") stats.errors++;
    pageStats.set(task.assignedHost, stats);
  }
  const hosts = snapshot.hosts.map((host) => {
    const state = host.configured === undefined ? "Unknown" : host.configured ? host.enabled ? "Enabled" : "Disabled" : "Historical · unconfigured";
    const stats = pageStats.get(host.host) ?? { completed: 0, errors: 0 };
    const models = host.models.length ? host.models.map((model) => esc(model)).join("<br>") : "Unknown";
    const provider = host.provider ? esc(host.provider) : "Unknown";
    return `<tr><th scope="row"><strong>${esc(host.host)}</strong><div class="muted">Provider: ${provider}</div></th><td>${esc(state)}<div class="muted">Catalog: ${esc(host.catalogCheckState.replaceAll("_", " "))}</div></td><td><strong>${esc(timeLabel(host.lastCatalogCheck))}</strong>${host.catalogError ? `<div class="muted">${esc(host.catalogError)}</div>` : ""}</td><td class="oracle-models">${models}</td><td><strong>Running ${esc(metric(host.runningTasks))}</strong><div>Assigned ${esc(metric(host.assignedTasks))} · completed ${esc(metric(host.completedTasks))}</div><div class="muted">Utilization unknown: no stored host-slot capacity</div></td><td>${stats.completed} completed · ${stats.errors} ${stats.errors === 1 ? "error" : "errors"}<div class="muted">from this task page</div></td></tr>`;
  }).join("");
  const taskRows = snapshot.tasks.items.map((task) => `<tr><td>${esc(task.status)}</td><td>${esc(task.model ?? "Unknown")}</td><td>${esc(task.actualModel ?? "Unknown")}</td><td>${esc(task.assignedHost ?? "Unassigned")}</td><td>${esc(timeLabel(task.updatedAt))}</td><td>${esc(metric(task.promptTokens))}</td><td>${esc(metric(task.evalTokens))}</td><td>${esc(task.errorCode ?? "—")}</td></tr>`).join("");
  const eventRows = snapshot.events.items.map((event) => `<tr><td>${esc(timeLabel(event.at))}</td><td>${esc(event.kind)}</td><td>${esc(event.status ?? "Unknown")}</td><td>${esc(event.host ?? "Unknown")}</td><td>${esc(event.model ?? "Unknown")}</td><td>${esc(event.actualModel ?? "Unknown")}</td></tr>`).join("");
  const taskLinks = `${snapshot.tasks.offset > 0 ? `<a class="btn secondary" href="${esc(base)}/admin/oracle?offset=${Math.max(0, snapshot.tasks.offset - snapshot.tasks.limit)}&amp;afterEvent=${snapshot.events.after}">Previous tasks</a>` : ""}${snapshot.tasks.hasMore && snapshot.tasks.nextOffset !== null ? `<a class="btn secondary" href="${esc(base)}/admin/oracle?offset=${snapshot.tasks.nextOffset}&amp;afterEvent=${snapshot.events.after}">Next tasks</a>` : ""}`;
  const eventLink = snapshot.events.hasMore ? `<a class="btn secondary" href="${esc(base)}/admin/oracle?offset=${snapshot.tasks.offset}&amp;afterEvent=${snapshot.events.nextCursor}">Next events</a>` : "";
  const availability = snapshot.available ? "Persisted local Oracle pool data; catalog checks are historical and this page performs no SSH probes or inference." : "Oracle pool data is unavailable. Metrics remain unknown; zero activity is not inferred.";
  const navLinks = `<nav class="oracle-ops-links" aria-label="Oracle operations"><a class="btn secondary" href="${esc(base)}/admin/oracle/fleet">Fleet configuration</a><a class="btn secondary" href="${esc(base)}/admin/oracle/models">Model policies</a><a class="btn secondary" href="${esc(base)}/admin/services">Service status</a></nav>`;
  return `<style>.oracle-ops-links{display:flex;flex-wrap:wrap;gap:.75rem;margin:1rem 0}.oracle-ops-table-wrap{overflow:auto;margin-top:1rem}.oracle-ops-table{width:100%;min-width:1050px;border-collapse:collapse}.oracle-ops-table th,.oracle-ops-table td{padding:.9rem 1rem;text-align:left;vertical-align:top;border-bottom:1px solid var(--border,#d5dbe4);line-height:1.45}.oracle-ops-table th{font-weight:600}.oracle-models{min-width:190px;overflow-wrap:anywhere;white-space:normal}@media(max-width:700px){.oracle-ops-table{min-width:980px}}</style><main class="wrap">${adminNav(base, "oracle")}<section class="grid"><div class="card full"><div class="eyebrow">ROTOXY · Operations</div><h1>Oracle pool</h1>${navLinks}<p class="muted">${esc(availability)}</p>${!snapshot.available ? `<p class="flash">${esc(snapshot.availabilityReason ?? "pool_state_unavailable")}</p>` : ""}<p>Lightweight advisory model <strong>${esc(snapshot.advisoryModel.model)}</strong>: ${esc(snapshot.advisoryModel.availability)} from the persisted catalog snapshot. Requested and reported models are shown separately below.</p></div>${cards}<div class="card full"><div class="eyebrow">Fleet status</div><h2>Hosts, catalog and workload</h2><div class="oracle-ops-table-wrap"><table class="oracle-ops-table"><thead><tr><th>Host / provider</th><th>Configured state</th><th>Last catalog check</th><th>Exact catalog models</th><th>Workload / capacity</th><th>Task-page sample</th></tr></thead><tbody>${hosts || '<tr><td colspan="6">No host observations are available.</td></tr>'}</tbody></table></div><p class="tiny muted">Host running and assigned counts are persisted values. Capacity utilization stays unknown because this snapshot contains no host-slot denominator. Per-host completed/error counts are limited to the visible task page; assignment shares use ${esc(metric(summary.assignmentDenominator))} persisted assignments and remain unknown without a denominator.</p>${summary.assignmentDistribution.map((host) => `<p><strong>${esc(host.host)}:</strong> ${esc(metric(host.count))} assignments · ${host.share === null ? "share unknown" : esc((host.share * 100).toFixed(1) + "%")}</p>`).join("")}</div><div class="card full"><div class="eyebrow">Recent tasks</div><p class="muted tiny">Prompts, results, task identifiers and source references are omitted.</p><div style="overflow:auto"><table><thead><tr><th>Status</th><th>Requested model</th><th>Reported model</th><th>Assigned host</th><th>Updated</th><th>Prompt tokens</th><th>Evaluation tokens</th><th>Safe error</th></tr></thead><tbody>${taskRows || '<tr><td colspan="8">No task rows on this page.</td></tr>'}</tbody></table></div><p>${taskLinks}</p></div><div class="card full"><div class="eyebrow">Recent events</div><div style="overflow:auto"><table><thead><tr><th>Time</th><th>Event</th><th>Status</th><th>Host</th><th>Requested model</th><th>Reported model</th></tr></thead><tbody>${eventRows || '<tr><td colspan="6">No events on this page.</td></tr>'}</tbody></table></div><p>${eventLink}</p></div></section></main>`;
}
