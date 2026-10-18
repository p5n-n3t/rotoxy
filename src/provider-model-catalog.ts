import { INFERENCE_PROVIDER_PRESETS, type InferenceProviderStore } from "./inference-providers.js";
import { createPinnedPublicProviderFetch } from "./public-provider-http.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 2_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export interface ProviderCatalogModel { id: string; name: string; free: boolean | null }

interface ParsedPrice { value: number; exactZero: boolean }
function priceValue(value: unknown): ParsedPrice | undefined {
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  const significand = value.split(/[eE]/, 1)[0]!.replace(".", "");
  const exactZero = !/[1-9]/.test(significand);
  if (numeric === 0 && !exactZero) return undefined;
  return { value: numeric, exactZero };
}

/** Normalize OpenAI-compatible /models JSON without treating unknown prices as free. */
export function parseProviderModelCatalog(payload: unknown, provider: string): ProviderCatalogModel[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) throw new TypeError("catalog_invalid");
  const rows = (payload as { data: unknown[] }).data;
  if (rows.length > MAX_MODELS) throw new RangeError("catalog_too_large");
  const byId = new Map<string, ProviderCatalogModel>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    if (typeof item.id !== "string" || !MODEL_ID.test(item.id)) continue;
    const name = typeof item.name === "string" && item.name.length <= 240 ? item.name : item.id;
    const pricing = item.pricing && typeof item.pricing === "object" ? item.pricing as Record<string, unknown> : undefined;
    const promptPrice = pricing ? priceValue(pricing.prompt) : undefined;
    const completionPrice = pricing ? priceValue(pricing.completion) : undefined;
    const requestPrice = pricing && Object.hasOwn(pricing, "request") ? priceValue(pricing.request) : undefined;
    const hasRequestPrice = pricing ? Object.hasOwn(pricing, "request") : false;
    const free = provider !== "openrouter" || promptPrice === undefined || completionPrice === undefined || hasRequestPrice && requestPrice === undefined
      ? null
      : promptPrice.value > 0 || completionPrice.value > 0 || requestPrice && requestPrice.value > 0
        ? false
        : promptPrice.exactZero && completionPrice.exactZero && (!hasRequestPrice || requestPrice!.exactZero);
    byId.set(item.id, { id: item.id, name, free });
  }
  return [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BYTES) throw new RangeError("catalog_too_large");
  if (!response.body) throw new TypeError("catalog_invalid");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new RangeError("catalog_too_large"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size).toString("utf8")); }
  catch { throw new TypeError("catalog_invalid"); }
}

export interface ProviderCatalogOptions { fetch?: typeof globalThis.fetch; timeoutMs?: number; allowDisabled?: boolean }
export type ProviderCatalogFailure = "account_not_found" | "account_disabled" | "credential_replacement_required" |
  "authentication_rejected" | "models_endpoint_missing" | "catalog_rejected" | "catalog_invalid" |
  "catalog_too_large" | "catalog_unavailable";
export class ProviderCatalogError extends Error {
  constructor(readonly code: ProviderCatalogFailure) { super(code); this.name = "ProviderCatalogError"; }
}

/** Explicit metadata-only GET. Uses a fixed preset origin and the account's stored credential. */
export async function fetchProviderModelCatalog(accounts: InferenceProviderStore, accountId: string, options: ProviderCatalogOptions = {}): Promise<ProviderCatalogModel[]> {
  if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(accountId)) throw new ProviderCatalogError("account_not_found");
  const credential = await accounts.credentialForRequest(accountId);
  if (!credential) {
    // Endpoint edits intentionally invalidate origin-bound credentials until replaced.
    const saved = (await accounts.listAccounts?.() ?? []).find(item => item.id === accountId);
    throw new ProviderCatalogError(saved ? "credential_replacement_required" : "account_not_found");
  }
  if (!credential.view.enabled && !options.allowDisabled) throw new ProviderCatalogError("account_disabled");
  const origin = credential.origin ?? (credential.view.provider === "openai" || credential.view.provider === "openrouter" ? INFERENCE_PROVIDER_PRESETS[credential.view.provider].origin : undefined);
  if (!origin) throw new ProviderCatalogError("catalog_unavailable");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    // Custom provider discovery retains pinned DNS/public-IP/TLS controls; never follows redirects.
    const response = await (options.fetch ?? createPinnedPublicProviderFetch({ timeoutMs: options.timeoutMs ?? 15_000, allowGet: true }))(origin.replace(/\/$/, "") + "/models", {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { authorization: "Bearer " + credential.token, accept: "application/json" },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderCatalogError(response.status === 401 || response.status === 403 ? "authentication_rejected" : response.status === 404 ? "models_endpoint_missing" : "catalog_rejected");
    }
    return parseProviderModelCatalog(await readBoundedJson(response), credential.view.provider);
  } catch (error) {
    if (error instanceof ProviderCatalogError) throw error;
    if (error instanceof RangeError) throw new ProviderCatalogError("catalog_too_large");
    if (error instanceof TypeError && error.message === "catalog_invalid") throw new ProviderCatalogError("catalog_invalid");
    throw new ProviderCatalogError("catalog_unavailable");
  } finally { clearTimeout(timer); }
}
