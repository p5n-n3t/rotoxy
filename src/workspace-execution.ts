import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { StateStore } from "./store.js";
import type { SupervisorBackend, SupervisorCaller } from "./supervisor-api.js";
import { JOB_TOOL_DEFINITIONS, validateJobSubmission, type JobSubmission } from "./job-submit.js";

const PYTHON = "/usr/bin/python3";
const CWD = fileURLToPath(new URL("../supervisor/", import.meta.url));
const MAX_IO = 2_000_000;
const MAX_RESULT_BYTES = 512 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type WorkspaceExecutionToolName = "workspace_dispatch" | "workspace_sync";
export const WORKSPACE_EXECUTION_TOOLS = Object.freeze([
  { name: "workspace_dispatch", description: "Publish one bounded job DAG to this project's collaborators as task metadata. Prompt text stays owner-private; only the submitting OAuth client can reconcile provider results.", inputSchema: JOB_TOOL_DEFINITIONS[0].inputSchema },
  { name: "workspace_sync", description: "Reconcile an execution previously published by this OAuth client. Reads owner-scoped job status and results; never resubmits.", inputSchema: { type: "object", additionalProperties: false, required: ["projectId", "jobId"], properties: { projectId: { type: "string", maxLength: 128 }, jobId: { type: "string", maxLength: 128 } } } },
] as const);

export function isWorkspaceExecutionToolName(name: unknown): name is WorkspaceExecutionToolName {
  return name === "workspace_dispatch" || name === "workspace_sync";
}
export function workspaceExecutionRequiredScope(_name: WorkspaceExecutionToolName): "jobs:write" { return "jobs:write"; }

export class WorkspaceExecutionError extends Error {
  constructor(readonly code: "invalid_input" | "execution_not_found" | "idempotency_conflict" | "supervisor_unavailable" | "ledger_unavailable" | "bridge_timeout" | "bridge_output_invalid") { super(code); }
}

export type WorkspaceExecutionSummary = { projectId: string; jobId: string; state: string; provider: "lightsprint"; taskCount: number; createdAt: number; updatedAt: number };
type LedgerRunner = (executable: string, args: string[], stdin: string, options: { cwd: string; timeoutMs: number; maxStdoutBytes: number }) => Promise<string>;
export interface WorkspaceExecutionOptions { runner?: LedgerRunner }

function isObject(v: unknown): v is Record<string, any> { return !!v && typeof v === "object" && !Array.isArray(v); }
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
function safeId(v: unknown): v is string { return typeof v === "string" && SAFE_ID.test(v); }
function workspaceId(kind: string, projectId: string, clientId: string, sourceId: string): string {
  return "ws-" + createHash("sha256").update(`rotoxy:workspace:${kind}:v1\0${projectId}\0${clientId}\0${sourceId}`).digest("hex").slice(0, 48);
}
function safeProviderError(error: unknown): string {
  let value = error instanceof Error ? error.message : "provider operation failed";
  value = value.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|lsat_[A-Za-z0-9_-]+)\b/g, "[REDACTED]")
    .replace(/(token|api[_-]?key|secret|password)=([^\s&]+)/gi, "$1=[REDACTED]");
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300) || "provider operation failed";
}
function remoteState(value: unknown): string {
  if (!isObject(value)) return "unknown";
  const raw = value.state ?? value.status;
  if (typeof raw !== "string") return "unknown";
  const lower = raw.toLowerCase();
  if (["draft", "queued", "running", "held", "paused", "emergency_stopped", "complete", "completed", "failed", "cancelled", "pending"].includes(lower)) return lower;
  return "unknown";
}

async function runPython(executable: string, args: string[], stdin: string, options: { cwd: string; timeoutMs: number; maxStdoutBytes: number }): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const buffers: Buffer[] = []; let size = 0; let done = false;
    const finish = (error?: Error, output?: string) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolvePromise(output ?? ""); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new WorkspaceExecutionError("bridge_timeout")); }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > options.maxStdoutBytes) { child.kill("SIGKILL"); finish(new WorkspaceExecutionError("bridge_output_invalid")); } else buffers.push(Buffer.from(chunk)); });
    child.on("error", () => finish(new WorkspaceExecutionError("ledger_unavailable")));
    child.on("close", code => { const output = Buffer.concat(buffers).toString("utf8"); if (code !== 0) { try { const failure = JSON.parse(output); const allowed = ["execution_not_found", "idempotency_conflict", "invalid_input", "invalid_owner", "invalid_request", "invalid_state"]; finish(new WorkspaceExecutionError(allowed.includes(failure.error) ? failure.error : "ledger_unavailable")); } catch { finish(new WorkspaceExecutionError("ledger_unavailable")); } } else finish(undefined, output); });
    child.stdin.on("error", () => finish(new WorkspaceExecutionError("ledger_unavailable")));
    child.stdin.end(stdin);
  });
}

