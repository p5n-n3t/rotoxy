import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { StateStore } from "./store.js";
import { decryptSecret, encryptSecret, ensureMasterKey } from "./crypto.js";
import { createPinnedPublicProviderFetch } from "./public-provider-http.js";

const EVENT_NAME = "rotoxy.job.changed";
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_SUBSCRIPTIONS = 256;
const MAX_OUTBOX = 512;
const MAX_PER_TICK = 8;
const MAX_ATTEMPTS = 5;
type JsonObject = Record<string, unknown>;
type StoredSubscription = {
  id: string; owner: string; name: typeof EVENT_NAME; args: { projectId: string; jobId: string }; url: string;
  secret: { v: 1; iv: string; tag: string; data: string }; expiresAt: number; lastFingerprint: string;
  authorizationEpoch?: number;
  previousSecret?: { v: 1; iv: string; tag: string; data: string }; previousUntil?: number;
};
type StoredEvent = { eventId: string; subscriptionId: string; body: string; attempts: number; nextAttemptAt: number; createdAt: number };
type StoredReceipt = { eventId: string; subscriptionId: string; state: "retry_due" | "accepted" | "failed" | "expired" | "revoked"; attempts: number; httpStatus?: number; lastAt: number };
type EventState = { mcpJobEvents?: { subscriptions: StoredSubscription[]; outbox: StoredEvent[]; receipts: StoredReceipt[] } };
export class McpJobEventsError extends Error {
  constructor(readonly code: number, message: string, readonly reason?: string) { super(message); this.name = "McpJobEventsError"; }
}
type Options = {
  store: StateStore;
  getStatus: (args: { projectId: string; jobId: string }, clientId: string) => Promise<unknown>;
  webhookFetch?: typeof fetch;
  now?: () => number;
};
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
function failInvalid(message = "Invalid event request"): never { throw new McpJobEventsError(-32602, message); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as JsonObject).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(",")}}`;
}
function statusShape(raw: unknown): JsonObject {
  if (!isObject(raw)) throw new Error("job_status_unavailable");
  return raw;
}
function boundedText(value: unknown, max = 160): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
function safeInteger(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined; }
function eventData(row: JsonObject, args: { projectId: string; jobId: string }): JsonObject {
  const data: JsonObject = { projectId: args.projectId, jobId: args.jobId };
  const state = boundedText(row.state ?? row.status, 64);
  if (state) data.state = state;
  const revision = safeInteger(row.revision);
  if (revision !== undefined) data.revision = revision;
  if (Array.isArray(row.tasks)) data.tasks = row.tasks.slice(0, 100).flatMap((task) => {
    if (!isObject(task)) return [];
    const item: JsonObject = {};
    const taskId = boundedText(task.taskId ?? task.task_id, 128);
    const taskState = boundedText(task.state ?? task.status, 64);
    const modelRequested = boundedText(task.modelRequested ?? task.model_requested, 160);
    const modelReported = boundedText(task.modelReported ?? task.model_reported, 160);
    const selectedAccountId = boundedText(task.selectedAccountId ?? task.selected_account_id, 128);
    if (taskId) item.taskId = taskId;
    if (taskState) item.state = taskState;
    if (modelRequested) item.modelRequested = modelRequested;
    if (modelReported) item.modelReported = modelReported;
    if (selectedAccountId) item.selectedAccountId = selectedAccountId;
    return Object.keys(item).length ? [item] : [];
  });
  return data;
}
function fingerprint(data: JsonObject): string { return createHash("sha256").update(canonical(data)).digest("hex"); }
function canonicalUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) failInvalid("Callback URL is invalid");
  let url: URL;
  try { url = new URL(value); } catch { return failInvalid("Callback URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443" || url.hostname === "localhost" || !url.hostname.includes(".")) {
    failInvalid("Callback URL must be public HTTPS");
  }
  return url.href;
}
function decodeWebhookSecret(value: unknown): Buffer {
  if (typeof value !== "string" || !value.startsWith("whsec_") || value.length > 128) return failInvalid("Webhook signing secret is invalid");
  const encoded = value.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return failInvalid("Webhook signing secret is invalid");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length < 24 || decoded.length > 64 || decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    return failInvalid("Webhook signing secret is invalid");
  }
  return decoded;
}
function signedHeaders(eventId: string, timestamp: number, body: string, secrets: Buffer[], subscriptionId: string): HeadersInit {
  const signatures = secrets.map((secret) => `v1,${createHmac("sha256", secret).update(`${eventId}.${timestamp}.${body}`).digest("base64")}`).join(" ");
  return { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": String(timestamp),
    "webhook-signature": signatures, "x-mcp-subscription-id": subscriptionId };
}
function equalString(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function persisted(state: unknown): { subscriptions: StoredSubscription[]; outbox: StoredEvent[]; receipts: StoredReceipt[] } {
  const root = state as EventState;
  if (!isObject(root.mcpJobEvents)) root.mcpJobEvents = { subscriptions: [], outbox: [], receipts: [] };
  const box = root.mcpJobEvents!;
  if (!Array.isArray(box.subscriptions)) box.subscriptions = [];
  if (!Array.isArray(box.outbox)) box.outbox = [];
  if (!Array.isArray(box.receipts)) box.receipts = [];
  return box as { subscriptions: StoredSubscription[]; outbox: StoredEvent[]; receipts: StoredReceipt[] };
}
function recordReceipt(box: ReturnType<typeof persisted>, receipt: StoredReceipt): void {
  const existing = box.receipts.find((item) => item.eventId === receipt.eventId);
  if (existing) Object.assign(existing, receipt); else box.receipts.push(receipt);
  if (box.receipts.length > 512) box.receipts.splice(0, box.receipts.length - 512);
}
function callbackError(reason: string): McpJobEventsError { return new McpJobEventsError(-32015, "Callback endpoint could not be verified", reason); }

export class McpJobEvents {
  private readonly now: () => number;
  private readonly webhookFetch: typeof fetch;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private readonly verifiedCallbacks = new Map<string, number>();
  private readonly verificationInflight = new Map<string, Promise<void>>();
  private subscriptionCursor = 0;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.webhookFetch = options.webhookFetch ?? createPinnedPublicProviderFetch({ allowQuery: true, timeoutMs: 10_000,
      allowedHeaders: ["content-type", "webhook-id", "webhook-timestamp", "webhook-signature", "x-mcp-subscription-id"] });
  }

  async call(method: "events/list" | "events/subscribe" | "events/unsubscribe", params: unknown, clientId: string): Promise<unknown> {
    if (method === "events/list") {
      if (params !== undefined && params !== null && (!isObject(params) || Object.keys(params).length)) failInvalid();
      return { events: [{ name: EVENT_NAME, description: "A durable job state changed for the selected project and job.", delivery: ["webhook"],
        inputSchema: { type: "object", properties: { projectId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }, jobId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } }, required: ["projectId", "jobId"], additionalProperties: false },
        payloadSchema: { type: "object", properties: { projectId: { type: "string" }, jobId: { type: "string" }, state: { type: "string" }, revision: { type: "integer" }, tasks: { type: "array", items: { type: "object", properties: { taskId: { type: "string" }, state: { type: "string" }, modelRequested: { type: "string" }, modelReported: { type: "string" }, selectedAccountId: { type: "string" } }, additionalProperties: false } } }, required: ["projectId", "jobId"], additionalProperties: false } }] };
    }
    if (method === "events/subscribe") return this.subscribe(params, clientId);
    if (method === "events/unsubscribe") return this.unsubscribe(params, clientId);
    throw new McpJobEventsError(-32601, "Method not found");
  }

  private parseRequest(params: unknown, unsubscribe: true): { args: { projectId: string; jobId: string }; url: string };
  private parseRequest(params: unknown, unsubscribe?: false): { args: { projectId: string; jobId: string }; url: string; secret: Buffer; ttlMs: number };
  private parseRequest(params: unknown, unsubscribe = false) {
    if (!isObject(params) || Object.keys(params).some((key) => !["name", "arguments", "delivery", "ttlMs", "cursor"].includes(key))) failInvalid();
    if (params.name !== EVENT_NAME || !isObject(params.arguments) || Object.keys(params.arguments).some((key) => !["projectId", "jobId"].includes(key))) failInvalid();
    const { projectId, jobId } = params.arguments;
    if (typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId) || typeof jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(jobId)) failInvalid();
    if (!isObject(params.delivery) || Object.keys(params.delivery).some((key) => !["mode", "url", "secret"].includes(key)) || params.delivery.mode !== "webhook") failInvalid();
    const url = canonicalUrl(params.delivery.url);
    if (unsubscribe) {
      if (params.delivery.secret !== undefined || params.ttlMs !== undefined || params.cursor !== undefined) failInvalid();
      return { args: { projectId, jobId }, url };
    }
    const secret = decodeWebhookSecret(params.delivery.secret);
    if (params.cursor !== undefined && params.cursor !== null) failInvalid("This event does not support replay cursors");
    if (params.ttlMs !== undefined && params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || Number(params.ttlMs) < 60_000 || Number(params.ttlMs) > MAX_TTL_MS)) failInvalid("ttlMs must be between one minute and 24 hours");
    return { args: { projectId, jobId }, url, secret, ttlMs: params.ttlMs === undefined ? DEFAULT_TTL_MS : params.ttlMs === null ? MAX_TTL_MS : Number(params.ttlMs) };
  }

  private identity(clientId: string, url: string, args: { projectId: string; jobId: string }): string {
    if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) throw new McpJobEventsError(-32001, "Authenticated client is unavailable");
    const material = canonical({ owner: clientId, url, name: EVENT_NAME, arguments: args });
    return `sub_${createHash("sha256").update(material).digest("hex")}`;
  }

  private async readAuthorized(args: { projectId: string; jobId: string }, clientId: string): Promise<JsonObject> {
    const raw = await this.options.getStatus(args, clientId);
    const row = statusShape(raw);
    if (row.projectId !== args.projectId) throw new McpJobEventsError(-32001, "Job is unavailable for this client", "authorization_failed");
    const identity = row.assignmentId ?? row.jobId ?? row.assignment_id;
    if (identity === undefined) throw new Error("job_status_identity_missing");
    if (identity !== args.jobId) throw new McpJobEventsError(-32001, "Job is unavailable for this client", "authorization_failed");
    return row;
  }

  private async verifyCallback(url: string, secret: Buffer, subscriptionId: string, clientId: string): Promise<void> {
    const key = `${clientId}\0${url}\0${createHash("sha256").update(secret).digest("hex")}`;
    const verifiedUntil = this.verifiedCallbacks.get(key) ?? 0;
    if (verifiedUntil > this.now()) { this.verifiedCallbacks.delete(key); this.verifiedCallbacks.set(key, verifiedUntil); return; }
    this.verifiedCallbacks.delete(key);
    const active = this.verificationInflight.get(key);
    if (active) return active;
    if (this.verificationInflight.size >= 4) throw callbackError("capacity");
    const operation = this.verifyCallbackRequest(url, secret, subscriptionId, key);
    this.verificationInflight.set(key, operation);
    try { await operation; } finally { this.verificationInflight.delete(key); }
  }

  private async verifyCallbackRequest(url: string, secret: Buffer, subscriptionId: string, key: string): Promise<void> {
    const challenge = randomBytes(24).toString("base64url");
    const eventId = `msg_verification_${randomBytes(16).toString("hex")}`;
    const body = JSON.stringify({ type: "verification", challenge });
    let response: Response;
    try {
      response = await this.webhookFetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: signedHeaders(eventId, Math.floor(this.now() / 1000), body, [secret], subscriptionId), body });
    } catch { throw callbackError("timeout"); }
    if (!response.ok) throw callbackError("challenge_failed");
    let received: unknown;
    try { received = await response.json(); } catch { throw callbackError("challenge_failed"); }
    if (!isObject(received) || !equalString(received.challenge, challenge)) throw callbackError("challenge_failed");
    for (const [cachedKey, expiresAt] of this.verifiedCallbacks) if (expiresAt <= this.now()) this.verifiedCallbacks.delete(cachedKey);
    if (this.verifiedCallbacks.size >= 256) this.verifiedCallbacks.delete(this.verifiedCallbacks.keys().next().value!);
    this.verifiedCallbacks.set(key, this.now() + 10 * 60_000);
  }

  private async subscribe(params: unknown, clientId: string): Promise<unknown> {
    const request = this.parseRequest(params);
    const authorizationEpoch = (await this.options.store.load()).security?.accessTokenNotBefore ?? 0;
    const row = await this.readAuthorized(request.args, clientId);
    const data = eventData(row, request.args);
    const id = this.identity(clientId, request.url, request.args);
    const expiresAt = this.now() + request.ttlMs;
    await this.verifyCallback(request.url, request.secret, id, clientId);
    const masterKey = await ensureMasterKey(this.options.store.keyPath);
    const secretText = request.secret.toString("base64");
    const encrypted = encryptSecret(secretText, masterKey);
    await this.options.store.update((raw) => {
      if ((raw.security?.accessTokenNotBefore ?? 0) !== authorizationEpoch) throw new McpJobEventsError(-32001, "Authorization changed during subscription", "authorization_failed");
      const box = persisted(raw);
      const existing = box.subscriptions.find((sub) => sub.id === id && sub.owner === clientId);
      if (!existing && box.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new McpJobEventsError(-32000, "Subscription capacity reached");
      if (existing) {
        if (decryptSecret(existing.secret, masterKey) !== secretText) {
          existing.previousSecret = existing.secret;
          existing.previousUntil = this.now() + 5 * 60_000;
        }
        Object.assign(existing, { url: request.url, secret: encrypted, expiresAt });
      }
      else box.subscriptions.push({ id, owner: clientId, name: EVENT_NAME, args: request.args, url: request.url, secret: encrypted, expiresAt, authorizationEpoch, lastFingerprint: fingerprint(data) });
      if (existing) existing.authorizationEpoch = authorizationEpoch;
    });
    return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
  }

  private async unsubscribe(params: unknown, clientId: string): Promise<unknown> {
    const request = this.parseRequest(params, true);
    const id = this.identity(clientId, request.url, request.args);
    await this.options.store.update((raw) => {
      const box = persisted(raw);
      for (const event of box.outbox.filter((item) => item.subscriptionId === id)) recordReceipt(box, { eventId: event.eventId, subscriptionId: id, state: "revoked", attempts: event.attempts, lastAt: this.now() });
      box.subscriptions = box.subscriptions.filter((sub) => !(sub.id === id && sub.owner === clientId));
      box.outbox = box.outbox.filter((event) => event.subscriptionId !== id);
    });
    return {};
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, 1000);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
  }
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick();
    try { await this.ticking; } finally { this.ticking = undefined; }
  }

  private async runTick(): Promise<void> {
    const now = this.now();
    const state = await this.options.store.load();
    const box = persisted(state);
    const epoch = state.security?.accessTokenNotBefore ?? 0;
    const eligible = box.subscriptions.filter((sub) => sub.expiresAt > now && (sub.authorizationEpoch ?? 0) === epoch);
    const active: StoredSubscription[] = [];
    if (eligible.length) {
      const start = this.subscriptionCursor % eligible.length;
      const count = Math.min(MAX_PER_TICK, eligible.length);
      for (let offset = 0; offset < count; offset++) active.push(eligible[(start + offset) % eligible.length]!);
      this.subscriptionCursor = (start + count) % eligible.length;
    }
    // Expired subscriptions and their pending delivery state are pruned durably.
    if (box.subscriptions.some((sub) => sub.expiresAt <= now || (sub.authorizationEpoch ?? 0) !== epoch)) await this.options.store.update((raw) => {
      const current = persisted(raw); const currentEpoch = raw.security?.accessTokenNotBefore ?? 0;
      const revoked = new Set(current.subscriptions.filter((sub) => (sub.authorizationEpoch ?? 0) !== currentEpoch).map((sub) => sub.id));
      const expired = new Set(current.subscriptions.filter((sub) => sub.expiresAt <= now || revoked.has(sub.id)).map((sub) => sub.id));
      for (const event of current.outbox.filter((item) => expired.has(item.subscriptionId))) recordReceipt(current, { eventId: event.eventId, subscriptionId: event.subscriptionId, state: revoked.has(event.subscriptionId) ? "revoked" : "expired", attempts: event.attempts, lastAt: now });
      current.subscriptions = current.subscriptions.filter((sub) => !expired.has(sub.id));
      current.outbox = current.outbox.filter((event) => !expired.has(event.subscriptionId));
    });
    for (const sub of active) {
      const pending = box.outbox.find((event) => event.subscriptionId === sub.id && event.nextAttemptAt <= this.now());
      if (pending) { await this.deliver(sub, pending); continue; }
      let row: JsonObject;
      try { row = await this.readAuthorized(sub.args, sub.owner); }
      catch (error) {
        if (error instanceof McpJobEventsError && error.code === -32001) {
          await this.options.store.update((raw) => {
            const current = persisted(raw);
            for (const event of current.outbox.filter((item) => item.subscriptionId === sub.id)) recordReceipt(current, { eventId: event.eventId, subscriptionId: sub.id, state: "revoked", attempts: event.attempts, lastAt: this.now() });
            current.subscriptions = current.subscriptions.filter((entry) => entry.id !== sub.id);
            current.outbox = current.outbox.filter((event) => event.subscriptionId !== sub.id);
          });
        }
        continue;
      }
      const data = eventData(row, sub.args); const currentFingerprint = fingerprint(data);
      if (currentFingerprint === sub.lastFingerprint) continue;
      const eventId = `evt_${randomBytes(18).toString("hex")}`;
      const body = JSON.stringify({ eventId, name: EVENT_NAME, timestamp: new Date(this.now()).toISOString(), data, cursor: null });
      if (Buffer.byteLength(body) > 256 * 1024) continue;
      let enqueued = false;
      await this.options.store.update((raw) => {
        const current = persisted(raw); const currentSub = current.subscriptions.find((entry) => entry.id === sub.id && entry.owner === sub.owner);
        if (!currentSub || currentSub.expiresAt <= this.now() || current.outbox.length >= MAX_OUTBOX || currentSub.lastFingerprint === currentFingerprint) return;
        if (!current.outbox.some((event) => event.eventId === eventId)) current.outbox.push({ eventId, subscriptionId: sub.id, body, attempts: 0, nextAttemptAt: this.now(), createdAt: this.now() });
        recordReceipt(current, { eventId, subscriptionId: sub.id, state: "retry_due", attempts: 0, lastAt: this.now() });
        currentSub.lastFingerprint = currentFingerprint; enqueued = true;
      });
      if (enqueued) {
        const fresh = (await this.options.store.load() as unknown as EventState).mcpJobEvents?.outbox?.find((event) => event.eventId === eventId);
        if (fresh) await this.deliver(sub, fresh);
      }
    }
  }

  private async deliver(sub: StoredSubscription, event: StoredEvent): Promise<void> {
    let row: JsonObject;
    try { row = await this.readAuthorized(sub.args, sub.owner); }
    catch (error) {
      if (error instanceof McpJobEventsError && error.code === -32001) {
        await this.options.store.update((raw) => {
          const box = persisted(raw);
          for (const item of box.outbox.filter((entry) => entry.subscriptionId === sub.id)) recordReceipt(box, { eventId: item.eventId, subscriptionId: sub.id, state: "revoked", attempts: item.attempts, lastAt: this.now() });
          box.subscriptions = box.subscriptions.filter((entry) => entry.id !== sub.id); box.outbox = box.outbox.filter((item) => item.subscriptionId !== sub.id);
        });
      }
      return;
    }
    void row; // The read is an authorization check; the queued payload remains immutable across retries.
    const currentState = await this.options.store.load() as unknown as EventState;
    const currentSub = currentState.mcpJobEvents?.subscriptions.find((entry) => entry.id === sub.id && entry.owner === sub.owner);
    const currentEvent = currentState.mcpJobEvents?.outbox.find((item) => item.eventId === event.eventId && item.subscriptionId === sub.id);
    if (!currentSub || currentSub.expiresAt <= this.now() || !currentEvent) return;
    if ((currentSub.authorizationEpoch ?? 0) !== ((currentState as unknown as { security?: { accessTokenNotBefore?: number } }).security?.accessTokenNotBefore ?? 0)) return;
    const attempt = event.attempts + 1;
    await this.options.store.update((raw) => {
      const box = persisted(raw); const current = box.outbox.find((item) => item.eventId === event.eventId);
      if (current) { current.attempts = attempt; current.nextAttemptAt = this.now() + Math.min(30_000, 1000 * (2 ** (attempt - 1))); }
      recordReceipt(box, { eventId: event.eventId, subscriptionId: sub.id, state: "retry_due", attempts: attempt, lastAt: this.now() });
    });
    let status: number | undefined;
    try {
      const secretText = decryptSecret(currentSub.secret, await ensureMasterKey(this.options.store.keyPath));
      const secrets = [Buffer.from(secretText, "base64")];
      if (currentSub.previousSecret && (currentSub.previousUntil ?? 0) > this.now()) {
        secrets.push(Buffer.from(decryptSecret(currentSub.previousSecret, await ensureMasterKey(this.options.store.keyPath)), "base64"));
      } else if (currentSub.previousSecret) {
        await this.options.store.update((raw) => {
          const saved = persisted(raw).subscriptions.find((entry) => entry.id === sub.id);
          if (saved) { delete saved.previousSecret; delete saved.previousUntil; }
        });
      }
      const timestamp = Math.floor(this.now() / 1000);
      const response = await this.webhookFetch(currentSub.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: signedHeaders(event.eventId, timestamp, event.body, secrets, currentSub.id), body: event.body });
      status = response.status;
    } catch { status = undefined; }
    const accepted = status !== undefined && status >= 200 && status < 300;
    const retry = status === undefined || status === 408 || status === 429 || status >= 500 && status <= 599;
    await this.options.store.update((raw) => {
      const box = persisted(raw);
      if (accepted) {
        recordReceipt(box, { eventId: event.eventId, subscriptionId: sub.id, state: "accepted", attempts: attempt, ...(status === undefined ? {} : { httpStatus: status }), lastAt: this.now() });
        box.outbox = box.outbox.filter((item) => item.eventId !== event.eventId);
      } else if (!retry || attempt >= MAX_ATTEMPTS) {
        recordReceipt(box, { eventId: event.eventId, subscriptionId: sub.id, state: "failed", attempts: attempt, ...(status === undefined ? {} : { httpStatus: status }), lastAt: this.now() });
        box.outbox = box.outbox.filter((item) => item.eventId !== event.eventId);
      } else {
        const current = box.outbox.find((item) => item.eventId === event.eventId);
        if (current) current.nextAttemptAt = this.now() + Math.min(30_000, 1000 * (2 ** (attempt - 1)));
        recordReceipt(box, { eventId: event.eventId, subscriptionId: sub.id, state: "retry_due", attempts: attempt, ...(status === undefined ? {} : { httpStatus: status }), lastAt: this.now() });
      }
    });
  }
}
