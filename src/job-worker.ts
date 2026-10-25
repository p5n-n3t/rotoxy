/** Durable Snooze operation consumer. Importing this module starts no timers or I/O. */
import { normalizeSessionObservation } from "./worker-observation.js";

export type OperationOutcome = "accepted" | "rejected" | "ambiguous";

export interface JobResult<T = unknown> {
  classification: OperationOutcome;
  accountId: string;
  value?: T;
  reason?: string;
  instructionsVerified?: boolean;
  reportedModel?: string;
}

export interface PinnedJobsAdapter {
  readonly accountId?: string;
  sessionStatus(sessionId: string): Promise<JobResult>;
  sessionTranscript(sessionId: string): Promise<JobResult>;
  sendMessage(sessionId: string, message: string, clientMessageId: string): Promise<JobResult>;
  stopSession(sessionId: string): Promise<JobResult>;
  createTask?(title: string, stackId: string): Promise<JobResult>;
  patchTaskInstructions?(taskId: string, description: string): Promise<JobResult>;
  readTask?(taskId: string): Promise<JobResult>;
  listTaskAgents?(taskId: string): Promise<JobResult>;
  /**
   * Starts a verified task through the provider's documented launch API.  The
   * stock LightSprint API does not expose an exact model or effort selector;
   * any returned model is therefore recorded as reported metadata only.
   */
  launchTask?(taskId: string, provider: string): Promise<JobResult>;
}

