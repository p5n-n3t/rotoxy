import { createHash } from "node:crypto";
import type { ClaudeTaskDispatch, ClaudeTaskDispatchHandle } from "./claude-task-dispatch.js";
import type { SupervisorCaller } from "./supervisor-api.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLIENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+/@-]{0,159}$/;
const MAX_TASK_TEXT_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 16 * 1024;

export type ClaudeWorkspaceTask = {
  projectId: string;
  taskId: string;
  title: string;
  description?: string;
  state: "queued" | "running" | "blocked" | "review" | "complete" | "failed" | "cancelled";
};

/** Must authorize caller membership and return this task from the private workspace ledger. */
export interface ClaudeWorkspaceTaskSource {
  resolveOwnedTask(input: { projectId: string; taskId: string; caller: SupervisorCaller }): Promise<ClaudeWorkspaceTask | undefined>;
  /** Must atomically claim this queued task for the authenticated owner. */
  claimTask(input: { projectId: string; taskId: string; caller: SupervisorCaller; attemptId: string }): Promise<void>;
  /** Must idempotently publish the bounded result as this task's review artifact. */
  publishResult(input: {
    projectId: string; taskId: string; caller: SupervisorCaller; attemptId: string;
    text: string; modelReported?: string; costUsd?: number;
  }): Promise<{ artifactId: string }>;
}

export type ClaudeWorkspaceAttemptStatus = "intent" | "running" | "success" | "ambiguous" | "error" | "artifact_failed";
export interface ClaudeWorkspaceAttemptLedger {
  /** Atomically inserts the intent under the existing unique (project, task) attempt key. */
  reserve(input: {
    projectId: string; taskId: string; ownerClientId: string; profileId: string;
    modelRequested: string; promptDigest: string;
  }): Promise<{ created: boolean; attemptId: string; status: ClaudeWorkspaceAttemptStatus }>;
  /** Updates the same private SQLite attempt row; never starts or retries provider work. */
  update(input: {
    attemptId: string; status: Exclude<ClaudeWorkspaceAttemptStatus, "intent">;
    modelReported?: string; costUsd?: number; result?: string;
  }): Promise<void>;
}

export type ClaudeWorkspaceDispatchResult = {
  accepted: boolean;
  replayed: boolean;
  attemptId?: string;
  state: ClaudeWorkspaceAttemptStatus | "task_unavailable" | "task_not_claimable";
  artifactId?: string;
};

export class ClaudeWorkspaceDispatchError extends Error {
  constructor(readonly code: "invalid_input" | "workspace_unavailable" | "attempt_ledger_unavailable" | "dispatch_unavailable") {
    super(code); this.name = "ClaudeWorkspaceDispatchError";
  }
}

function isSafeText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= MAX_TASK_TEXT_BYTES;
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maxBytes ? value : bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

function cleanResult(value: string): string {
  return boundedText(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, " ")
    .replace(/\bBasic\s+[A-Za-z0-9+/=_-]{4,}/gi, "Basic [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/("(?:access_token|refresh_token|api_key|password|secret)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED]")
    .replace(/\blsat_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\b((?:access_|refresh_)?token|api[_-]?key|password|secret)=([^\s&]+)/gi, "$1=[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[REDACTED]").trim(), MAX_RESULT_BYTES);
}

function safeCode(error: unknown): { ambiguous: boolean; code: string } {
  if (error && typeof error === "object") {
    const candidate = error as { ambiguous?: unknown; code?: unknown; message?: unknown };
    const raw = typeof candidate.code === "string" ? candidate.code : typeof candidate.message === "string" ? candidate.message : "";
    const code = /^[a-z_]{1,48}$/.test(raw) ? raw : "provider_operation_failed";
    return { ambiguous: candidate.ambiguous === true, code };
  }
  return { ambiguous: false, code: "provider_operation_failed" };
}

function safeModel(value: unknown): string | undefined {
  return typeof value === "string" && MODEL_ID.test(value) ? value : undefined;
}

function buildPrompt(task: ClaudeWorkspaceTask): string {
  return [`Workspace task: ${task.title}`, ...(task.description ? [`\n${task.description}`] : []),
    "\nReturn the proposed result for review. Do not claim that changes were applied unless the workspace provides evidence."].join("");
}

/**
 * Binds one authenticated workspace task to one owner-configured Claude profile.
 * Attempt storage and workspace publication are adapters over the existing private
 * Agent Workspace SQLite ledger; this class creates no registry or database.
 */
export class ClaudeWorkspaceDispatch {
  constructor(
    private readonly source: ClaudeWorkspaceTaskSource,
    private readonly attempts: ClaudeWorkspaceAttemptLedger,
    private readonly dispatch: Pick<ClaudeTaskDispatch, "start">,
  ) {}