/** Durable intent + owner-scoped bridge operations; no provider credentials or alternate launcher. */
export class WorkspaceExecutionService {
  private readonly runner: LedgerRunner;
  constructor(private readonly store: StateStore, private readonly backend?: SupervisorBackend, options: WorkspaceExecutionOptions = {}) { this.runner = options.runner ?? runPython; }

  private async ledger<T>(request: Record<string, unknown>): Promise<T> {
    const db = resolve(this.store.dir, "agent-workspace.sqlite3");
    let output: string;
    try { output = await this.runner(PYTHON, ["-m", "snooze.workspace_execution", "--db", db], JSON.stringify(request), { cwd: CWD, timeoutMs: 10_000, maxStdoutBytes: MAX_IO }); }
    catch (error) { if (error instanceof WorkspaceExecutionError) throw error; throw new WorkspaceExecutionError("ledger_unavailable"); }
    if (Buffer.byteLength(output) > MAX_IO) throw new WorkspaceExecutionError("bridge_output_invalid");
    try { const value = JSON.parse(output); if (!isObject(value)) throw new Error(); return value as T; } catch { throw new WorkspaceExecutionError("bridge_output_invalid"); }
  }

  async summaries(projectId: string): Promise<WorkspaceExecutionSummary[]> {
    const result = await this.ledger<{ executions?: WorkspaceExecutionSummary[] }>({ command: "list", projectId });
    return Array.isArray(result.executions) ? result.executions.filter(row => isObject(row) && row.projectId === projectId && safeId(row.jobId)).slice(0, 100) : [];
  }

  async dispatch(raw: unknown, caller: SupervisorCaller): Promise<{ dispatch: WorkspaceExecutionSummary; accepted: boolean; replayed: boolean; providerError?: string }> {
    if (!this.backend) throw new WorkspaceExecutionError("supervisor_unavailable");
    const submission = validateJobSubmission(raw);
    if (submission.projectId !== caller.projectId || !safeId(caller.clientId)) throw new WorkspaceExecutionError("invalid_input");
    await this.backend.authorizeWorkspace?.(caller.projectId, caller.clientId);
    const requestHash = createHash("sha256").update(canonical(submission)).digest("hex");
    const remoteJobId = workspaceId("job", caller.projectId, caller.clientId, submission.jobId);
    const remoteIdempotencyKey = workspaceId("idem", caller.projectId, caller.clientId, submission.idempotencyKey);
    const remoteSubmission: JobSubmission = { ...submission, jobId: remoteJobId, idempotencyKey: remoteIdempotencyKey };
    const reservation = await this.ledger<{ created: boolean; shouldSubmit: boolean; dispatch: WorkspaceExecutionSummary }>({
      command: "reserve", projectId: caller.projectId, jobId: submission.jobId, remoteJobId, clientId: caller.clientId,
      actor: `client:${caller.clientId}`, idempotencyKey: submission.idempotencyKey, remoteIdempotencyKey, requestHash, submission, remoteSubmission,
    });
    if (!reservation.shouldSubmit) {
      const dispatch = reservation.dispatch.state === "pending" ? await this.setState(caller, submission.jobId, "needs_reconciliation") : reservation.dispatch;
      return { dispatch, accepted: ["accepted", "queued", "running", "held", "blocked", "complete", "completed"].includes(dispatch.state), replayed: true };
    }
    try { await this.backend.callTool("job_submit", remoteSubmission, caller); }
    catch (error) {
      const state = await this.setState(caller, submission.jobId, "needs_reconciliation");
      return { dispatch: state, accepted: false, replayed: false, providerError: safeProviderError(error) };
    }
    const state = await this.setState(caller, submission.jobId, "accepted");
    return { dispatch: state, accepted: true, replayed: false };
  }

  async getOwned(projectId: string, jobId: string, clientId: string): Promise<{ dispatch: WorkspaceExecutionSummary; submission: JobSubmission; remoteJobId: string; actor: string }> {
    return this.ledger({ command: "get", projectId, jobId, clientId });
  }

