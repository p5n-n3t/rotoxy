import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

export const CLAUDE_CODE_MAX_PROMPT_BYTES = 128 * 1024;
export const CLAUDE_CODE_MAX_OUTPUT_BYTES = 1024 * 1024;
export const CLAUDE_CODE_DEFAULT_TIMEOUT_MS = 120_000;
export const CLAUDE_CODE_MAX_TIMEOUT_MS = 15 * 60_000;
export const CLAUDE_CODE_TERMINATION_GRACE_MS = 1_000;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BEDROCK_ENV_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
] as const;
export type ClaudeBedrockEnv = Partial<Record<(typeof BEDROCK_ENV_KEYS)[number], string>>;

export type ClaudeCodeJobErrorCode = "invalid_input" | "executable_not_allowed" | "cwd_not_allowed" | "spawn_failed" | "execution_ambiguous" | "cancelled_before_start" | "output_too_large" | "invalid_response" | "provider_error";

export class ClaudeCodeJobError extends Error {
  constructor(readonly code: ClaudeCodeJobErrorCode, readonly ambiguous = false) {
    super(code);
    this.name = "ClaudeCodeJobError";
  }
}

export interface ClaudeCodeJobRequest {
  executable: string;
  cwd: string;
  prompt: string;
  model?: string;
  /** Fresh sessions use this fixed UUID, or an ID is generated automatically. */
  sessionId?: string;
  /** Resume only a prior session explicitly bound by the caller. */
  resumeSessionId?: string;
  timeoutMs?: number;
}

export interface ClaudeCodeJobResult {
  sessionId: string;
  text: string;
  model?: string;
  usage?: Record<string, unknown>;
  costUsd?: number;
  stopReason?: string;
}

export interface ClaudeCodeSpawnHandle { readonly runId: string; readonly promise: Promise<ClaudeCodeJobResult>; cancel(): void }

export interface ClaudeCodeJobsOptions {
  /** Host policy ceiling per invocation; CLI enforcement is not a billing guarantee. */
  maxBudgetUsd?: number;
  /** Trusted server policy; defaults to read-only repository inspection. */
  tools?: readonly ("Read" | "Glob" | "Grep")[];
  /** Exact, trusted absolute executable paths installed by the host administrator. */
  allowedExecutables: readonly string[];
  /** Exact working directories for which the host administrator has granted execution. */
  allowedCwds: readonly string[];
  /** Only these explicit Bedrock settings can enter the child environment. */
  bedrockEnv?: ClaudeBedrockEnv;
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  terminationGraceMs?: number;
}