  async submit(raw: unknown, caller: SupervisorCaller): Promise<ClaudeWorkspaceDispatchResult> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        Object.keys(raw as Record<string, unknown>).some(key => !["projectId", "taskId", "profileId", "model", "timeoutMs"].includes(key))) {
      throw new ClaudeWorkspaceDispatchError("invalid_input");
    }
    const input = raw as Record<string, unknown>;
    if (typeof input.projectId !== "string" || !ID.test(input.projectId) ||
        typeof input.taskId !== "string" || !ID.test(input.taskId) ||
        typeof input.profileId !== "string" || !/^[A-Za-z0-9_-]{16,48}$/.test(input.profileId) ||
        input.model !== undefined && (typeof input.model !== "string" || input.model.length > 160) ||
        input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) < 100 || Number(input.timeoutMs) > 15 * 60_000) ||
        !caller || caller.projectId !== input.projectId || typeof caller.clientId !== "string" || !CLIENT_ID.test(caller.clientId)) {
      throw new ClaudeWorkspaceDispatchError("invalid_input");
    }

    let task: ClaudeWorkspaceTask | undefined;
    try { task = await this.source.resolveOwnedTask({ projectId: input.projectId, taskId: input.taskId, caller }); }
    catch { throw new ClaudeWorkspaceDispatchError("workspace_unavailable"); }
    if (!task) return { accepted: false, replayed: false, state: "task_unavailable" };
    if (task.projectId !== input.projectId || task.taskId !== input.taskId || !isSafeText(task.title) ||
        task.description !== undefined && !isSafeText(task.description)) throw new ClaudeWorkspaceDispatchError("workspace_unavailable");
    if (task.state !== "queued") return { accepted: false, replayed: false, state: "task_not_claimable" };

    const prompt = buildPrompt(task);
    if (!isSafeText(prompt)) throw new ClaudeWorkspaceDispatchError("invalid_input");
    const promptDigest = createHash("sha256").update(prompt).digest("hex");
    let reservation: Awaited<ReturnType<ClaudeWorkspaceAttemptLedger["reserve"]>>;
    try {
      reservation = await this.attempts.reserve({ projectId: task.projectId, taskId: task.taskId,
        ownerClientId: caller.clientId, profileId: input.profileId as string,
        modelRequested: typeof input.model === "string" ? input.model : "profile_default", promptDigest });
    } catch { throw new ClaudeWorkspaceDispatchError("attempt_ledger_unavailable"); }
    if (!reservation || typeof reservation.attemptId !== "string" || !ID.test(reservation.attemptId)) {
      throw new ClaudeWorkspaceDispatchError("attempt_ledger_unavailable");
    }
    if (!reservation.created) return { accepted: false, replayed: true, attemptId: reservation.attemptId, state: reservation.status };

    try { await this.source.claimTask({ projectId: task.projectId, taskId: task.taskId, caller, attemptId: reservation.attemptId }); }
    catch {
      try { await this.attempts.update({ attemptId: reservation.attemptId, status: "error", result: "workspace_claim_failed_before_start" }); }
      catch { /* The durable intent still prevents a second launch. */ }
      return { accepted: false, replayed: false, attemptId: reservation.attemptId, state: "error" };
    }

    let handle: ClaudeTaskDispatchHandle;
    try {
      handle = await this.dispatch.start({ profileId: input.profileId as string, prompt,
        ...(typeof input.model === "string" ? { model: input.model } : {}),
        ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}) });
    } catch {
      try { await this.attempts.update({ attemptId: reservation.attemptId, status: "error", result: "dispatch_rejected_before_start" }); }
      catch { /* The persisted intent still blocks any replay. */ }
      return { accepted: false, replayed: false, attemptId: reservation.attemptId, state: "error" };
    }

    // A validated executable may still fail immediately while the durable
    // running receipt is being written. Attach a rejection observer now;
    // settle below retains the original error and records its classification.
    void handle.promise.catch(() => undefined);
    try { await this.attempts.update({ attemptId: reservation.attemptId, status: "running" }); }
    catch {
      // A child may already be running. Keep processing its one owned promise,
      // but do not report durable running status or permit another dispatch.
      void this.settle(handle, task, caller, reservation.attemptId).catch(() => undefined);
      return { accepted: true, replayed: false, attemptId: reservation.attemptId, state: "intent" };
    }
    void this.settle(handle, task, caller, reservation.attemptId).catch(() => undefined);
    return { accepted: true, replayed: false, attemptId: reservation.attemptId, state: "running" };
  }

  private async settle(handle: ClaudeTaskDispatchHandle, task: ClaudeWorkspaceTask, caller: SupervisorCaller, attemptId: string): Promise<void> {
    try {
      const result = await handle.promise;
      const modelReported = safeModel(result.model);
      if (Buffer.byteLength(result.text, "utf8") > MAX_RESULT_BYTES) {
        await this.attempts.update({ attemptId, status: "ambiguous", ...(modelReported ? { modelReported } : {}), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}), result: "result_exceeded_workspace_limit" });
        return;
      }
      const text = cleanResult(result.text);
      let artifact: { artifactId: string };
      try { artifact = await this.source.publishResult({ projectId: task.projectId, taskId: task.taskId,
        caller, attemptId, text, ...(modelReported ? { modelReported } : {}),
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) }); }
      catch {
        await this.attempts.update({ attemptId, status: "artifact_failed", ...(modelReported ? { modelReported } : {}), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}), result: text });
        return;
      }
      if (!artifact || typeof artifact.artifactId !== "string" || !ID.test(artifact.artifactId)) {
        await this.attempts.update({ attemptId, status: "artifact_failed", ...(modelReported ? { modelReported } : {}), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}), result: text });
        return;
      }
      await this.attempts.update({ attemptId, status: "success", ...(modelReported ? { modelReported } : {}), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}), result: text });
    } catch (error) {
      const classified = safeCode(error);
      await this.attempts.update({ attemptId, status: classified.ambiguous ? "ambiguous" : "error", result: classified.code });
    }
  }
}