  async sync(projectId: string, jobId: string, caller: SupervisorCaller): Promise<{ dispatch: WorkspaceExecutionSummary; status: { state: string; revision?: number; error?: string; tasks: { taskId: string; state?: string; error?: string }[] }; results: { taskId: string; text: string; truncated?: boolean; reportedModel?: string; assistantAt?: number }[]; resultsUnavailable: boolean; resultsTruncated: boolean; resultError?: string }> {
    if (!this.backend || projectId !== caller.projectId || !safeId(jobId) || !safeId(caller.clientId)) throw new WorkspaceExecutionError("invalid_input");
    await this.backend.authorizeWorkspace?.(projectId, caller.clientId);
    const binding = await this.getOwned(projectId, jobId, caller.clientId);
    let rawStatus: unknown;
    try { rawStatus = await this.backend.callTool("job_status", { projectId, jobId: binding.remoteJobId }, caller); }
    catch (error) { const dispatch = await this.setState(caller, jobId, "needs_reconciliation"); return { dispatch, status: { state: "unknown", error: safeProviderError(error), tasks: [] }, results: [], resultsUnavailable: true, resultsTruncated: false }; }
    const state = remoteState(rawStatus);
    const dispatch = await this.setState(caller, jobId, state);
    const statusObj = isObject(rawStatus) ? rawStatus : {};
    const allowedTasks = new Set(binding.submission.tasks.map(task => task.taskId));
    const taskRows = Array.isArray(statusObj.tasks) ? statusObj.tasks.filter(isObject).slice(0, 100).map(task => ({ taskId: String(task.taskId ?? task.task_id ?? "").slice(0, 128), ...(typeof task.state === "string" ? { state: task.state.slice(0, 32) } : {}), ...(typeof task.error === "string" ? { error: safeProviderError(new Error(task.error)) } : {}) })).filter(task => safeId(task.taskId) && allowedTasks.has(task.taskId)) : [];
    let results: { taskId: string; text: string; reportedModel?: string; assistantAt?: number }[] = [];
    let resultsUnavailable = false;
    let resultsTruncated = false;
    let resultError: string | undefined;
    try {
      const rawResults = await this.backend.callTool("job_results", { projectId, jobId: binding.remoteJobId }, caller);
      const list = isObject(rawResults) && Array.isArray(rawResults.results) ? rawResults.results : [];
      let resultBytes = 0;
      results = list.filter(isObject).slice(0, 100).flatMap(item => {
        const taskId = item.taskId ?? item.task_id;
        if (!safeId(taskId) || !allowedTasks.has(taskId) || typeof item.text !== "string") return [];
        const room = MAX_RESULT_BYTES - resultBytes;
        if (room <= 0) { resultsTruncated = true; return []; }
        const bytes = Buffer.from(item.text, "utf8");
        const kept = bytes.length > room ? bytes.subarray(0, room).toString("utf8") : item.text;
        resultBytes += Buffer.byteLength(kept, "utf8");
        const truncated = kept.length < item.text.length;
        if (truncated) resultsTruncated = true;
        return [{ taskId, text: kept, ...(truncated ? { truncated: true } : {}), ...(typeof item.reportedModel === "string" ? { reportedModel: item.reportedModel.slice(0, 128) } : {}), ...(Number.isFinite(item.assistantAt) ? { assistantAt: Number(item.assistantAt) } : {}) }];
      });
    } catch (error) { resultsUnavailable = true; resultError = safeProviderError(error); /* status is still useful; result read stays owner scoped */ }
    return { dispatch, status: { state, ...(Number.isSafeInteger(statusObj.revision) ? { revision: statusObj.revision } : {}), ...(typeof statusObj.error === "string" ? { error: safeProviderError(new Error(statusObj.error)) } : {}), tasks: taskRows }, results, resultsUnavailable, resultsTruncated, ...(resultError ? { resultError } : {}) };
  }

  private setState(caller: SupervisorCaller, jobId: string, state: string): Promise<WorkspaceExecutionSummary> {
    return this.ledger({ command: "set_state", projectId: caller.projectId, jobId, clientId: caller.clientId, state: STATES.has(state) ? state : "unknown" });
  }
}
const STATES = new Set(["pending", "accepted", "needs_reconciliation", "draft", "queued", "running", "held", "paused", "emergency_stopped", "complete", "completed", "blocked", "failed", "cancelled", "unknown"]);
