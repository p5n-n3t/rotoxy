import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StateStore } from "./store.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MAX_MESSAGE_BYTES = 20_000;

export interface WorkerGuidanceInput {
  projectId: string;
  workerId: string;
  requestId: string;
  message: string;
  expectedPromptCount: number;
  expectedQuestionId?: string;
}
export type GuidanceState = "accepted" | "rejected" | "ambiguous";
export interface WorkerGuidanceResult {
  requestId: string;
  state: GuidanceState;
  reason?: string;
  requestedModel?: string;
  reportedModel?: string;
}
export interface GuidanceWorker { projectId: string; sessionId: string; accountId: string; model: string }
export interface GuidanceAdapter {
  readonly accountId?: string;
  sessionStatus(sessionId: string): Promise<GuidanceAdapterResult>;
  sendMessage(sessionId: string, message: string, clientMessageId: string): Promise<GuidanceAdapterResult>;
}
export interface GuidanceAdapterResult { classification: "accepted" | "rejected" | "ambiguous"; accountId: string; value?: unknown; reason?: string }
interface ActionRow { key: string; projectId: string; workerId: string; requestId: string; digest: string; state: "reserved" | GuidanceState; reason?: string; requestedModel?: string; reportedModel?: string; createdAt: number; updatedAt: number }
interface ActionDoc { version: 1; actions: ActionRow[] }
const EMPTY: ActionDoc = { version: 1, actions: [] };

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function actionKey(projectId: string, workerId: string, requestId: string): string { return createHash("sha256").update(`${projectId}\0${workerId}\0${requestId}`).digest("hex"); }
function payloadDigest(input: WorkerGuidanceInput): string { return createHash("sha256").update(JSON.stringify({ message: input.message, expectedPromptCount: input.expectedPromptCount, expectedQuestionId: input.expectedQuestionId ?? null })).digest("hex"); }
function completed(row: ActionRow): WorkerGuidanceResult {
  return { requestId: row.requestId, state: row.state === "reserved" ? "ambiguous" : row.state,
    ...(row.state === "reserved" ? { reason: "needs_reconciliation" } : row.reason ? { reason: row.reason } : {}),
    ...(row.requestedModel ? { requestedModel: row.requestedModel } : {}), ...(row.reportedModel ? { reportedModel: row.reportedModel } : {}) };
}

/** Cross-process durable idempotency ledger. Stores only identifiers, a payload digest and outcome metadata. */
export class WorkerGuidanceLedger {
  private readonly path: string;
  constructor(private readonly store: StateStore, configDir?: string) {
    const directory = typeof store.dir === "string" ? store.dir : configDir;
    if (!directory) throw new Error("worker guidance needs a private config directory");
    this.path = join(directory, "worker-guidance-actions.json");
  }

  private async read(): Promise<ActionDoc> {
    try {
      const doc = JSON.parse(await readFile(this.path, "utf8")) as ActionDoc;
      if (doc.version !== 1 || !Array.isArray(doc.actions) || doc.actions.length > 10_000) throw new Error("worker guidance ledger is invalid");
      return doc;
    } catch (error: any) {
      if (error?.code === "ENOENT") return structuredClone(EMPTY);
      throw error;
    }
  }

