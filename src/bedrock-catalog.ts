import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import type { StateStore } from "./store.js";
import type { BedrockTransport } from "./bedrock-messages.js";

const MAX_ROWS = 2_000;
const MAX_PAGES = 20;
const MAX_TIMEOUT_MS = 20_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const BEDROCK_KEY = "bedrock";

export interface BedrockCatalogModel { id: string; name: string; source: "runtime-foundation-model" | "runtime-inference-profile" | "mantle"; entitlement: "unknown" }
export interface BedrockSettings { region: string; transport: BedrockTransport; enabledModels: string[] }
export interface BedrockCatalogSnapshot { region: string; transport: BedrockTransport; refreshedAt: number; models: BedrockCatalogModel[]; truncated: boolean }
interface BedrockDocument { settings?: BedrockSettings; catalog?: BedrockCatalogSnapshot }
type StateWithBedrock = { [BEDROCK_KEY]?: BedrockDocument };

export interface RuntimeBedrockCatalogClient {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  destroy?(): void;
}
export interface BedrockCatalogOptions {
  runtimeClientFactory?: (region: string, timeoutMs: number) => RuntimeBedrockCatalogClient;
  mantleList?: (region: string, timeoutMs: number, signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
}

export function normalizeBedrockSettings(input: unknown): BedrockSettings {
  if (!input || typeof input !== "object") throw new TypeError("bedrock_settings_invalid");
  const value = input as Record<string, unknown>;
  if (typeof value.region !== "string" || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(value.region)) throw new TypeError("bedrock_region_invalid");
  if (value.transport !== "invoke" && value.transport !== "mantle") throw new TypeError("bedrock_transport_invalid");
  if (!Array.isArray(value.enabledModels) || value.enabledModels.length > 100 || value.enabledModels.some(id => typeof id !== "string" || !MODEL_ID.test(id))) throw new TypeError("bedrock_models_invalid");
  return { region: value.region, transport: value.transport, enabledModels: [...new Set(value.enabledModels as string[])] };
}

export async function loadBedrockSettings(store: StateStore): Promise<BedrockSettings | undefined> {
  const state = await store.load();
  const rawDocument: unknown = (state as typeof state & StateWithBedrock)[BEDROCK_KEY];
  if (rawDocument === undefined) return undefined;
  if (!rawDocument || typeof rawDocument !== "object" || Array.isArray(rawDocument)) throw new Error("bedrock_settings_invalid");
  const document = rawDocument as BedrockDocument;
  if (!Object.hasOwn(document, "settings")) return undefined;
  try { return normalizeBedrockSettings(document.settings); }
  catch { throw new Error("bedrock_settings_invalid"); }
}

export async function saveBedrockSettings(store: StateStore, settings: BedrockSettings): Promise<BedrockSettings> {
  const normalized = normalizeBedrockSettings(settings);
  await store.update(state => {
    const extended = state as typeof state & StateWithBedrock;
    extended[BEDROCK_KEY] ??= {};
    extended[BEDROCK_KEY]!.settings = normalized;
  });
  return normalized;
}

export async function loadBedrockCatalog(store: StateStore): Promise<BedrockCatalogSnapshot | undefined> {
  const state = await store.load();
  const snapshot = (state as typeof state & StateWithBedrock)[BEDROCK_KEY]?.catalog;
  if (!snapshot || !Array.isArray(snapshot.models)) return undefined;
  return snapshot;
}

function runtimeClient(region: string, timeoutMs: number): RuntimeBedrockCatalogClient {
  // The command's AbortSignal provides the hard wall-clock bound. maxAttempts: 1
  // prevents the SDK from replaying even metadata calls on retryable errors.
  void timeoutMs;
  return new BedrockClient({ region, maxAttempts: 1 }) as unknown as RuntimeBedrockCatalogClient;
}

async function defaultMantleList(region: string, timeoutMs: number, signal: AbortSignal): Promise<{ data: unknown[]; truncated: boolean }> {
  const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
  const client = new AnthropicBedrockMantle({
    awsRegion: region, baseURL: `https://bedrock-mantle.${region}.api.aws/anthropic`,
    timeout: timeoutMs, maxRetries: 0, fetchOptions: { redirect: "error" },
  });
  const data: unknown[] = []; let after: string | undefined; let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal.aborted) throw new Error("catalog_timeout");
    const response = await client.get<{ data?: unknown[]; has_more?: boolean; last_id?: string }>("/v1/models", {
      query: { limit: "100", ...(after ? { after } : {}) }, signal,
    });
    const payload = await response;
    if (!Array.isArray(payload.data)) throw new Error("catalog_invalid");
    data.push(...payload.data.slice(0, MAX_ROWS - data.length));
    if (data.length >= MAX_ROWS) { truncated = Boolean(payload.has_more || payload.last_id); break; }
    if (!payload.has_more || typeof payload.last_id !== "string" || !payload.last_id) break;
    if (page === MAX_PAGES - 1) { truncated = true; break; }
    after = payload.last_id;
  }
  return { data, truncated };
}

