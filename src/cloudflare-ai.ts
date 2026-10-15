import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { decryptSecret, encryptSecret, ensureMasterKey, randomToken } from "./crypto.js";
import type { EncryptedSecret } from "./types.js";
import type { StateStore } from "./store.js";
import { boundedAccountCapacity, ResourceRoutingRulesStore, routingRuleAllowsModel } from "./resource-routing.js";

const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,80}$/;
const MODEL = /^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;
const MAX_TOKEN_BYTES = 4096;
const MAX_CATALOG_BYTES = 1_000_000;
const MAX_INFERENCE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 4096;

export interface CloudflareCredentialView {
  id: string;
  label: string;
  accountId: string;
  enabled: boolean;
  allowedModels: string[];
  createdAt: number;
  cooldownUntil?: number;
}
interface CloudflareCredential extends CloudflareCredentialView { secret: EncryptedSecret }
interface CredentialDocument { version: 1; accounts: CloudflareCredential[] }
const EMPTY: CredentialDocument = { version: 1, accounts: [] };
export interface AddCloudflareCredential {
  label: string;
  accountId: string;
  token: string;
  enabled?: boolean;
  allowedModels?: string[];
}
export interface UpdateCloudflareCredential {
  label?: string;
  accountId?: string;
  token?: string;
  enabled?: boolean;
  allowedModels?: string[];
}

function validLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && LABEL.test(value);
}
function validAccountId(value: unknown): value is string { return typeof value === "string" && ACCOUNT_ID.test(value.toLowerCase()); }
function validModel(value: unknown): value is string {
  return typeof value === "string" && MODEL.test(value) && !value.split("/").some((part) => part === "." || part === "..");
}
function validToken(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 8 && Buffer.byteLength(value, "utf8") <= MAX_TOKEN_BYTES && !/[\r\n\0]/.test(value);
}
function validateModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200 || value.some((model) => typeof model !== "string" || model.length > 200 || !validModel(model))) {
    throw new TypeError("Cloudflare model allowlist is invalid");
  }
  return [...new Set(value as string[])];
}
function viewOf({ secret: _secret, ...view }: CloudflareCredential): CloudflareCredentialView { return { ...view, allowedModels: [...view.allowedModels] }; }

/** Encrypted Cloudflare account tokens; plaintext is returned only to the request adapter. */
export class CloudflareCredentialStore {
  private readonly file: string;
  readonly routingRules: ResourceRoutingRulesStore;
  constructor(private readonly store: StateStore) { this.file = join(store.dir, "cloudflare-ai-credentials.json"); this.routingRules = new ResourceRoutingRulesStore(store); }

  private async read(): Promise<CredentialDocument> {
    try {
      const document = JSON.parse(await readFile(this.file, "utf8")) as CredentialDocument;
      if (document.version !== 1 || !Array.isArray(document.accounts) || document.accounts.length > 1000) throw new Error("Cloudflare credential store is invalid");
      return document;
    } catch (error: any) {
      if (error?.code === "ENOENT") return structuredClone(EMPTY);
      throw error;
    }
  }