  private async write(doc: ActionDoc): Promise<void> {
    await mkdir(this.store.dir, { recursive: true, mode: 0o700 });
    await chmod(this.store.dir, 0o700).catch(() => undefined);
    const temp = `${this.path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
    await writeFile(temp, JSON.stringify(doc) + "\n", { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.path);
  }

  async lookup(input: WorkerGuidanceInput, digest = payloadDigest(input)): Promise<WorkerGuidanceResult | undefined> {
    const key = actionKey(input.projectId, input.workerId, input.requestId);
    const row = (await this.read()).actions.find((item) => item.key === key);
    if (!row) return undefined;
    if (row.digest !== digest) return { requestId: input.requestId, state: "rejected", reason: "request_id_conflict" };
    return completed(row);
  }

  /** Atomically reserve before sending. Existing reservations are never reissued after restart or concurrency. */
  async reserve(input: WorkerGuidanceInput, digest: string, models?: { requestedModel: string; reportedModel?: string }): Promise<{ send: true } | { send: false; result: WorkerGuidanceResult }> {
    const key = actionKey(input.projectId, input.workerId, input.requestId);
    let result!: { send: true } | { send: false; result: WorkerGuidanceResult };
    await this.store.update(async () => {
      const doc = await this.read();
      const existing = doc.actions.find((item) => item.key === key);
      if (existing) {
        result = { send: false, result: existing.digest === digest ? completed(existing) : { requestId: input.requestId, state: "rejected", reason: "request_id_conflict" } };
        return;
      }
      if (doc.actions.length >= 10_000) {
        result = { send: false, result: { requestId: input.requestId, state: "rejected", reason: "ledger_full" } };
        return;
      }
      const now = Date.now();
      doc.actions.push({ key, projectId: input.projectId, workerId: input.workerId, requestId: input.requestId, digest, state: "reserved", ...models, createdAt: now, updatedAt: now });
      await this.write(doc);
      result = { send: true };
    });
    return result;
  }

  async finish(input: WorkerGuidanceInput, digest: string, state: GuidanceState, reason?: string): Promise<void> {
    const key = actionKey(input.projectId, input.workerId, input.requestId);
    await this.store.update(async () => {
      const doc = await this.read();
      const row = doc.actions.find((item) => item.key === key);
      if (!row || row.digest !== digest) throw new Error("worker guidance reservation unavailable");
      if (row.state !== "reserved") return;
      row.state = state;
      row.reason = reason;
      row.updatedAt = Date.now();
      await this.write(doc);
    });
  }
}

export interface WorkerGuidanceServiceOptions {
  ledger: WorkerGuidanceLedger;
  findWorker(projectId: string, workerId: string): GuidanceWorker | undefined;
  adapterFor(accountId: string): Promise<GuidanceAdapter> | GuidanceAdapter;
  accountEligible(accountId: string): Promise<boolean>;
  policyAllows(worker: GuidanceWorker, message: string, clientMessageId: string): Promise<boolean>;
}

function statusValue(result: GuidanceAdapterResult): Record<string, unknown> | undefined {
  if (!object(result.value)) return undefined;
  const outer = result.value;
  return object(outer.status) ? { ...outer, ...outer.status } : outer;
}
function questionId(status: Record<string, unknown>): string | undefined {
  const value = status.questionId ?? status.currentQuestionId ?? (object(status.parkedQuestion) ? status.parkedQuestion.id : undefined);
  return typeof value === "string" && ID.test(value) ? value : undefined;
}
function parked(status: Record<string, unknown>): boolean {
  const value = status.parkedQuestion;
  return value === true || (typeof value === "string" && value.length > 0) || (object(value) && Object.keys(value).length > 0);
}

/** One-shot admin message to a configured, owned, idle existing session. Never answers native parked questions. */
export class WorkerGuidanceService {
  constructor(private readonly options: WorkerGuidanceServiceOptions) {}

  async submit(input: WorkerGuidanceInput): Promise<WorkerGuidanceResult> {
    if (!validId(input.projectId) || !validId(input.workerId) || !validId(input.requestId) ||
        typeof input.message !== "string" || Buffer.byteLength(input.message, "utf8") < 1 || Buffer.byteLength(input.message, "utf8") > MAX_MESSAGE_BYTES ||
        !Number.isSafeInteger(input.expectedPromptCount) || input.expectedPromptCount < 0 ||
        (input.expectedQuestionId !== undefined && !validId(input.expectedQuestionId))) {
      return { requestId: typeof input.requestId === "string" ? input.requestId.slice(0, 128) : "invalid", state: "rejected", reason: "invalid_guidance_request" };
    }
    const digest = payloadDigest(input);
    const prior = await this.options.ledger.lookup(input, digest);
    if (prior) return prior;
    const worker = this.options.findWorker(input.projectId, input.workerId);
    if (!worker || worker.sessionId !== input.workerId || worker.projectId !== input.projectId || !validId(worker.accountId) || !MODEL.test(worker.model)) {
      return { requestId: input.requestId, state: "rejected", reason: "worker_not_registered" };
    }
    try {
      if (!await this.options.accountEligible(worker.accountId)) return { requestId: input.requestId, state: "rejected", reason: "account_not_eligible" };
    } catch { return { requestId: input.requestId, state: "rejected", reason: "account_not_eligible" }; }

    let adapter: GuidanceAdapter;
    try { adapter = await this.options.adapterFor(worker.accountId); }
    catch { return { requestId: input.requestId, state: "rejected", reason: "adapter_unavailable" }; }
    if (adapter.accountId !== undefined && adapter.accountId !== worker.accountId) return { requestId: input.requestId, state: "rejected", reason: "account_identity_mismatch" };
    let checked: GuidanceAdapterResult;
    try { checked = await adapter.sessionStatus(worker.sessionId); }
    catch { return { requestId: input.requestId, state: "ambiguous", reason: "status_ambiguous" }; }
    const status = statusValue(checked);
    const rawState = status?.sessionStatus ?? status?.status ?? status?.state;
    const promptCount = status?.promptCount ?? (object(status?.usage) ? status.usage.promptCount : undefined);
    if (checked.classification !== "accepted" || checked.accountId !== worker.accountId || !status) {
      return { requestId: input.requestId, state: checked.classification === "ambiguous" ? "ambiguous" : "rejected", reason: "status_unavailable" };
    }
    if (parked(status)) return { requestId: input.requestId, state: "rejected", reason: "native_question_answer_unsupported" };
    if (status.isOwner !== true || status.canSendMessage !== true || typeof rawState !== "string" || rawState.toLowerCase() !== "idle") {
      return { requestId: input.requestId, state: "rejected", reason: "worker_not_idle_owned_or_sendable" };
    }
    if (!Number.isSafeInteger(promptCount) || promptCount !== input.expectedPromptCount) return { requestId: input.requestId, state: "rejected", reason: "prompt_count_changed" };
    if (input.expectedQuestionId !== undefined && questionId(status) !== input.expectedQuestionId) return { requestId: input.requestId, state: "rejected", reason: "question_id_changed" };

    const clientMessageId = "guidance-" + actionKey(input.projectId, input.workerId, input.requestId).slice(0, 40);
    try {
      if (!await this.options.policyAllows(worker, input.message, clientMessageId)) return { requestId: input.requestId, state: "rejected", reason: "policy_paid_block" };
    } catch { return { requestId: input.requestId, state: "rejected", reason: "policy_paid_block" }; }
    const observedModel = status.reportedModel ?? status.model;
    const reportedModel = typeof observedModel === "string" && MODEL.test(observedModel) ? observedModel : undefined;
    const models = { requestedModel: worker.model, ...(reportedModel ? { reportedModel } : {}) };
    const reservation = await this.options.ledger.reserve(input, digest, models);
    if (!reservation.send) return reservation.result;

    let state: GuidanceState = "ambiguous";
    let reason = "needs_reconciliation";
    try {
      const sent = await adapter.sendMessage(worker.sessionId, input.message, clientMessageId);
      if (sent.classification === "accepted" && sent.accountId === worker.accountId) { state = "accepted"; reason = "provider_accepted_message"; }
      else if (sent.classification === "rejected" && sent.accountId === worker.accountId) { state = "rejected"; reason = sent.reason === "policy_denied" ? "policy_paid_block" : "provider_rejected"; }
    } catch { /* once sendMessage starts, a thrown result is ambiguous and never replayed */ }
    try { await this.options.ledger.finish(input, digest, state, reason); }
    catch { return { requestId: input.requestId, state: "ambiguous", reason: "needs_reconciliation" }; }
    return { requestId: input.requestId, state, reason, ...models };
  }
}