function pickRows(payload: unknown, source: BedrockCatalogModel["source"]): BedrockCatalogModel[] {
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  const rows = Array.isArray(obj.modelSummaries) ? obj.modelSummaries : Array.isArray(obj.inferenceProfileSummaries) ? obj.inferenceProfileSummaries : Array.isArray(obj.data) ? obj.data : [];
  const result: BedrockCatalogModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const id = item.modelId ?? item.inferenceProfileId ?? item.id;
    // This catalog configures the native Anthropic Messages adapter. Keep only
    // Anthropic model IDs and cross-region profiles that it can address.
    if (typeof id !== "string" || !MODEL_ID.test(id) || !/^(?:[a-z0-9-]+\.)?anthropic\./i.test(id)) continue;
    const name = item.modelName ?? item.inferenceProfileName ?? item.name;
    result.push({ id, name: typeof name === "string" && name.length <= 240 ? name : id, source, entitlement: "unknown" });
  }
  return result;
}

async function discoverRuntime(client: RuntimeBedrockCatalogClient, signal: AbortSignal): Promise<{ models: BedrockCatalogModel[]; truncated: boolean }> {
  const models = new Map<string, BedrockCatalogModel>(); let truncated = false;
  if (signal.aborted) throw new Error("catalog_timeout");
  const foundationPayload = await client.send(new ListFoundationModelsCommand({ byProvider: "Anthropic" }), { abortSignal: signal });
  const foundationRows = pickRows(foundationPayload, "runtime-foundation-model");
  for (const model of foundationRows.slice(0, MAX_ROWS)) models.set(`${model.source}:${model.id}`, model);
  if (foundationRows.length > MAX_ROWS) truncated = true;

  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES && models.size < MAX_ROWS; page++) {
    if (signal.aborted) throw new Error("catalog_timeout");
    const command = new ListInferenceProfilesCommand(token ? { nextToken: token } : {});
    const result = await client.send(command, { abortSignal: signal });
    for (const model of pickRows(result, "runtime-inference-profile")) {
      models.set(`${model.source}:${model.id}`, model);
      if (models.size >= MAX_ROWS) { truncated = true; break; }
    }
    const next = result && typeof result === "object" ? (result as Record<string, unknown>).nextToken : undefined;
    if (typeof next !== "string" || !next) break;
    if (page === MAX_PAGES - 1 || models.size >= MAX_ROWS) { truncated = true; break; }
    token = next;
  }
  return { models: [...models.values()].slice(0, MAX_ROWS).sort((a, b) => a.id.localeCompare(b.id) || a.source.localeCompare(b.source)), truncated };
}

export async function refreshBedrockCatalog(store: StateStore, settingsInput: BedrockSettings, options: BedrockCatalogOptions = {}): Promise<BedrockCatalogSnapshot> {
  const settings = normalizeBedrockSettings(settingsInput);
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) throw new Error("bedrock_catalog_unavailable");
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs! >= 100 && options.timeoutMs! <= MAX_TIMEOUT_MS ? options.timeoutMs! : 12_000;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  let client: RuntimeBedrockCatalogClient | undefined;
  try {
    let found: { models: BedrockCatalogModel[]; truncated: boolean };
    if (settings.transport === "invoke") {
      client = (options.runtimeClientFactory ?? runtimeClient)(settings.region, timeoutMs);
      found = await discoverRuntime(client, controller.signal);
    } else {
      const payload = await (options.mantleList ?? defaultMantleList)(settings.region, timeoutMs, controller.signal);
      const rows = Array.isArray(payload) ? payload : payload && typeof payload === "object" && "data" in payload ? payload : { data: [] };
      found = { models: pickRows(rows, "mantle").slice(0, MAX_ROWS), truncated: Boolean((payload as { truncated?: unknown })?.truncated) };
    }
    const snapshot: BedrockCatalogSnapshot = { region: settings.region, transport: settings.transport, refreshedAt: (options.now ?? Date.now)(), ...found };
    await store.update(state => {
      const extended = state as typeof state & StateWithBedrock;
      extended[BEDROCK_KEY] ??= {};
      extended[BEDROCK_KEY]!.catalog = snapshot;
    });
    return snapshot;
  } catch {
    if (controller.signal.aborted) throw new Error("bedrock_catalog_timeout");
    throw new Error("bedrock_catalog_unavailable");
  } finally { clearTimeout(timer); client?.destroy?.(); }
}
