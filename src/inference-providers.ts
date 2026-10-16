import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decryptSecret, encryptSecret, ensureMasterKey, randomToken } from "./crypto.js";
import type { EncryptedSecret } from "./types.js";
import type { StateStore } from "./store.js";
import { createPinnedPublicProviderFetch, type PublicProviderHttpOptions } from "./public-provider-http.js";

export type InferenceProvider = "openai" | "openrouter" | `custom-${string}`;
export type FixedInferenceProvider = "openai" | "openrouter";
export const INFERENCE_PROVIDER_PRESETS: Readonly<Record<InferenceProvider, { origin: string; label: string }>> = Object.freeze({
  openai: { origin: "https://api.openai.com/v1", label: "OpenAI" },
  openrouter: { origin: "https://openrouter.ai/api/v1", label: "OpenRouter" },
});

export interface InferenceAccountView {
  id: string;
  provider: InferenceProvider;
  label: string;
  enabled: boolean;
  allowedModels: string[];
  createdAt: number;
  cooldownUntil?: number;
}
interface InferenceAccount extends InferenceAccountView { secret: EncryptedSecret; tokenOrigin?: string }
export interface CustomInferenceProvider { id: `custom-${string}`; label: string; origin: string }
interface InferenceDocument { version: 1; accounts: InferenceAccount[]; customProviders?: CustomInferenceProvider[] }
export interface AddInferenceAccount {
  provider: InferenceProvider;
  label: string;
  token: string;
  allowedModels?: string[];
  enabled?: boolean;
}
export interface UpdateInferenceAccount { label?: string; token?: string; allowedModels?: string[]; enabled?: boolean }

const EMPTY: InferenceDocument = { version: 1, accounts: [] };
const MAX_ACCOUNTS = 200;
const MAX_MODELS = 200;
const MAX_TOKEN_BYTES = 4096;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,80}$/;

function isProvider(value: unknown): value is InferenceProvider { return value === "openai" || value === "openrouter" || typeof value === "string" && /^custom-[A-Za-z0-9_-]{24}$/.test(value); }
function validToken(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 8 && Buffer.byteLength(value, "utf8") <= MAX_TOKEN_BYTES && !/[\r\n\0]/.test(value);
}
function validLabel(value: unknown): value is string { return typeof value === "string" && value.trim() === value && LABEL.test(value); }
function validateModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_MODELS || value.some(model => typeof model !== "string" || !MODEL.test(model))) throw new TypeError("model allowlist is invalid");
  return [...new Set(value as string[])];
}
function viewOf({ secret: _secret, tokenOrigin: _tokenOrigin, ...view }: InferenceAccount): InferenceAccountView { return { ...view, allowedModels: [...view.allowedModels] }; }

