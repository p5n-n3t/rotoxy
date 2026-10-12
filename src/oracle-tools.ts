import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const ORACLE_MODELS = ["qwen3.5:9b", "gpt-oss:20b", "tev1:0.8b"] as const;
export const ORACLE_MAX_PROMPT_CHARS = 4000;
export const ORACLE_MAX_RESULT_BYTES = 16 * 1024;
export const ORACLE_MAX_STDOUT_BYTES = 64 * 1024;
export const ORACLE_MAX_BATCH_SIZE = 12;
export const ORACLE_MAX_BATCH_STDIN_BYTES = 512 * 1024;
export const ORACLE_COMMAND_TIMEOUT_MS = 8_000;

const PYTHON = "/usr/bin/python3";
const HOST_IDS = new Set(["ora1", "ora3", "ora5"]);
const TASK_STATES = new Set(["queued", "running", "complete", "failed", "ambiguous", "cancelled"]);
const SAFE_ERRORS = new Set([
  "queue_full", "retention_full_run_cleanup", "worker_disappeared", "timeout", "transport_exit",
  "invalid_response", "response_too_large", "ssh_unavailable", "invalid_catalog", "catalog_error",
  "generation_failed", "unsupported_config", "config_unavailable", "config_permissions_not_private",
  "task_inference_not_cancellable",
]);

export interface OracleToolDefinition {
  name: "oracle_catalog" | "oracle_submit" | "oracle_submit_batch" | "oracle_cancel" | "oracle_status" | "oracle_result";
  description: string;
  inputSchema: Record<string, unknown>;
}

const jobIdSchema = { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$" };
const batchItemSchema = {
  type: "object",
  properties: {
    jobId: jobIdSchema,
    prompt: { type: "string", minLength: 1, maxLength: ORACLE_MAX_PROMPT_CHARS },
    model: { type: "string", enum: [...ORACLE_MODELS] },
  },
  required: ["jobId", "prompt"], additionalProperties: false,
};

export const ORACLE_TOOL_DEFINITIONS: OracleToolDefinition[] = [
  {
    name: "oracle_catalog",
    description: "Read the cached allowlisted Oracle host/model catalog. This never refreshes the catalog or runs inference.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "oracle_submit",
    description: "Queue a bounded text prompt for the Oracle worker. Submission persists the task; inference runs later in the local worker, never during this call. Reuse jobId to safely retry the same request.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: jobIdSchema,
        prompt: { type: "string", minLength: 1, maxLength: ORACLE_MAX_PROMPT_CHARS },
        model: { type: "string", enum: [...ORACLE_MODELS] },
      },
      required: ["jobId", "prompt"], additionalProperties: false,
    },
  },
  {
    name: "oracle_submit_batch",
    description: "Atomically queue up to 12 independent bounded text prompts for Oracle workers. Every item is an indivisible task with its own stable jobId. The entire batch is accepted or rejected together; inference runs later in the local worker.",
    inputSchema: {
      type: "object",
      properties: { tasks: { type: "array", minItems: 1, maxItems: ORACLE_MAX_BATCH_SIZE, items: batchItemSchema } },
      required: ["tasks"], additionalProperties: false,
    },
  },
  {
    name: "oracle_cancel",
    description: "Cancel a queued Oracle task owned by this OAuth client. A running inference cannot be recalled and is reported as not cancellable.",
    inputSchema: { type: "object", properties: { jobId: jobIdSchema }, required: ["jobId"], additionalProperties: false },
  },
  {
    name: "oracle_status",
    description: "Read status and bounded usage metadata for a job submitted by this OAuth client.",
    inputSchema: { type: "object", properties: { jobId: jobIdSchema }, required: ["jobId"], additionalProperties: false },
  },
  {
    name: "oracle_result",
    description: "Read the bounded result only for a job submitted by this OAuth client. Results are available after the local worker completes the queued task.",
    inputSchema: { type: "object", properties: { jobId: jobIdSchema }, required: ["jobId"], additionalProperties: false },
  },
];

const TOOL_NAMES = new Set(ORACLE_TOOL_DEFINITIONS.map((tool) => tool.name));
export function isOracleToolName(name: unknown): name is OracleToolDefinition["name"] {
  return typeof name === "string" && TOOL_NAMES.has(name as OracleToolDefinition["name"]);
}

export function oracleToolRequiredScope(name: OracleToolDefinition["name"]): "jobs:read" | "jobs:write" {
  return name === "oracle_submit" || name === "oracle_submit_batch" || name === "oracle_cancel" ? "jobs:write" : "jobs:read";
}

