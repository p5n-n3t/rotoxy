import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { adminNav, esc } from "./html.js";

export const ORACLE_OPS_HOSTS = ["ora1", "ora3", "ora5"] as const;
export const ORACLE_OPS_MODELS = ["qwen3.5:9b", "gpt-oss:20b", "tev1:0.8b"] as const;
export const ORACLE_OPS_MAX_PAGE_SIZE = 50;
export const ORACLE_OPS_MAX_OFFSET = 10_000;
export const ORACLE_OPS_MAX_OUTPUT_BYTES = 256 * 1024;

/** Host identities come from the validated private fleet registry. */
export type OracleOpsHost = string;
export type OracleOpsModel = typeof ORACLE_OPS_MODELS[number];

export interface OracleOpsHostSnapshot {
  host: OracleOpsHost;
  models: OracleOpsModel[];
  lastCatalogCheck: number | null;
  catalogCheckState: "checked" | "check_failed" | "never_checked" | "unknown";
  catalogError?: string;
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
  advisoryModel: { model: "tev1:0.8b"; availability: "available" | "unknown" };
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
  if (!record(parsed) || typeof parsed.available !== "boolean" || !Array.isArray(parsed.hosts) ||
      !record(parsed.summary) || !record(parsed.tasks) || !record(parsed.events) || !record(parsed.advisoryModel)) {
    throw new OracleOpsError("invalid_snapshot");
  }
  return parsed as unknown as OracleOpsSnapshot;
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
  const hosts = snapshot.hosts.map((host) => `<article class="card"><div class="eyebrow">Oracle host</div><h2>${esc(host.host)}</h2><p><strong>Last catalog check:</strong> ${esc(timeLabel(host.lastCatalogCheck))} · ${esc(host.catalogCheckState.replaceAll("_", " "))}</p>${host.catalogError ? `<p class="muted">Check detail: ${esc(host.catalogError)}</p>` : ""}<p><strong>Models reported:</strong> ${host.models.length ? host.models.map(esc).join(" · ") : "Unknown"}</p><p><strong>Assigned tasks:</strong> ${esc(metric(host.assignedTasks))} · <strong>Completed:</strong> ${esc(metric(host.completedTasks))} · <strong>Running:</strong> ${esc(metric(host.runningTasks))}</p></article>`).join("");
  const taskRows = snapshot.tasks.items.map((task) => `<tr><td>${esc(task.status)}</td><td>${esc(task.model ?? "Unknown")}</td><td>${esc(task.assignedHost ?? "Unassigned")}</td><td>${esc(timeLabel(task.updatedAt))}</td><td>${esc(metric(task.promptTokens))}</td><td>${esc(metric(task.evalTokens))}</td><td>${esc(task.errorCode ?? "—")}</td></tr>`).join("");
  const eventRows = snapshot.events.items.map((event) => `<tr><td>${esc(timeLabel(event.at))}</td><td>${esc(event.kind)}</td><td>${esc(event.status ?? "Unknown")}</td><td>${esc(event.host ?? "Unknown")}</td><td>${esc(event.model ?? "Unknown")}</td></tr>`).join("");
  const taskLinks = `${snapshot.tasks.offset > 0 ? `<a class="btn secondary" href="${esc(base)}/admin/oracle?offset=${Math.max(0, snapshot.tasks.offset - snapshot.tasks.limit)}&amp;afterEvent=${snapshot.events.after}">Previous tasks</a>` : ""}${snapshot.tasks.hasMore && snapshot.tasks.nextOffset !== null ? `<a class="btn secondary" href="${esc(base)}/admin/oracle?offset=${snapshot.tasks.nextOffset}&amp;afterEvent=${snapshot.events.after}">Next tasks</a>` : ""}`;
  const eventLink = snapshot.events.hasMore ? `<a class="btn secondary" href="${esc(base)}/admin/oracle?offset=${snapshot.tasks.offset}&amp;afterEvent=${snapshot.events.nextCursor}">Next events</a>` : "";
  const availability = snapshot.available ? "Persisted local Oracle pool data; catalog checks are historical and this page performs no SSH probes or inference." : "Oracle pool data is unavailable. Metrics remain unknown; zero activity is not inferred.";
  return `<main class="wrap">${adminNav(base, "oracle")}<section class="grid"><div class="card full"><div class="eyebrow">ROTOXY · Operations</div><h1>Oracle pool</h1><p><a href="${esc(base)}/admin/oracle/fleet">Manage hosts and model policies →</a></p><p class="muted">${esc(availability)}</p>${!snapshot.available ? `<p class="flash">${esc(snapshot.availabilityReason ?? "pool_state_unavailable")}</p>` : ""}<p>Lightweight advisory model <strong>tev1:0.8b</strong>: ${esc(snapshot.advisoryModel.availability)} according to the cached catalog. Actual assignments are shown from task rows.</p></div>${cards}<div class="card full"><div class="eyebrow">Fixed hosts</div><h2>Catalog and utilization</h2><div class="grid">${hosts}</div><p class="tiny muted">Assignment shares use ${esc(metric(summary.assignmentDenominator))} persisted rows with a recognized assigned host as the denominator; shares are unknown when there are no assignments.</p>${summary.assignmentDistribution.map((host) => `<p><strong>${esc(host.host)}:</strong> ${esc(metric(host.count))} assignments · ${host.share === null ? "share unknown" : esc((host.share * 100).toFixed(1) + "%")}</p>`).join("")}</div><div class="card full"><div class="eyebrow">Recent tasks</div><p class="muted tiny">Prompts, results, task identifiers and source references are omitted.</p><div style="overflow:auto"><table><thead><tr><th>Status</th><th>Requested model</th><th>Assigned host</th><th>Updated</th><th>Prompt tokens</th><th>Evaluation tokens</th><th>Safe error</th></tr></thead><tbody>${taskRows || '<tr><td colspan="7">No task rows on this page.</td></tr>'}</tbody></table></div><p>${taskLinks}</p></div><div class="card full"><div class="eyebrow">Recent events</div><div style="overflow:auto"><table><thead><tr><th>Time</th><th>Event</th><th>Status</th><th>Host</th><th>Model</th></tr></thead><tbody>${eventRows || '<tr><td colspan="5">No events on this page.</td></tr>'}</tbody></table></div><p>${eventLink}</p></div></section></main>`;
}