  private async write(document: CredentialDocument): Promise<void> {
    await mkdir(this.store.dir, { recursive: true, mode: 0o700 });
    await chmod(this.store.dir, 0o700).catch(() => undefined);
    const temp = `${this.file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }

  private async mutate<T>(fn: (document: CredentialDocument) => T | Promise<T>): Promise<T> {
    let result!: T;
    await this.store.update(async () => {
      const document = await this.read();
      result = await fn(document);
      await this.write(document);
    });
    return result;
  }

  async listCredentials(): Promise<CloudflareCredentialView[]> { return (await this.read()).accounts.map(viewOf); }

  async addCredential(input: AddCloudflareCredential): Promise<CloudflareCredentialView> {
    if (!input || !validLabel(input.label) || !validAccountId(input.accountId) || !validToken(input.token) ||
        (input.enabled !== undefined && typeof input.enabled !== "boolean")) throw new TypeError("Cloudflare credential is invalid");
    const accountId = input.accountId.toLowerCase();
    const allowedModels = validateModels(input.allowedModels ?? []);
    return this.mutate(async (document) => {
      if (document.accounts.some((account) => account.accountId === accountId)) throw new Error("Cloudflare account ID already exists");
      const now = Date.now();
      const account: CloudflareCredential = {
        id: randomToken(12), label: input.label, accountId, enabled: input.enabled ?? true, allowedModels,
        createdAt: now, secret: encryptSecret(input.token, await ensureMasterKey(this.store.keyPath)),
      };
      document.accounts.push(account);
      return viewOf(account);
    });
  }

  async updateCredential(id: string, patch: UpdateCloudflareCredential): Promise<CloudflareCredentialView> {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(id) || !patch || typeof patch !== "object" || Array.isArray(patch) ||
        Object.keys(patch).some((key) => !["label", "accountId", "token", "enabled", "allowedModels"].includes(key)) ||
        (patch.label !== undefined && !validLabel(patch.label)) || (patch.accountId !== undefined && !validAccountId(patch.accountId)) ||
        (patch.token !== undefined && !validToken(patch.token)) || (patch.enabled !== undefined && typeof patch.enabled !== "boolean")) {
      throw new TypeError("Cloudflare credential update is invalid");
    }
    const allowedModels = patch.allowedModels === undefined ? undefined : validateModels(patch.allowedModels);
    return this.mutate(async (document) => {
      const account = document.accounts.find((item) => item.id === id);
      if (!account) throw new Error("Cloudflare credential not found");
      const accountId = patch.accountId?.toLowerCase();
      if (accountId && document.accounts.some((item) => item.id !== id && item.accountId === accountId)) throw new Error("Cloudflare account ID already exists");
      if (patch.label !== undefined) account.label = patch.label;
      if (accountId !== undefined) account.accountId = accountId;
      if (patch.enabled !== undefined) account.enabled = patch.enabled;
      if (allowedModels !== undefined) account.allowedModels = allowedModels;
      if (patch.token !== undefined) account.secret = encryptSecret(patch.token, await ensureMasterKey(this.store.keyPath));
      return viewOf(account);
    });
  }

  async deleteCredential(id: string): Promise<boolean> {
    return this.mutate((document) => {
      const before = document.accounts.length;
      document.accounts = document.accounts.filter((account) => account.id !== id);
      return document.accounts.length !== before;
    });
  }

  async credentialForRequest(id: string): Promise<{ view: CloudflareCredentialView; token: string } | undefined> {
    const account = (await this.read()).accounts.find((entry) => entry.id === id);
    if (!account) return undefined;
    return { view: viewOf(account), token: decryptSecret(account.secret, await ensureMasterKey(this.store.keyPath)) };
  }

  async setCooldown(id: string, until: number): Promise<void> {
    if (!Number.isSafeInteger(until) || until < 0) throw new TypeError("Cloudflare cooldown is invalid");
    await this.mutate((document) => {
      const account = document.accounts.find((entry) => entry.id === id);
      if (account) account.cooldownUntil = Math.max(Date.now(), Math.min(until, Date.now() + 60 * 60_000));
    });
  }
}

export class CloudflareAIError extends Error {
  constructor(readonly code: "no_eligible_account" | "model_not_allowed" | "invalid_request" | "upstream_rejected" | "upstream_ambiguous" | "response_too_large", readonly status?: number) {
    super(code); this.name = "CloudflareAIError";
  }
}
export interface CloudflareAIOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxTokens?: number;
  maxInflightPerAccount?: number;
  now?: () => number;
}
export interface CloudflareInferenceInput { model: string; input: Record<string, unknown> }

/** Fixed-host Workers AI adapter with process-local least-inflight, round-robin selection. */
export class CloudflareAIAdapter {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly maxInflight: number;
  private readonly now: () => number;
  private readonly inflight = new Map<string, number>();
  private readonly dispatched = new Map<string, number>();
  private cursor = 0;
  private recent: Array<{ accountId: string; model: string; at: number; durationMs: number; status: string; usage?: Record<string, number> }> = [];
  snapshot() { return { inflight: Object.fromEntries(this.inflight), recent: this.recent.map(row => ({ ...row, ...(row.usage ? { usage: { ...row.usage } } : {}) })) }; }

  constructor(private readonly credentials: CloudflareCredentialStore, options: CloudflareAIOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxInflight = options.maxInflightPerAccount ?? 1;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000 ||
        !Number.isInteger(this.maxTokens) || this.maxTokens < 1 || this.maxTokens > 32_768 ||
        !Number.isInteger(this.maxInflight) || this.maxInflight < 1 || this.maxInflight > 32) throw new RangeError("Cloudflare adapter limits are invalid");
  }

  private async acquire(model?: string): Promise<{ view: CloudflareCredentialView; token: string; release: () => void }> {
    const [all, rules] = await Promise.all([this.credentials.listCredentials(), this.credentials.routingRules.read()]);
    const ruleFor = (id: string) => rules.resources[id];
    const eligible = all.filter((account) => account.enabled && ruleFor(account.id)?.enabled !== false && (account.cooldownUntil === undefined || account.cooldownUntil <= this.now()) &&
      (model === undefined || account.allowedModels.includes(model) && routingRuleAllowsModel(ruleFor(account.id), model)) &&
      (this.inflight.get(account.id) ?? 0) < boundedAccountCapacity(ruleFor(account.id)?.capacity, this.maxInflight));
    if (!eligible.length) {
      if (model && all.some((account) => account.enabled && account.allowedModels.includes(model) && routingRuleAllowsModel(ruleFor(account.id), model))) throw new CloudflareAIError("no_eligible_account");
      throw new CloudflareAIError(model ? "model_not_allowed" : "no_eligible_account");
    }
    const weighted = eligible.some((account) => (ruleFor(account.id)?.weight ?? 1) !== 1);
    let selected: CloudflareCredentialView;
    if (weighted) {
      const ordered = [...eligible].sort((a, b) => {
        const score = (x: CloudflareCredentialView) => ((this.dispatched.get(x.id) ?? 0) + (this.inflight.get(x.id) ?? 0)) / (ruleFor(x.id)?.weight ?? 1);
        return score(a) - score(b) || a.id.localeCompare(b.id);
      });
      const best = ordered[0]!;
      const score = (x: CloudflareCredentialView) => ((this.dispatched.get(x.id) ?? 0) + (this.inflight.get(x.id) ?? 0)) / (ruleFor(x.id)?.weight ?? 1);
      const ties = ordered.filter((x) => Math.abs(score(x) - score(best)) < 1e-9);
      selected = ties[this.cursor++ % ties.length]!;
    } else {
      const min = Math.min(...eligible.map((account) => this.inflight.get(account.id) ?? 0));
      const ties = eligible.filter((account) => (this.inflight.get(account.id) ?? 0) === min);
      selected = ties[this.cursor++ % ties.length]!;
    }
    this.inflight.set(selected.id, (this.inflight.get(selected.id) ?? 0) + 1);
    const release = () => {
      const count = this.inflight.get(selected.id) ?? 1;
      if (count <= 1) this.inflight.delete(selected.id); else this.inflight.set(selected.id, count - 1);
    };
    try {
      const credential = await this.credentials.credentialForRequest(selected.id);
      const latestRules = await this.credentials.routingRules.read();
      const latestRule = latestRules.resources[selected.id];
      if (!credential || !credential.view.enabled || (credential.view.cooldownUntil !== undefined && credential.view.cooldownUntil > this.now()) ||
          latestRule?.enabled === false || (this.inflight.get(selected.id) ?? 0) > boundedAccountCapacity(latestRule?.capacity, this.maxInflight) ||
          (model !== undefined && (!credential.view.allowedModels.includes(model) || !routingRuleAllowsModel(latestRule, model)))) throw new CloudflareAIError("no_eligible_account");
      this.dispatched.set(selected.id, (this.dispatched.get(selected.id) ?? 0) + 1);
      return { ...credential, release };
    } catch (error) { release(); throw error; }
  }

  private async request(account: { view: CloudflareCredentialView; token: string }, path: string, method: "GET" | "POST", body?: unknown, responseLimit = MAX_INFERENCE_BYTES): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account.view.accountId}${path}`, {
        method, signal: controller.signal, redirect: "error",
        headers: { authorization: `Bearer ${account.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        if (response.status === 429) await this.credentials.setCooldown(account.view.id, this.now() + 30_000);
        throw new CloudflareAIError("upstream_rejected", response.status);
      }
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > responseLimit) throw new CloudflareAIError("response_too_large");
      if (!response.body) return undefined;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > responseLimit) { await reader.cancel().catch(() => undefined); throw new CloudflareAIError("response_too_large"); }
        chunks.push(value);
      }
      const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).success === false) throw new CloudflareAIError("upstream_rejected", response.status);
        return parsed;
      } catch (error) {
        if (error instanceof CloudflareAIError) throw error;
        throw new CloudflareAIError("upstream_rejected", response.status);
      }
    } catch (error) {
      if (error instanceof CloudflareAIError) throw error;
      throw new CloudflareAIError("upstream_ambiguous");
    } finally { clearTimeout(timer); }
  }

  async listModels(): Promise<unknown> {
    const account = await this.acquire();
    try { return await this.request(account, "/ai/models/search", "GET", undefined, MAX_CATALOG_BYTES); }
    finally { account.release(); }
  }

  async run(input: CloudflareInferenceInput): Promise<unknown> {
    if (!input || !validModel(input.model) || !input.input || typeof input.input !== "object" || Array.isArray(input.input)) throw new CloudflareAIError("invalid_request");
    let json: string;
    try { json = JSON.stringify(input.input); } catch { throw new CloudflareAIError("invalid_request"); }
    if (Buffer.byteLength(json, "utf8") > 1_000_000) throw new CloudflareAIError("invalid_request");
    const account = await this.acquire(input.model);
    const started = this.now();
    let status = "failed";
    let usage: Record<string, number> | undefined;
    try {
      const requestInput: Record<string, unknown> = { ...input.input, max_tokens: input.input.max_tokens ?? this.maxTokens };
      if (requestInput.max_tokens !== undefined) {
        if (!Number.isSafeInteger(requestInput.max_tokens) || Number(requestInput.max_tokens) < 1) throw new CloudflareAIError("invalid_request");
        requestInput.max_tokens = Math.min(Number(requestInput.max_tokens), this.maxTokens);
      }
      const encodedModel = input.model.split("/").map((part) => encodeURIComponent(part)).join("/");
      const response = await this.request(account, `/ai/run/${encodedModel}`, "POST", requestInput);
      const raw = (response as any)?.result?.usage;
      if (raw && typeof raw === "object") {
        usage = Object.fromEntries(["prompt_tokens", "completion_tokens", "total_tokens", "neurons"].filter(key => typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0).map(key => [key, raw[key]]));
      }
      status = "succeeded";
      return response;
    } catch (error) { status = error instanceof CloudflareAIError ? error.code : "failed"; throw error; }
    finally {
      account.release();
      this.recent.push({ accountId: account.view.id, model: input.model, at: started, durationMs: Math.max(0, this.now() - started), status, ...(usage ? { usage } : {}) });
      if (this.recent.length > 100) this.recent.shift();
    }
  }
}