export class OracleToolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OracleToolError";
  }
}

export interface OracleCommandRequest {
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  signal: AbortSignal;
}

export interface OracleCommandResult {
  exitCode: number;
  stdout: string;
  /** Intentionally discarded by the production runner and never surfaced. */
  stderr?: string;
}

export type OracleCommandRunner = (command: string, args: string[], request: OracleCommandRequest) => Promise<OracleCommandResult>;

export interface OracleToolsOptions {
  supervisorCwd?: string;
  configPath?: string;
  dbPath?: string;
  commandRunner?: OracleCommandRunner;
  timeoutMs?: number;
  maxStdoutBytes?: number;
}

const privatePoolDirectory = join(homedir(), ".local", "state", "token2oauth", "oracle-pool");

function defaultCommandRunner(command: string, args: string[], request: OracleCommandRequest): Promise<OracleCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (command !== PYTHON) return rejectPromise(new OracleToolError("command_not_allowed"));
    const child = spawn(command, args, { cwd: request.cwd, stdio: ["pipe", "pipe", "ignore"], shell: false, signal: request.signal });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let boundedOut = false;
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (boundedOut) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > request.maxStdoutBytes) {
        boundedOut = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(bytes);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => rejectPromise(new OracleToolError("command_unavailable")));
    child.on("close", (code) => {
      if (boundedOut) return rejectPromise(new OracleToolError("output_too_large"));
      resolvePromise({ exitCode: typeof code === "number" ? code : 1, stdout: Buffer.concat(chunks).toString("utf8") });
    });
    if (request.stdin !== undefined) child.stdin.end(request.stdin, "utf8");
    else child.stdin.end();
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertClosedKeys(value: unknown, required: string[], allowed: string[]): Record<string, unknown> {
  if (!isObject(value)) throw new OracleToolError("invalid_arguments");
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new OracleToolError("invalid_arguments");
  }
  return value;
}

function validExternalJobId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
}