export interface JobBridge {
  request<T = unknown>(method: "POST", route: string, body?: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T | undefined>;
}

export interface JobOperation {
  operationId: string;
  attemptId: string;
  generation: number;
  selectedAccountId: string;
  kind: string;
  providerTaskId?: string | null;
  sessionId?: string | null;
  input: Record<string, unknown>;
}

export interface JobWorkerOptions {
  bridge: JobBridge;
  adapterFactory: (accountId: string, limits: { timeoutMs: number }) => PinnedJobsAdapter | Promise<PinnedJobsAdapter>;
  /** Called only for a structurally valid, durably claimed operation. When supplied for chat dispatch it must return undefined to reject an operation outside its trusted binding. */
  operationAdapterFactory?: (operation: JobOperation, limits: { timeoutMs: number }) => PinnedJobsAdapter | undefined | Promise<PinnedJobsAdapter | undefined>;
  /** Includes current enabled/auth/quota eligibility; this must be rechecked immediately before mutation. */
  isAccountEligible: (accountId: string) => boolean | Promise<boolean>;
  /** Observation eligibility: enabled and authorized only, ignoring quota and transient health. Falls back to isAccountEligible when absent. Observe operations use this; mutations always use isAccountEligible. */
  isAccountObservable?: (accountId: string) => boolean | Promise<boolean>;
  beforeClaim?: () => Promise<void>;
  workerId: string;
  allowedModels: readonly string[];
  maxConcurrent?: number;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  adapterTimeoutMs?: number;
  now?: () => number;
  /** Fresh task operations are opt-in and require a claimed-operation adapter. */
  allowFreshOperations?: boolean;
  onDiagnostic?: (event: { code: string; operationId?: string; accountId?: string }) => void;
}

export interface JobWorker {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<void>;
}

const MODEL = "gpt-6-luna";
const MAX_TEXT = 2_048;
const MAX_ASSISTANT_BYTES = 32 * 1_024;
const MAX_TRANSCRIPT_CHARS = 250_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// Provider-generated session IDs may begin with '_' or '-'; neither is a path separator.
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9_-]{0,127}$/;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value : undefined;
}
function field(source: unknown, ...keys: string[]): unknown {
  const row = object(source);
  if (!row) return undefined;
  for (const key of keys) if (Object.hasOwn(row, key)) return row[key];
  return undefined;
}
function resultRecord(value: unknown): Record<string, unknown> {
  return object(field(value, "value")) ?? object(value) ?? {};
}
function taskRecord(value: unknown): Record<string, unknown> {
  const root = resultRecord(value);
  return object(field(root, "task")) ?? root;
}
function boundedLabel(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
    ? value : undefined;
}
function sanitizedUsage(value: unknown): Record<string, number | string> | undefined {
  const source = object(value);
  if (!source) return undefined;
  const usage: Record<string, number | string> = {};
  // The native session-status API currently names this reported value
  // aiGatewaySessionCostUsd; the worker receipt uses its stable contract name.
  const cost = Object.hasOwn(source, "reportedSessionCostUsd")
    ? source.reportedSessionCostUsd : source.aiGatewaySessionCostUsd;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) usage.reportedSessionCostUsd = cost;
  const prompts = source.promptCount;
  if (typeof prompts === "number" && Number.isSafeInteger(prompts) && prompts >= 0) usage.promptCount = prompts;
  const budgetUsed = source.budgetUsed;
  if (typeof budgetUsed === "number" && Number.isFinite(budgetUsed) && budgetUsed >= 0) usage.budgetUsed = budgetUsed;
  const maxBudget = source.maxBudget;
  if (typeof maxBudget === "number" && Number.isFinite(maxBudget) && maxBudget > 0) usage.maxBudget = maxBudget;
  const fundingSource = boundedLabel(source.fundingSource, 64);
  if (fundingSource !== undefined) usage.fundingSource = fundingSource;
  const sandboxTier = boundedLabel(source.sandboxTier, 64);
  if (sandboxTier !== undefined) usage.sandboxTier = sandboxTier;
  return Object.keys(usage).length ? usage : undefined;
}
function addSessionMetadata(result: Record<string, unknown>, status: Record<string, unknown>): void {
  const model = boundedLabel(field(status, "reportedModel", "model", "registeredModel"), 128);
  if (model !== undefined) result.reportedModel = model;
  const usage = sanitizedUsage(status);
  if (usage !== undefined) result.usage = usage;
}
function isFreshAccepted(result: JobResult): boolean { return result.classification === "accepted"; }
function errorCode(error: unknown): string {
  const raw = object(error)?.code ?? (error instanceof Error ? error.name : "operation_error");
  return typeof raw === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(raw) ? raw : "operation_error";
}
/** R21 persists epoch seconds. Provider ISO timestamps are normalized into that same unit. */
function timestampSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed / 1_000;
  }
  return undefined;
}
function newestAssistant(transcript: unknown, dispatchAtSeconds: number, instructionsHash?: string): { text: string; at: number } | undefined {
  let encoded: string;
  try { encoded = JSON.stringify(transcript) ?? ""; } catch { return undefined; }
  if (!encoded || encoded.length > MAX_TRANSCRIPT_CHARS) return undefined;
  const root = object(transcript);
  // Token transcripts must link their newest user turn to this exact dispatch.
  if (root?.shape === "items" && (!instructionsHash || root.lastUserTextSha256 !== instructionsHash)) return undefined;
  const messages = root?.messages;
  const latestIndex = root?.latestAssistantIndex;
  // The adapter projection's pointer identifies the newest assistant message in the source
  // transcript. Never walk backward: that would turn a truncated latest answer into completion.
  if (!Array.isArray(messages) || !Number.isInteger(latestIndex) || Number(latestIndex) < 0 ||
      Number(latestIndex) >= messages.length || root?.latestAssistantComplete !== true) return undefined;
  const latest = object(messages[Number(latestIndex)]);
  if (!latest || latest.role !== "assistant" || latest.complete !== true) return undefined;
  const at = timestampSeconds(latest.timestamp ?? latest.createdAt ?? latest.created_at ?? latest.time ?? latest.date);
  if (at === undefined || at < dispatchAtSeconds) return undefined;
  const content = latest.content;
  let assistantText: string | undefined;
  if (typeof content === "string") assistantText = content;
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else {
        const item = object(part);
        if (!item || item.type !== "text" || typeof item.text !== "string") return undefined;
        parts.push(item.text);
      }
    }
    assistantText = parts.join("");
  }
  if (assistantText === undefined || new TextEncoder().encode(assistantText).byteLength > MAX_ASSISTANT_BYTES) return undefined;
  return { text: assistantText, at };
}
function validOperation(value: unknown): value is JobOperation {
  const row = object(value);
  return !!row && ID.test(String(row.operationId ?? "")) && ID.test(String(row.attemptId ?? "")) &&
    Number.isSafeInteger(row.generation) && Number(row.generation) > 0 && ID.test(String(row.selectedAccountId ?? "")) &&
    typeof row.kind === "string" && object(row.input) !== undefined;
}