interface ActiveChild { child: ChildProcess; spawned: boolean; terminationTimer?: NodeJS.Timeout; cancel?: () => void }
type ClaudeJsonResult = {
  type?: unknown; subtype?: unknown; is_error?: unknown; result?: unknown;
  session_id?: unknown; model?: unknown; modelUsage?: unknown; usage?: unknown; total_cost_usd?: unknown; stop_reason?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeNonempty(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}

function environment(bedrockEnv: ClaudeBedrockEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: process.env.HOME || homedir(), PATH: process.env.PATH || "/usr/bin:/bin" };
  for (const name of ["TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "USER", "LOGNAME", "SystemRoot"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // Do not inherit arbitrary provider, proxy, or shell environment settings.
  for (const key of BEDROCK_ENV_KEYS) {
    const value = bedrockEnv[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

async function canonicalAllowedPath(candidate: string, allowlist: readonly string[], kind: "executable" | "cwd"): Promise<string> {
  if (!isAbsolute(candidate) || !allowlist.includes(candidate)) throw new ClaudeCodeJobError(kind === "executable" ? "executable_not_allowed" : "cwd_not_allowed");
  let actual: string;
  try { actual = await realpath(candidate); } catch { throw new ClaudeCodeJobError(kind === "executable" ? "executable_not_allowed" : "cwd_not_allowed"); }
  if (actual !== candidate || !allowlist.includes(actual)) throw new ClaudeCodeJobError(kind === "executable" ? "executable_not_allowed" : "cwd_not_allowed");
  let info;
  try { info = await stat(actual); } catch { throw new ClaudeCodeJobError(kind === "executable" ? "executable_not_allowed" : "cwd_not_allowed"); }
  if (kind === "cwd" ? !info.isDirectory() : !info.isFile()) throw new ClaudeCodeJobError(kind === "executable" ? "executable_not_allowed" : "cwd_not_allowed");
  return actual;
}

function parseJsonResult(output: string, expectedSessionId: string): ClaudeCodeJobResult {
  let value: ClaudeJsonResult;
  try {
    const parsed: unknown = JSON.parse(output);
    if (!isRecord(parsed)) throw new Error("shape");
    value = parsed as ClaudeJsonResult;
  } catch { throw new ClaudeCodeJobError("execution_ambiguous", true); }
  const sessionId = typeof value.session_id === "string" ? value.session_id : expectedSessionId;
  if (value.type !== "result" || value.subtype !== "success" || !SESSION_ID.test(sessionId) || typeof value.result !== "string" || value.is_error !== false) {
    throw new ClaudeCodeJobError("execution_ambiguous", true);
  }
  const result: ClaudeCodeJobResult = { sessionId, text: value.result };
  if (typeof value.model === "string" && value.model.length <= 200) result.model = value.model;
  else if (isRecord(value.modelUsage)) {
    const reportedModel = Object.keys(value.modelUsage).find(model => model.length > 0 && model.length <= 200);
    if (reportedModel) result.model = reportedModel;
  }
  if (isRecord(value.usage)) result.usage = value.usage;
  if (typeof value.total_cost_usd === "number" && Number.isFinite(value.total_cost_usd) && value.total_cost_usd >= 0) result.costUsd = value.total_cost_usd;
  if (typeof value.stop_reason === "string" && value.stop_reason.length <= 120) result.stopReason = value.stop_reason;
  return result;
}

/** Runs only allowlisted local Claude Code CLIs. It never retries an ambiguous execution. */
export class ClaudeCodeJobs {
  private readonly children = new Map<string, ActiveChild>();
  private readonly spawnProcess: NonNullable<ClaudeCodeJobsOptions["spawnProcess"]>;
  private readonly terminationGraceMs: number;

  constructor(private readonly options: ClaudeCodeJobsOptions) {
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
    this.terminationGraceMs = options.terminationGraceMs ?? CLAUDE_CODE_TERMINATION_GRACE_MS;
    if (!Number.isSafeInteger(this.terminationGraceMs) || this.terminationGraceMs < 50 || this.terminationGraceMs > 10_000) throw new TypeError("invalid termination grace");
    if(options.maxBudgetUsd!==undefined && (!Number.isFinite(options.maxBudgetUsd)||options.maxBudgetUsd<=0||options.maxBudgetUsd>5))throw new TypeError('invalid Claude budget');
    if(options.tools?.some(tool=>!["Read","Glob","Grep"].includes(tool)))throw new TypeError('invalid Claude tools');
    for (const candidate of [...options.allowedExecutables, ...options.allowedCwds]) if (!isAbsolute(candidate)) throw new TypeError("allowlisted paths must be absolute");
    for (const key of Object.keys(options.bedrockEnv ?? {})) if (!BEDROCK_ENV_KEYS.includes(key as (typeof BEDROCK_ENV_KEYS)[number])) throw new TypeError("unsupported Bedrock environment key");
  }

  start(request: ClaudeCodeJobRequest): ClaudeCodeSpawnHandle {
    const runId = randomUUID();
    let cancelRequested = false;
    let active: ActiveChild | undefined;
    const promise = this.execute(request, runId, () => cancelRequested, (value) => { active = value; });
    return {
      runId,
      promise,
      cancel: () => {
        cancelRequested = true;
        if (active?.spawned) active.cancel?.();
      },
    };
  }

  cancel(runId: string): boolean {
    const active = this.children.get(runId);
    if (!active?.spawned) return false;
    this.terminate(runId, active);
    return true;
  }

  private terminate(runId: string, active: ActiveChild): void {
    if (this.children.get(runId) !== active || active.terminationTimer) return;
    try { active.child.kill("SIGTERM"); } catch { /* Child identity remains the owned ChildProcess instance. */ }
    active.terminationTimer = setTimeout(() => {
      if (this.children.get(runId) !== active) return;
      try { active.child.kill("SIGKILL"); } catch { /* The process may already have exited. */ }
    }, this.terminationGraceMs);
    active.terminationTimer.unref?.();
  }

  private async execute(request: ClaudeCodeJobRequest, runId: string, isCancelled: () => boolean, setActive: (active: ActiveChild | undefined) => void): Promise<ClaudeCodeJobResult> {
    if (!request || typeof request.prompt !== "string" || request.prompt.length === 0 || request.prompt.includes("\0") || Buffer.byteLength(request.prompt, "utf8") > CLAUDE_CODE_MAX_PROMPT_BYTES ||
        (request.model !== undefined && !safeNonempty(request.model, 200)) ||
        (request.sessionId !== undefined && !SESSION_ID.test(request.sessionId)) ||
        (request.resumeSessionId !== undefined && !SESSION_ID.test(request.resumeSessionId)) ||
        (request.sessionId !== undefined && request.resumeSessionId !== undefined)) throw new ClaudeCodeJobError("invalid_input");
    const timeoutMs = request.timeoutMs ?? CLAUDE_CODE_DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > CLAUDE_CODE_MAX_TIMEOUT_MS) throw new ClaudeCodeJobError("invalid_input");
    if (isCancelled()) throw new ClaudeCodeJobError("cancelled_before_start");
    const [executable, cwd] = await Promise.all([
      canonicalAllowedPath(request.executable, this.options.allowedExecutables, "executable"),
      canonicalAllowedPath(request.cwd, this.options.allowedCwds, "cwd"),
    ]);
    if (isCancelled()) throw new ClaudeCodeJobError("cancelled_before_start");
    const sessionId = request.resumeSessionId ?? request.sessionId ?? randomUUID();
    // --bare prevents project hooks, MCP configuration, plugins, and keychain reads;
    // --permission-prompts none denies tools that would require interactive approval.
    const args = ["--bare", "--print", "--output-format", "json", "--permission-prompts", "none"];
    if(this.options.maxBudgetUsd!==undefined)args.push('--max-budget-usd',String(this.options.maxBudgetUsd));
    args.push('--tools',(this.options.tools??['Read','Glob','Grep']).join(','));
    if (request.model) args.push("--model", request.model);
    if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
    else args.push("--session-id", sessionId);
    let child: ChildProcess;
    try {
      child = this.spawnProcess(executable, args, { cwd, env: environment(this.options.bedrockEnv ?? {}), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch { throw new ClaudeCodeJobError("spawn_failed"); }
    const active: ActiveChild = { child, spawned: false };
    setActive(active);
    this.children.set(runId, active);
    return new Promise<ClaudeCodeJobResult>((resolve, reject) => {
      let output = "";
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: ClaudeCodeJobError, result?: ClaudeCodeJobResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve(result!);
      };
      const cleanup = () => {
        if (active.terminationTimer) clearTimeout(active.terminationTimer);
        this.children.delete(runId);
        setActive(undefined);
      };
      const timeout = setTimeout(() => {
        this.terminate(runId, active);
        finish(new ClaudeCodeJobError(active.spawned ? "execution_ambiguous" : "spawn_failed", active.spawned));
      }, timeoutMs);
      child.once("spawn", () => {
        active.spawned = true;
        active.cancel = () => {
          this.terminate(runId, active);
          finish(new ClaudeCodeJobError("execution_ambiguous", true));
        };
        if (isCancelled()) {
          this.terminate(runId, active);
          finish(new ClaudeCodeJobError("execution_ambiguous", true));
        }
      });
      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        outputBytes += Buffer.byteLength(text, "utf8");
        if (outputBytes > CLAUDE_CODE_MAX_OUTPUT_BYTES) {
          this.terminate(runId, active);
          finish(new ClaudeCodeJobError(active.spawned ? "execution_ambiguous" : "output_too_large", active.spawned));
          return;
        }
        output += text;
      });
      child.once("error", () => {
        const error = new ClaudeCodeJobError(active.spawned ? "execution_ambiguous" : "spawn_failed", active.spawned);
        if (active.spawned) this.terminate(runId, active);
        finish(error);
        if (!active.spawned) cleanup();
      });
      child.once("close", (code) => {
        cleanup();
        if (settled) return;
        if (!active.spawned || code !== 0) return finish(new ClaudeCodeJobError(active.spawned ? "execution_ambiguous" : "spawn_failed", active.spawned));
        try { finish(undefined, parseJsonResult(output, sessionId)); }
        catch (error) { finish(error instanceof ClaudeCodeJobError ? error : new ClaudeCodeJobError("execution_ambiguous", true)); }
      });
      child.stdin?.once("error", () => {
        if (active.spawned) this.terminate(runId, active);
        finish(new ClaudeCodeJobError(active.spawned ? "execution_ambiguous" : "spawn_failed", active.spawned));
      });
      try { child.stdin?.end(request.prompt, "utf8"); }
      catch { finish(new ClaudeCodeJobError(active.spawned ? "execution_ambiguous" : "spawn_failed", active.spawned)); }
    });
  }
}