const BLOCKED_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.test)$/i;
export function validateCustomOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 300) throw new TypeError("provider origin is invalid");
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("provider origin is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port && url.port !== "443" || BLOCKED_HOST.test(url.hostname) || url.hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || /[\\\0]/.test(url.pathname)) throw new TypeError("provider origin is invalid");
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

/** Encrypted credentials for the two fixed external OpenAI-compatible presets. */
export class InferenceProviderStore {
  private readonly file: string;
  constructor(private readonly store: StateStore) { this.file = join(store.dir, "inference-providers.json"); }

  private async read(): Promise<InferenceDocument> {
    try {
      const doc = JSON.parse(await readFile(this.file, "utf8")) as InferenceDocument;
      if (doc.version !== 1 || !Array.isArray(doc.accounts) || doc.accounts.length > MAX_ACCOUNTS || doc.customProviders !== undefined && (!Array.isArray(doc.customProviders) || doc.customProviders.length > 50)) throw new Error("inference provider store is invalid");
      return doc;
    } catch (caught: any) {
      if (caught?.code === "ENOENT") return structuredClone(EMPTY);
      throw caught;
    }
  }

  private async write(doc: InferenceDocument): Promise<void> {
    await mkdir(this.store.dir, { recursive: true, mode: 0o700 });
    await chmod(this.store.dir, 0o700).catch(() => undefined);
    const temp = `${this.file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
    await writeFile(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }

  private async mutate<T>(fn: (doc: InferenceDocument) => T | Promise<T>): Promise<T> {
    let result!: T;
    await this.store.update(async () => {
      const doc = await this.read();
      result = await fn(doc);
      await this.write(doc);
    });
    return result;
  }

  async listAccounts(): Promise<InferenceAccountView[]> { return (await this.read()).accounts.map(viewOf); }
  async listCustomProviders(): Promise<CustomInferenceProvider[]> { return structuredClone((await this.read()).customProviders ?? []); }
  async addCustomProvider(label: string, origin: string): Promise<CustomInferenceProvider> {
    if (!validLabel(label)) throw new TypeError("provider label is invalid");
    const safeOrigin = validateCustomOrigin(origin);
    return this.mutate(doc => { doc.customProviders ??= []; if (doc.customProviders.length >= 50) throw new Error("provider limit reached"); const p = { id: `custom-${randomBytes(12).toString("hex")}` as `custom-${string}`, label, origin: safeOrigin }; doc.customProviders.push(p); return p; });
  }
  async updateCustomProvider(id: string, label: string, origin: string): Promise<CustomInferenceProvider> {
    if (!/^custom-[A-Za-z0-9_-]{24}$/.test(id) || !validLabel(label)) throw new TypeError("provider update is invalid");
    const safeOrigin = validateCustomOrigin(origin);
    return this.mutate(doc => { const p = (doc.customProviders ?? []).find(x => x.id === id); if (!p) throw new Error("provider not found"); p.label = label; p.origin = safeOrigin; return p; });
  }
  async removeCustomProvider(id: string): Promise<boolean> {
    return this.mutate(doc => { if (doc.accounts.some(a => a.provider === id)) throw new Error("remove provider accounts first"); const i = (doc.customProviders ?? []).findIndex(x => x.id === id); if (i < 0) return false; doc.customProviders!.splice(i, 1); return true; });
  }
  async providerOrigin(id: InferenceProvider): Promise<string | undefined> { if (id === "openai" || id === "openrouter") return INFERENCE_PROVIDER_PRESETS[id].origin; return (await this.read()).customProviders?.find(p => p.id === id)?.origin; }

  async addAccount(input: AddInferenceAccount): Promise<InferenceAccountView> {
    if (!input || !isProvider(input.provider) || !validLabel(input.label) || !validToken(input.token) ||
        input.enabled !== undefined && typeof input.enabled !== "boolean") throw new TypeError("inference provider account is invalid");
    const allowedModels = validateModels(input.allowedModels ?? []);
    return this.mutate(async doc => {
      if (input.provider.startsWith("custom-") && !(doc.customProviders ?? []).some(p => p.id === input.provider)) throw new TypeError("provider is invalid");
      if (doc.accounts.length >= MAX_ACCOUNTS) throw new Error("inference provider account limit reached");
      const account: InferenceAccount = {
        id: randomToken(12), provider: input.provider, label: input.label, enabled: input.enabled ?? true,
        allowedModels, createdAt: Date.now(), secret: encryptSecret(input.token, await ensureMasterKey(this.store.keyPath)),
        tokenOrigin: input.provider.startsWith("custom-") ? doc.customProviders!.find(p => p.id === input.provider)!.origin : INFERENCE_PROVIDER_PRESETS[input.provider as FixedInferenceProvider].origin,
      };
      doc.accounts.push(account);
      return viewOf(account);
    });
  }

  async updateAccount(id: string, patch: UpdateInferenceAccount): Promise<InferenceAccountView> {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(id) || !patch || typeof patch !== "object" || Array.isArray(patch) ||
        !Object.keys(patch).length || Object.keys(patch).some(key => !["label", "token", "allowedModels", "enabled"].includes(key)) ||
        patch.label !== undefined && !validLabel(patch.label) || patch.token !== undefined && !validToken(patch.token) ||
        patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new TypeError("inference provider update is invalid");
    const allowedModels = patch.allowedModels === undefined ? undefined : validateModels(patch.allowedModels);
    return this.mutate(async doc => {
      const account = doc.accounts.find(item => item.id === id);
      if (!account) throw new Error("inference provider account not found");
      if (patch.label !== undefined) account.label = patch.label;
      if (allowedModels !== undefined) account.allowedModels = allowedModels;
      if (patch.enabled !== undefined) account.enabled = patch.enabled;
      if (patch.token !== undefined) {
        account.secret = encryptSecret(patch.token, await ensureMasterKey(this.store.keyPath));
        account.tokenOrigin = account.provider.startsWith("custom-") ? doc.customProviders?.find(p => p.id === account.provider)?.origin : INFERENCE_PROVIDER_PRESETS[account.provider as FixedInferenceProvider].origin;
      }
      return viewOf(account);
    });
  }

  async removeAccount(id: string): Promise<boolean> {
    return this.mutate(doc => {
      const index = doc.accounts.findIndex(item => item.id === id);
      if (index < 0) return false;
      doc.accounts.splice(index, 1);
      return true;
    });
  }

  async credentialForRequest(id: string): Promise<{ view: InferenceAccountView; token: string; origin?: string } | undefined> {
    const doc = await this.read();
    const account = doc.accounts.find(item => item.id === id);
    if (!account) return undefined;
    if (account.provider.startsWith("custom-") && !(doc.customProviders ?? []).some(p => p.id === account.provider)) return undefined;
    // Existing account ciphertext is bound to the origin when created; changing an endpoint
    // deliberately makes old credentials unusable until the operator replaces the token.
    const bound = (account as InferenceAccount & { tokenOrigin?: string }).tokenOrigin;
    const currentOrigin = account.provider.startsWith("custom-") ? (doc.customProviders ?? []).find(p => p.id === account.provider)?.origin : INFERENCE_PROVIDER_PRESETS[account.provider as FixedInferenceProvider].origin;
    if (account.provider.startsWith("custom-") && (!bound || bound !== currentOrigin)) return undefined;
    return { view: viewOf(account), token: decryptSecret(account.secret, await ensureMasterKey(this.store.keyPath)), origin: currentOrigin };
  }

  async setCooldown(id: string, until: number): Promise<void> {
    if (!Number.isSafeInteger(until) || until < 0) throw new TypeError("cooldown is invalid");
    await this.mutate(doc => {
      const account = doc.accounts.find(item => item.id === id);
      if (account) account.cooldownUntil = Math.min(Date.now() + 60 * 60_000, Math.max(Date.now(), until));
    });
  }
}

export class InferenceProviderError extends Error {
  constructor(readonly code: "invalid_request" | "model_not_allowed" | "no_eligible_account" | "upstream_rejected" | "upstream_ambiguous" | "response_too_large", readonly status?: number) {
    super(code); this.name = "InferenceProviderError";
  }
}
export interface InferenceProviderOptions {
  /** Test seam for fixed preset transport only. Custom providers require publicFetch injection explicitly. */
  fetch?: typeof globalThis.fetch;
  publicFetch?: typeof globalThis.fetch;
  publicHttp?: PublicProviderHttpOptions;
  timeoutMs?: number;
  maxInflightPerAccount?: number;
  now?: () => number;
}
export interface InferenceRequest { provider: InferenceProvider; model: string; body: Record<string, unknown> }

async function responseJson(response: globalThis.Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new InferenceProviderError("response_too_large");
  if (!response.body) return undefined;
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new InferenceProviderError("response_too_large"); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { throw new InferenceProviderError("upstream_rejected", response.status); }
}

/** Fixed-origin adapter. It sends each inference at most once and never follows redirects. */
export class OpenAICompatibleInferenceAdapter {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly publicFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxInflight: number;
  private readonly now: () => number;
  private readonly inflight = new Map<string, number>();
  private cursor = 0;

  constructor(private readonly accounts: InferenceProviderStore, options: InferenceProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.publicFetch = options.publicFetch ?? createPinnedPublicProviderFetch({ ...options.publicHttp, timeoutMs: options.timeoutMs ?? 60_000 });
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxInflight = options.maxInflightPerAccount ?? 1;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 300_000 || !Number.isInteger(this.maxInflight) || this.maxInflight < 1 || this.maxInflight > 16) throw new RangeError("inference adapter limits are invalid");
  }

  async complete(request: InferenceRequest): Promise<unknown> {
    if (!request || !isProvider(request.provider) || typeof request.model !== "string" || !MODEL.test(request.model) ||
        !request.body || typeof request.body !== "object" || Array.isArray(request.body) || !Array.isArray(request.body.messages) || request.body.stream === true) throw new InferenceProviderError("invalid_request");
    const body: Record<string, unknown> = { ...request.body, model: request.model };
    const limitKeys = ["max_tokens", "max_completion_tokens"].filter(key => body[key] !== undefined);
    if (limitKeys.length > 1 || limitKeys.some(key => !Number.isSafeInteger(body[key]) || Number(body[key]) < 1)) throw new InferenceProviderError("invalid_request");
    const limitKey = limitKeys[0] ?? (request.provider === "openai" ? "max_completion_tokens" : "max_tokens");
    body[limitKey] = Math.min(Number(body[limitKey] ?? 4096), 8192);
    let encoded: string;
    try { encoded = JSON.stringify(body); }
    catch { throw new InferenceProviderError("invalid_request"); }
    if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) throw new InferenceProviderError("invalid_request");

    const all = await this.accounts.listAccounts();
    const configured = all.filter(account => account.provider === request.provider && account.enabled && account.allowedModels.includes(request.model));
    const eligible = configured.filter(account => (account.cooldownUntil ?? 0) <= this.now() && (this.inflight.get(account.id) ?? 0) < this.maxInflight);
    if (!eligible.length) {
      if (!configured.length) throw new InferenceProviderError("model_not_allowed");
      throw new InferenceProviderError("no_eligible_account");
    }
    let selected: InferenceAccountView | undefined;
    for (let attempt = 0; attempt < eligible.length; attempt++) {
      const candidate = eligible[this.cursor++ % eligible.length]!;
      if ((this.inflight.get(candidate.id) ?? 0) >= this.maxInflight) continue;
      selected = candidate;
      this.inflight.set(candidate.id, (this.inflight.get(candidate.id) ?? 0) + 1);
      break;
    }
    if (!selected) throw new InferenceProviderError("no_eligible_account");
    const release = () => {
      const active = Math.max(0, (this.inflight.get(selected!.id) ?? 1) - 1);
      if (active) this.inflight.set(selected!.id, active); else this.inflight.delete(selected!.id);
    };
    try {
      const credential = await this.accounts.credentialForRequest(selected.id);
      if (!credential || !credential.view.enabled || credential.view.provider !== request.provider || !credential.view.allowedModels.includes(request.model) || (credential.view.cooldownUntil ?? 0) > this.now()) throw new InferenceProviderError("no_eligible_account");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        let response: globalThis.Response;
        try {
          const custom = request.provider.startsWith("custom-");
          const origin = custom ? credential.origin : INFERENCE_PROVIDER_PRESETS[request.provider as FixedInferenceProvider].origin;
          if (!origin) throw new InferenceProviderError("no_eligible_account");
          response = await (custom ? this.publicFetch : this.fetchImpl)(`${origin.replace(/\/$/, "")}/chat/completions`, {
            method: "POST", signal: controller.signal, redirect: "error",
            headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json", accept: "application/json" }, body: encoded,
          });
        } catch (caught) {
          if (caught instanceof Error && caught.message === "response_too_large") throw new InferenceProviderError("response_too_large");
          throw new InferenceProviderError("upstream_ambiguous");
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          if (response.status === 429 || response.status === 402) await this.accounts.setCooldown(selected.id, this.now() + 30_000);
          throw new InferenceProviderError("upstream_rejected", response.status);
        }
        return await responseJson(response);
      } catch (caught) {
        if (caught instanceof InferenceProviderError) throw caught;
        throw new InferenceProviderError("upstream_ambiguous");
      } finally { clearTimeout(timer); }
    } finally { release(); }
  }
}