/** Create an explicitly controlled worker; no polling occurs until start() is called. */
export function createJobWorker(options: JobWorkerOptions): JobWorker {
  const maxConcurrent = options.maxConcurrent ?? 2;
  const leaseSeconds = options.leaseSeconds ?? 240;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const adapterTimeoutMs = options.adapterTimeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  if (!ID.test(options.workerId) || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32 ||
      !Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 300 ||
      !Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs >= leaseSeconds * 1_000 ||
      !Number.isInteger(adapterTimeoutMs) || adapterTimeoutMs < 1 || adapterTimeoutMs > 120_000 ||
      adapterTimeoutMs + requestTimeoutMs >= leaseSeconds * 1_000 ||
      // Fresh task provisioning records only provider-reported models and may
      // legitimately run before any existing session has been registered.
      (!Array.isArray(options.allowedModels) || options.allowedModels.length > 100 ||
       options.allowedModels.some(model => typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/.test(model)) ||
       new Set(options.allowedModels).size !== options.allowedModels.length)) throw new TypeError("Invalid job worker configuration");

  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tickPromise: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const active = new Map<string, Promise<void>>();
  const receipts = new Map<string, { body: Record<string, unknown>; attempts: number }>();
  const leaseDeadlines = new Map<string, number>();
  const diagnostic = (code: string, op?: JobOperation) => options.onDiagnostic?.({ code,
    ...(op ? { operationId: op.operationId, accountId: op.selectedAccountId } : {}) });
  const postResult = async (operationId: string, body: Record<string, unknown>): Promise<boolean> => {
    try {
      await options.bridge.request("POST", `/v1/operations/${operationId}/result`, body, { timeoutMs: requestTimeoutMs });
      receipts.delete(operationId);
      leaseDeadlines.delete(operationId);
      return true;
    } catch {
      const previous = receipts.get(operationId);
      receipts.set(operationId, { body, attempts: (previous?.attempts ?? 0) + 1 });
      diagnostic("result_receipt_pending");
      return false;
    }
  };
  const submit = async (op: JobOperation, outcome: OperationOutcome, result: Record<string, unknown> = {}, errorClass?: string) => {
    const body = { workerId: options.workerId, outcome, observedAt: new Date(now()).toISOString(), result,
      ...(errorClass ? { errorClass } : {}) };
    await postResult(op.operationId, body);
  };

  const checkSession = async (adapter: PinnedJobsAdapter, sessionId: string) => {
    const checked = await adapter.sessionStatus(sessionId);
    if (!isFreshAccepted(checked)) return { result: checked, status: undefined as Record<string, unknown> | undefined };
    const status = resultRecord(checked);
    const row = object(field(status, "status")) ?? status;
    return { result: checked, status: row };
  };

  const execute = async (op: JobOperation): Promise<void> => {
    let outcome: OperationOutcome = "rejected";
    let result: Record<string, unknown> = {};
    let errorClass: string | undefined;
    let mutationStarted = false;
    const input = op.input;
    try {
      const checkEligible = op.kind === "observe_session" && options.isAccountObservable !== undefined
        ? options.isAccountObservable : options.isAccountEligible;
      if (!await checkEligible(op.selectedAccountId)) { errorClass = "account_unavailable"; return await submit(op, outcome, result, errorClass); }
      const sessionId = text(op.sessionId ?? input.sessionId, 128);
      const message = op.kind === "chat_session" ? text(input.instructions, 20_000) : undefined;
      const clientMessageId = op.kind === "chat_session" ? text(input.clientMessageId, 128) : undefined;
      if (op.kind === "chat_session" && (!sessionId || !SESSION_ID.test(sessionId) ||
          (op.sessionId !== undefined && input.sessionId !== undefined && op.sessionId !== input.sessionId) ||
          !message || !clientMessageId || !MESSAGE_ID.test(clientMessageId))) {
        errorClass = "invalid_operation_input"; return await submit(op, outcome, result, errorClass);
      }
      const freshOperation = ["create_task", "patch_task", "verify_task_packet", "launch_task"].includes(op.kind);
      const adapter = (op.kind === "chat_session" || freshOperation) && options.operationAdapterFactory
        ? await options.operationAdapterFactory(op, { timeoutMs: adapterTimeoutMs })
        : await options.adapterFactory(op.selectedAccountId, { timeoutMs: adapterTimeoutMs });
      if (!adapter) { errorClass = "operation_not_trusted"; return await submit(op, outcome, result, errorClass); }
      if (adapter.accountId !== undefined && adapter.accountId !== op.selectedAccountId) { errorClass = "account_identity_mismatch"; return await submit(op, outcome, result, errorClass); }
      if (op.kind === "chat_session") {
        if (!sessionId || !message || !clientMessageId) {
          return await submit(op, "rejected", {}, "invalid_operation_input");
        }
        if (stopped || !running || (leaseDeadlines.get(op.operationId) ?? 0) - now() <= adapterTimeoutMs + requestTimeoutMs) {
          errorClass = "worker_stopping_or_lease_insufficient"; return await submit(op, outcome, result, errorClass);
        }
        const checked = await checkSession(adapter, sessionId);
        const status = checked.status;
        const registeredModel = field(status, "registeredModel", "model", "reportedModel");
        const expectedModel = input.model === undefined ? MODEL : text(input.model, 128);
        const state = field(status, "sessionStatus", "status", "state");
        const observed = normalizeSessionObservation(status);
        if (!status || checked.result.classification !== "accepted" || field(status, "isOwner") !== true ||
            field(status, "canSendMessage") !== true || !expectedModel || registeredModel !== expectedModel || !options.allowedModels.includes(String(registeredModel)) ||
            typeof state !== "string" || state.toLowerCase() !== "idle" || observed.state !== "idle" || observed.needsInput) {
          errorClass = checked.result.classification === "ambiguous" ? "session_preflight_ambiguous" : "session_not_sendable";
          return await submit(op, checked.result.classification === "ambiguous" ? "ambiguous" : "rejected", {}, errorClass);
        }
        if (!running || stopped || (leaseDeadlines.get(op.operationId) ?? 0) - now() <= adapterTimeoutMs + requestTimeoutMs || !await options.isAccountEligible(op.selectedAccountId)) {
          errorClass = "account_unavailable_or_stopping"; return await submit(op, outcome, {}, errorClass);
        }
        mutationStarted = true;
        const sent = await adapter.sendMessage(sessionId, message, clientMessageId); // exactly one call, never retried
        outcome = sent.classification;
        if (outcome === "accepted") {
          result = { sessionId, status: "submitted" };
          addSessionMetadata(result, status);
        }
        else errorClass = text(sent.reason, 80) ?? (outcome === "ambiguous" ? "chat_ambiguous" : "chat_rejected");
        return await submit(op, outcome, result, errorClass);
      }
      if (op.kind === "observe_session") {
        if (!sessionId) { errorClass = "invalid_operation_input"; return await submit(op, outcome, result, errorClass); }
        const checked = await checkSession(adapter, sessionId);
        if (!checked.status || checked.result.classification !== "accepted") {
          errorClass = checked.result.classification === "ambiguous" ? "status_ambiguous" : "status_unavailable";
          return await submit(op, checked.result.classification, {}, errorClass);
        }
        const observed = normalizeSessionObservation(checked.status);
        const status = observed.needsInput
          ? observed.question?.kind === "approval" ? "needs_approval" : "needs_instructions"
          : observed.state;
        // A transport can be idle after its agent relay dies. Never fetch a stale
        // assistant transcript and accidentally turn that failure into completion.
        if (status === "failed" || status === "timed_out" || status === "cancelled") {
          result = { sessionId, status };
          addSessionMetadata(result, checked.status);
          return await submit(op, "accepted", result, observed.errorCode ?? "provider_terminal_state");
        }
        let fresh: { text: string; at: number } | undefined;
        if (status === "idle" && !observed.needsInput) {
          const dispatchAt = timestampSeconds(input.dispatchAt);
          if (dispatchAt === undefined) { errorClass = "invalid_dispatch_timestamp"; return await submit(op, "rejected", {}, errorClass); }
          const transcript = await adapter.sessionTranscript(sessionId);
          if (transcript.classification === "ambiguous") { errorClass = "transcript_ambiguous"; return await submit(op, "ambiguous", {}, errorClass); }
          if (transcript.classification === "accepted") fresh = newestAssistant(transcript.value, dispatchAt,
            typeof input.instructionsHash === "string" && /^[0-9a-f]{64}$/.test(input.instructionsHash) ? input.instructionsHash : undefined);
        }
        // R21's registry accepts the session status (for example "idle") and
        // marks completion only from a fresh assistantText + numeric assistantAt.
        result = { sessionId, status };
        addSessionMetadata(result, checked.status);
        if (fresh) {
          result.assistantText = fresh.text;
          result.assistantAt = fresh.at;
        }
        outcome = "accepted";
        return await submit(op, outcome, result);
      }
      if (op.kind === "cancel_session") {
        if (!sessionId) { errorClass = "invalid_operation_input"; return await submit(op, outcome, result, errorClass); }
        if (!running || stopped || (leaseDeadlines.get(op.operationId) ?? 0) - now() <= adapterTimeoutMs + requestTimeoutMs || !await options.isAccountEligible(op.selectedAccountId)) {
          errorClass = "account_unavailable_or_stopping"; return await submit(op, outcome, {}, errorClass);
        }
        mutationStarted = true;
        const stoppedSession = await adapter.stopSession(sessionId);
        if (stoppedSession.classification !== "accepted") {
          outcome = stoppedSession.classification;
          errorClass = text(stoppedSession.reason, 80) ?? "stop_unconfirmed";
          return await submit(op, outcome, {}, errorClass);
        }
        const confirmed = await checkSession(adapter, sessionId);
        const finalState = field(confirmed.status, "sessionStatus", "status", "state");
        if (confirmed.result.classification === "accepted" && typeof finalState === "string" && /^(stopped|cancelled|canceled)$/i.test(finalState)) {
          outcome = "accepted"; result = { sessionId, status: "cancelled" };
        } else { outcome = "ambiguous"; errorClass = "cancellation_unconfirmed"; }
        return await submit(op, outcome, result, errorClass);
      }
      if (["create_task", "patch_task", "verify_task_packet", "launch_task"].includes(op.kind)) {
        if (!options.allowFreshOperations) { errorClass = "fresh_operations_disabled"; return await submit(op, "rejected", {}, errorClass); }
        if (!await options.isAccountEligible(op.selectedAccountId)) { errorClass = "account_unavailable"; return await submit(op, "rejected", {}, errorClass); }
        const instructions = text(input.instructions, 16_384);
        const taskId = text(op.providerTaskId ?? input.providerTaskId, 128);
        if (!instructions || (op.kind === "create_task" && !text(input.stackId, 128)) ||
            (op.kind !== "create_task" && !taskId)) {
          errorClass = "fresh_operation_inputs_incomplete"; return await submit(op, "rejected", {}, errorClass);
        }
        if (op.kind === "create_task" && adapter.createTask && text(input.title, 500)) {
          if ((leaseDeadlines.get(op.operationId) ?? 0) - now() <= adapterTimeoutMs + requestTimeoutMs) {
            errorClass = "worker_stopping_or_lease_insufficient"; return await submit(op, "rejected", {}, errorClass);
          }
          mutationStarted = true;
          const created = await adapter.createTask(String(input.title), String(input.stackId));
          if (created.classification !== "accepted") { outcome = created.classification; errorClass = text(created.reason, 80) ?? "create_task_failed"; return await submit(op, outcome, {}, errorClass); }
          const id = field(taskRecord(created.value), "ref", "taskRef", "id", "taskId", "providerTaskId");
          if (typeof id !== "string" || !ID.test(id)) { outcome = "ambiguous"; errorClass = "created_task_identity_unverified"; return await submit(op, outcome, {}, errorClass); }
          outcome = "accepted"; result = { providerTaskId: id }; return await submit(op, outcome, result);
        }
        if (op.kind === "patch_task" && adapter.patchTaskInstructions) {
          if ((leaseDeadlines.get(op.operationId) ?? 0) - now() <= adapterTimeoutMs + requestTimeoutMs) {
            errorClass = "worker_stopping_or_lease_insufficient"; return await submit(op, "rejected", {}, errorClass);
          }
          mutationStarted = true;
          const patched = await adapter.patchTaskInstructions(taskId!, instructions);
          outcome = patched.instructionsVerified === true && patched.classification === "accepted" ? "accepted" : patched.classification === "ambiguous" ? "ambiguous" : "rejected";
          errorClass = outcome === "accepted" ? undefined : text(patched.reason, 80) ?? "instruction_roundtrip_unverified";
          result = outcome === "accepted" ? { providerTaskId: taskId!, status: "instructions_verified" } : {};
          return await submit(op, outcome, result, errorClass);
        }
        if (op.kind === "verify_task_packet" && adapter.readTask) {
          const readback = await adapter.readTask(taskId!);
          const row = taskRecord(readback.value);
          outcome = readback.classification === "ambiguous" ? "ambiguous" : readback.classification === "accepted" &&
            field(row, "ref", "taskRef", "id", "taskId") === taskId && field(row, "description") === instructions ? "accepted" : "rejected";
          errorClass = outcome === "accepted" ? undefined : "instruction_roundtrip_unverified";
          result = outcome === "accepted" ? { providerTaskId: taskId!, status: "instructions_verified" } : {};
          return await submit(op, outcome, result, errorClass);
        }
        if (op.kind === "launch_task" && adapter.launchTask && adapter.readTask && text(input.provider, 32) &&
            (leaseDeadlines.get(op.operationId) ?? 0) - now() > adapterTimeoutMs + requestTimeoutMs &&
            await options.isAccountEligible(op.selectedAccountId)) {
          const readback = await adapter.readTask(taskId!);
          const task = taskRecord(readback.value);
          if (readback.classification !== "accepted" || field(task, "ref", "taskRef", "id", "taskId") !== taskId || field(task, "description") !== instructions) {
            outcome = readback.classification === "ambiguous" ? "ambiguous" : "rejected";
            errorClass = "instruction_roundtrip_unverified";
            return await submit(op, outcome, {}, errorClass);
          }
          mutationStarted = true;
          const launched = await adapter.launchTask(taskId!, String(input.provider));
          const launchedValue = resultRecord(launched.value);
          const launchedSession = object(field(launchedValue, "session"));
          const launchedSessionId = text(field(launchedValue, "sessionId", "agentSessionId") ??
            field(launchedSession, "id", "sessionId", "agentSessionId"), 128);
          if (launched.classification === "accepted" && launchedSessionId && SESSION_ID.test(launchedSessionId)) {
            outcome = "accepted";
            result = { providerTaskId: taskId!, sessionId: launchedSessionId,
              ...(text(launched.reportedModel, 128) ? { reportedModel: text(launched.reportedModel, 128)! } : {}) };
          } else {
            outcome = launched.classification === "ambiguous" || launched.classification === "accepted" ? "ambiguous" : "rejected";
            errorClass = launched.classification === "accepted" ? "launch_session_identity_unverified" : text(launched.reason, 80) ?? "launch_task_failed";
          }
          return await submit(op, outcome, result, errorClass);
        }
        errorClass = "operation_not_supported_by_adapter";
        return await submit(op, "rejected", {}, errorClass);
      }
      if (op.kind === "inspect_task_agents" && adapter.listTaskAgents) {
        const taskId = text(op.providerTaskId ?? input.providerTaskId, 128);
        if (!taskId) { errorClass = "invalid_operation_input"; return await submit(op, "rejected", {}, errorClass); }
        const listed = await adapter.listTaskAgents(taskId);
        outcome = listed.classification;
        if (outcome === "accepted") result = { providerTaskId: taskId, status: "agents_observed" };
        else errorClass = text(listed.reason, 80) ?? "agents_unavailable";
        return await submit(op, outcome, result, errorClass);
      }
      errorClass = "unsupported_operation_kind";
      return await submit(op, "rejected", {}, errorClass);
    } catch (error) {
      outcome = mutationStarted ? "ambiguous" : "rejected";
      errorClass = errorCode(error);
      diagnostic(errorClass, op);
      await submit(op, outcome, result, errorClass);
    }
  };

  const schedule = () => {
    if (!running || timer) return;
    timer = setTimeout(() => { timer = undefined; void tick().finally(schedule); }, pollIntervalMs);
  };

  const tick = (): Promise<void> => {
    if (!running || tickPromise) return tickPromise ?? Promise.resolve();
    tickPromise = (async () => {
      for (const [id, receipt] of receipts) await postResult(id, receipt.body);
      try { await options.beforeClaim?.(); } catch { diagnostic("dispatch_policy_unavailable"); return; }
      while (running && active.size + receipts.size < maxConcurrent) {
        const claimController = new AbortController();
        controller = claimController;
        let claimed: unknown;
        try {
          claimed = await options.bridge.request("POST", "/v1/operations/claim", { workerId: options.workerId, leaseSeconds },
            { signal: claimController.signal, timeoutMs: requestTimeoutMs });
        } catch (error) {
          if (running) diagnostic(errorCode(error));
          break;
        } finally { if (controller === claimController) controller = undefined; }
        if (!running || claimed === undefined || claimed === null) break;
        const raw = object(claimed)?.operation ?? claimed;
        if (!validOperation(raw)) { diagnostic("invalid_claim_envelope"); break; }
        const op = raw as JobOperation;
        if (active.has(op.operationId) || receipts.has(op.operationId)) { diagnostic("duplicate_operation_claim", op); break; }
        leaseDeadlines.set(op.operationId, now() + leaseSeconds * 1_000 - requestTimeoutMs);
        const task = execute(op).finally(() => { active.delete(op.operationId); });
        active.set(op.operationId, task);
      }
    })().finally(() => { tickPromise = undefined; });
    return tickPromise;
  };

  return {
    start() {
      if (running) return;
      stopped = false; running = true;
      void tick().finally(schedule);
    },
    async stop() {
      running = false; stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      await tickPromise?.catch(() => undefined);
      await Promise.allSettled([...active.values()]);
    },
    tick,
  };
}