function callerJobId(clientId: string, jobId: string): string {
  // 176 bits fit under the Python task-ID bound with the longest caller ID.
  const callerPrefix = createHash("sha256").update("oracle-mcp-client\0").update(clientId).digest("hex").slice(0, 44);
  return `o${callerPrefix}:${jobId}`;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeTaskError(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (SAFE_ERRORS.has(value)) return value;
  if (/^remote_http_[1-5][0-9]{2}$/.test(value)) return value;
  return "oracle_error";
}

function safeTaskMetadata(task: Record<string, unknown>, ownedId: string, externalId: string): Record<string, unknown> {
  if (task.id !== ownedId) throw new OracleToolError("job_not_found");
  if (typeof task.status !== "string" || !TASK_STATES.has(task.status) || typeof task.model !== "string" || !ORACLE_MODELS.includes(task.model as typeof ORACLE_MODELS[number])) {
    throw new OracleToolError("invalid_pool_response");
  }
  const host = typeof task.assigned_host === "string" && HOST_IDS.has(task.assigned_host) ? task.assigned_host : undefined;
  const actualModel = typeof task.actual_model === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(task.actual_model) ? task.actual_model : undefined;
  const attempts = finiteNonnegative(task.attempts);
  const promptTokens = finiteNonnegative(task.prompt_tokens);
  const evalTokens = finiteNonnegative(task.eval_tokens);
  const createdAt = finiteNonnegative(task.created);
  const updatedAt = finiteNonnegative(task.updated);
  const remoteSeconds = finiteNonnegative(task.remote_seconds);
  const elapsedSeconds = finiteNonnegative(task.elapsed_seconds);
  return {
    jobId: externalId,
    state: task.status,
    model: task.model,
    ...(host ? { host } : {}),
    ...(actualModel ? { actualModel } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(evalTokens !== undefined ? { evalTokens } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(remoteSeconds !== undefined ? { remoteSeconds } : {}),
    ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
    ...(safeTaskError(task.error_code) ? { errorCode: safeTaskError(task.error_code) } : {}),
  };
}

function validPrompt(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && [...value].length <= ORACLE_MAX_PROMPT_CHARS && !value.includes("\0");
}

function approvedModel(value: unknown): value is typeof ORACLE_MODELS[number] {
  return typeof value === "string" && ORACLE_MODELS.includes(value as typeof ORACLE_MODELS[number]);
}

function parseJson(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { throw new OracleToolError("invalid_pool_response"); }
}

/** Caller-isolated facade over the durable local Oracle queue. It never runs a worker. */
export class OracleTools {
  private readonly supervisorCwd: string;
  private readonly configPath: string;
  private readonly dbPath: string;
  private readonly commandRunner: OracleCommandRunner;
  private readonly timeoutMs: number;
  private readonly maxStdoutBytes: number;

  constructor(options: OracleToolsOptions = {}) {
    this.supervisorCwd = options.supervisorCwd ?? resolve(process.cwd(), "supervisor");
    this.configPath = options.configPath ?? join(privatePoolDirectory, "config.json");
    this.dbPath = options.dbPath ?? join(privatePoolDirectory, "queue.sqlite3");
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.timeoutMs = options.timeoutMs ?? ORACLE_COMMAND_TIMEOUT_MS;
    this.maxStdoutBytes = options.maxStdoutBytes ?? ORACLE_MAX_STDOUT_BYTES;
    if (![this.supervisorCwd, this.configPath, this.dbPath].every((path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0"))) {
      throw new OracleToolError("invalid_pool_paths");
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000 ||
        !Number.isInteger(this.maxStdoutBytes) || this.maxStdoutBytes < 1024 || this.maxStdoutBytes > 128 * 1024) {
      throw new OracleToolError("invalid_pool_bounds");
    }
  }

  async call(name: string, rawArgs: unknown, clientId: string): Promise<Record<string, unknown>> {
    if (!isOracleToolName(name)) throw new OracleToolError("unknown_tool");
    if (typeof clientId !== "string" || clientId.length < 1 || clientId.length > 512) throw new OracleToolError("invalid_caller");

    if (name === "oracle_catalog") {
      assertClosedKeys(rawArgs, [], []);
      const catalog = await this.invoke(["catalog"]);
      if (!isObject(catalog) || !Array.isArray(catalog.hosts)) throw new OracleToolError("invalid_pool_response");
      const hosts = catalog.hosts.flatMap((item) => {
        if (!isObject(item) || typeof item.id !== "string" || !HOST_IDS.has(item.id)) return [];
        const models = Array.isArray(item.models) ? item.models.filter((model): model is string => typeof model === "string" && ORACLE_MODELS.includes(model as typeof ORACLE_MODELS[number])) : [];
        const updatedAt = finiteNonnegative(item.updated);
        const errorCode = safeTaskError(item.error_code);
        return [{ host: item.id, models: [...new Set(models)], ...(updatedAt !== undefined ? { updatedAt } : {}), ...(errorCode ? { errorCode } : {}) }];
      });
      return { hosts };
    }

    if (name === "oracle_submit") {
      const args = assertClosedKeys(rawArgs, ["jobId", "prompt"], ["jobId", "prompt", "model"]);
      if (!validExternalJobId(args.jobId) || !validPrompt(args.prompt)) throw new OracleToolError("invalid_arguments");
      const model = args.model === undefined ? ORACLE_MODELS[0] : args.model;
      if (!approvedModel(model)) throw new OracleToolError("model_not_allowed");
      const ownedId = callerJobId(clientId, args.jobId);
      const task = await this.invoke(["submit", "--stdin", "--model", model, "--id", ownedId], args.prompt);
      if (!isObject(task)) throw new OracleToolError("invalid_pool_response");
      return safeTaskMetadata(task, ownedId, args.jobId);
    }

    if (name === "oracle_submit_batch") {
      const args = assertClosedKeys(rawArgs, ["tasks"], ["tasks"]);
      if (!Array.isArray(args.tasks) || args.tasks.length < 1 || args.tasks.length > ORACLE_MAX_BATCH_SIZE) {
        throw new OracleToolError("invalid_arguments");
      }
      const seenJobIds = new Set<string>();
      const ownedTasks = args.tasks.map((rawTask) => {
        const item = assertClosedKeys(rawTask, ["jobId", "prompt"], ["jobId", "prompt", "model"]);
        if (!validExternalJobId(item.jobId) || !validPrompt(item.prompt)) throw new OracleToolError("invalid_arguments");
        if (seenJobIds.has(item.jobId)) throw new OracleToolError("invalid_arguments");
        seenJobIds.add(item.jobId);
        const model = item.model === undefined ? ORACLE_MODELS[0] : item.model;
        if (!approvedModel(model)) throw new OracleToolError("model_not_allowed");
        return { externalId: item.jobId, ownedId: callerJobId(clientId, item.jobId), prompt: item.prompt, model };
      });
      const request = { tasks: ownedTasks.map((task) => ({ job_id: task.ownedId, text: task.prompt, model: task.model })) };
      const payload = JSON.stringify(request);
      if (Buffer.byteLength(payload, "utf8") > ORACLE_MAX_BATCH_STDIN_BYTES) throw new OracleToolError("batch_too_large");
      // One CLI invocation is essential: submit-batch must use one SQLite transaction.
      const response = await this.invoke(["submit-batch", "--stdin-json"], payload);
      if (!Array.isArray(response) || response.length !== ownedTasks.length) throw new OracleToolError("invalid_pool_response");
      const byId = new Map<string, Record<string, unknown>>();
      for (const task of response) {
        if (!isObject(task) || typeof task.id !== "string" || byId.has(task.id)) throw new OracleToolError("invalid_pool_response");
        byId.set(task.id, task);
      }
      return { tasks: ownedTasks.map((task) => safeTaskMetadata(byId.get(task.ownedId) ?? {}, task.ownedId, task.externalId)) };
    }

    if (name === "oracle_cancel") {
      const args = assertClosedKeys(rawArgs, ["jobId"], ["jobId"]);
      if (!validExternalJobId(args.jobId)) throw new OracleToolError("invalid_arguments");
      const ownedId = callerJobId(clientId, args.jobId);
      let response: unknown;
      try {
        response = await this.invoke(["cancel", "--id", ownedId]);
      } catch (error) {
        if (error instanceof OracleToolError && error.code === "task_inference_not_cancellable") {
          throw new OracleToolError("running_task_not_cancellable");
        }
        throw error;
      }
      if (!isObject(response) || response.id !== ownedId || typeof response.status !== "string" ||
          !TASK_STATES.has(response.status) || typeof response.cancelled !== "boolean") {
        throw new OracleToolError("invalid_pool_response");
      }
      return { jobId: args.jobId, state: response.status, cancelled: response.cancelled };
    }

    const args = assertClosedKeys(rawArgs, ["jobId"], ["jobId"]);
    if (!validExternalJobId(args.jobId)) throw new OracleToolError("invalid_arguments");
    const ownedId = callerJobId(clientId, args.jobId);
    const task = await this.invoke(["status", "--id", ownedId]);
    if (!isObject(task)) throw new OracleToolError("invalid_pool_response");
    const metadata = safeTaskMetadata(task, ownedId, args.jobId);
    if (name === "oracle_status") return metadata;
    const resultTask = await this.invoke(["results", "--id", ownedId]);
    if (!isObject(resultTask) || resultTask.id !== ownedId || resultTask.status !== task.status) throw new OracleToolError("invalid_pool_response");
    const result = resultTask.result;
    if (task.status === "complete") {
      if (typeof result !== "string" || Buffer.byteLength(result, "utf8") > ORACLE_MAX_RESULT_BYTES) throw new OracleToolError("invalid_pool_response");
      return { ...metadata, result };
    }
    return { ...metadata, result: null };
  }

  private async invoke(args: string[], stdin?: string): Promise<unknown> {
    const commandArgs = ["-m", "snooze.oracle_pool", "--config", this.configPath, "--db", this.dbPath, ...args];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new OracleToolError("command_timeout"));
      }, this.timeoutMs);
    });
    let result: OracleCommandResult;
    try {
      result = await Promise.race([this.commandRunner(PYTHON, commandArgs, {
        cwd: this.supervisorCwd, stdin, timeoutMs: this.timeoutMs,
        maxStdoutBytes: this.maxStdoutBytes, signal: controller.signal,
      }), timeout]);
    } catch (error) {
      if (error instanceof OracleToolError) throw error;
      throw new OracleToolError("command_failed");
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!result || !Number.isInteger(result.exitCode) || typeof result.stdout !== "string") throw new OracleToolError("invalid_pool_response");
    if (Buffer.byteLength(result.stdout, "utf8") > this.maxStdoutBytes) throw new OracleToolError("output_too_large");
    if (result.exitCode !== 0) {
      const parsed = (() => { try { return JSON.parse(result.stdout); } catch { return undefined; } })();
      if (isObject(parsed) && parsed.error === "task_not_found") throw new OracleToolError("job_not_found");
      if (isObject(parsed) && parsed.error === "Task ID already exists with different content") throw new OracleToolError("job_id_conflict");
      if (isObject(parsed) && typeof parsed.error === "string" && SAFE_ERRORS.has(parsed.error)) {
        throw new OracleToolError(parsed.error);
      }
      throw new OracleToolError("command_failed");
    }
    return parseJson(result.stdout);
  }
}
