/**
 * Capability-scoped Tavily Search and Extract REST adapter.
 * This module is injectable and is not wired into the shared provider registry.
 */

export const TAVILY_API_ORIGIN = "https://api.tavily.com";
export const TAVILY_LIMITS = Object.freeze({
  queryChars: 2_000,
  urlChars: 2_048,
  maxResults: 20,
  maxExtractUrls: 1,
  maxSnippetChars: 20_000,
  maxContentChars: 100_000,
  maxResponseBytes: 1_000_000,
  maxRequestBytes: 32_000,
  maxTimeoutMs: 30_000,
  maxDomainFilters: 300,
  maxExcludedDomains: 150,
});

export const TAVILY_CAPABILITIES = Object.freeze({
  search: "supported",
  extract: "supported",
  map: "unsupported",
  crawl: "unsupported",
  research: "unsupported",
  usage: "unsupported",
} as const);

export type TavilySearchDepth = "basic" | "advanced" | "fast" | "ultra-fast";
export type TavilyTopic = "general" | "news" | "finance";
export type TavilyTimeRange = "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y";
export type TavilySearchAnswer = boolean | "basic" | "advanced";
export type TavilyRawContent = boolean | "markdown" | "text";

/** Only request fields documented by Tavily Search are accepted here. */
export interface TavilySearchOptions {
  searchDepth?: TavilySearchDepth;
  chunksPerSource?: number;
  topic?: TavilyTopic;
  timeRange?: TavilyTimeRange;
  startDate?: string;
  endDate?: string;
  includePublishedDate?: boolean;
  filterByPublishedDate?: boolean;
  includeAnswer?: TavilySearchAnswer;
  includeRawContent?: TavilyRawContent;
  includeImages?: boolean;
  includeImageDescriptions?: boolean;
  includeFavicon?: boolean;
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
  includeDomainsMode?: "restrict" | "prefer";
  country?: string;
  language?: string;
  filterByLanguage?: boolean;
  autoParameters?: boolean;
  exactMatch?: boolean;
  includeUsage?: boolean;
  safeSearch?: boolean;
}

/** Only request fields documented by Tavily Extract are accepted here. */
export interface TavilyExtractOptions {
  query?: string;
  chunksPerSource?: number;
  extractDepth?: "basic" | "advanced";
  includeImages?: boolean;
  includeFavicon?: boolean;
  format?: "markdown" | "text";
  timeoutSeconds?: number;
  includeUsage?: boolean;
}

export type TavilyErrorCategory = "auth" | "quota" | "rate_limit" | "transient" | "unknown";
export type TavilyRequestOutcome = "not_sent" | "rejected" | "unknown";

export class TavilyProviderError extends Error {
  readonly name = "TavilyProviderError";

  constructor(
    readonly category: TavilyErrorCategory,
    readonly requestOutcome: TavilyRequestOutcome,
    message: string,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class TavilyInputError extends TypeError {
  readonly name = "TavilyInputError";
}

export type TavilyUsage =
  | { known: true; credits: number; source: "provider-response" }
  | { known: false; reason: string };

export interface TavilySearchResult {
  url: string;
  title?: string;
  snippet?: string;
  rawContent?: string;
  publishedAt?: string;
  score?: number;
}

export interface TavilyImageResult { url: string; description?: string }

export interface TavilySearchResponse {
  provider: "tavily";
  results: TavilySearchResult[];
  usage: TavilyUsage;
  answer?: string;
  images?: TavilyImageResult[];
  responseTime?: number;
}

export interface TavilyExtractResult {
  url: string;
  content?: string;
  images?: string[];
  favicon?: string;
}

export interface TavilyExtractResponse {
  provider: "tavily";
  results: TavilyExtractResult[];
  /** Per-URL failure details are intentionally reduced to their URL. */
  failedResults: Array<{ url?: string }>;
  usage: TavilyUsage;
  responseTime?: number;
}

export interface TavilyAdapter {
  readonly provider: "tavily";
  readonly capabilities: typeof TAVILY_CAPABILITIES;
  search(request: {
    query: string;
    maxResults?: number;
    providerOptions?: TavilySearchOptions;
    signal?: AbortSignal;
  }): Promise<TavilySearchResponse>;
  extract(request: {
    url: string;
    providerOptions?: TavilyExtractOptions;
    signal?: AbortSignal;
  }): Promise<TavilyExtractResponse>;
}

export interface TavilyAdapterDependencies {
  fetch?: typeof globalThis.fetch;
  /** Resolve a current credential at call time; this module never reads env/config. */
  resolveCredential(): string | Promise<string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

type JsonRecord = Record<string, unknown>;
const DEFAULT_TIMEOUT_MS = 15_000;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SEARCH_DEPTHS = new Set<TavilySearchDepth>(["basic", "advanced", "fast", "ultra-fast"]);
const TOPICS = new Set<TavilyTopic>(["general", "news", "finance"]);
const TIME_RANGES = new Set<TavilyTimeRange>(["day", "week", "month", "year", "d", "w", "m", "y"]);

function invalid(label: string): never { throw new TavilyInputError(`${label} is invalid`); }

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label);
  return value as JsonRecord;
}

function validateOnlyKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid(`${label} contains an unsupported option`);
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || CONTROL_CHARS.test(value)) invalid(label);
  return value;
}

function validateQuery(value: unknown): string {
  return boundedText(value, "query", TAVILY_LIMITS.queryChars);
}

function validateUrl(value: unknown): string {
  const input = boundedText(value, "url", TAVILY_LIMITS.urlChars);
  let url: URL;
  try { url = new URL(input); } catch { return invalid("url"); }
  if (!(url.protocol === "https:" || url.protocol === "http:") || !url.hostname || url.username || url.password) invalid("url");
  return url.toString();
}

function dateValue(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(label);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) invalid(label);
  return value;
}

function boolOption(options: JsonRecord, key: string, label: string): boolean | undefined {
  if (options[key] === undefined) return undefined;
  if (typeof options[key] !== "boolean") invalid(label);
  return options[key] as boolean;
}

function domainList(value: unknown, label: string, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max || value.some((domain) =>
    typeof domain !== "string" || !domain.trim() || domain.length > 253 || CONTROL_CHARS.test(domain))) invalid(label);
  return [...value] as string[];
}

function validateSearchOptions(input: unknown): Record<string, unknown> {
  const options = input === undefined ? {} : asRecord(input, "search options");
  validateOnlyKeys(options, [
    "searchDepth", "chunksPerSource", "topic", "timeRange", "startDate", "endDate",
    "includePublishedDate", "filterByPublishedDate", "includeAnswer", "includeRawContent",
    "includeImages", "includeImageDescriptions", "includeFavicon", "includeDomains",
    "excludeDomains", "includeDomainsMode", "country", "language", "filterByLanguage",
    "autoParameters", "exactMatch", "includeUsage", "safeSearch",
  ], "search options");
  const depth = options.searchDepth === undefined ? undefined : options.searchDepth as TavilySearchDepth;
  if (depth !== undefined && !SEARCH_DEPTHS.has(depth)) invalid("searchDepth");
  const chunks = options.chunksPerSource;
  if (chunks !== undefined && (!Number.isInteger(chunks) || (chunks as number) < 1 || (chunks as number) > 3 || depth === "ultra-fast")) invalid("chunksPerSource");
  const topic = options.topic === undefined ? undefined : options.topic as TavilyTopic;
  if (topic !== undefined && !TOPICS.has(topic)) invalid("topic");
  const timeRange = options.timeRange === undefined ? undefined : options.timeRange as TavilyTimeRange;
  if (timeRange !== undefined && !TIME_RANGES.has(timeRange)) invalid("timeRange");
  const startDate = dateValue(options.startDate, "startDate");
  const endDate = dateValue(options.endDate, "endDate");
  if (startDate && endDate && startDate > endDate) invalid("date range");
  const includeAnswer = options.includeAnswer;
  if (includeAnswer !== undefined && typeof includeAnswer !== "boolean" && !["basic", "advanced"].includes(includeAnswer as string)) invalid("includeAnswer");
  const includeRawContent = options.includeRawContent;
  if (includeRawContent !== undefined && typeof includeRawContent !== "boolean" && !["markdown", "text"].includes(includeRawContent as string)) invalid("includeRawContent");
  const includeImages = boolOption(options, "includeImages", "includeImages");
  const includeImageDescriptions = boolOption(options, "includeImageDescriptions", "includeImageDescriptions");
  if (includeImageDescriptions && !includeImages) invalid("includeImageDescriptions requires includeImages");
  const includeDomains = domainList(options.includeDomains, "includeDomains", TAVILY_LIMITS.maxDomainFilters);
  const excludeDomains = domainList(options.excludeDomains, "excludeDomains", TAVILY_LIMITS.maxExcludedDomains);
  const includeDomainsMode = options.includeDomainsMode;
  if (includeDomainsMode !== undefined && includeDomainsMode !== "restrict" && includeDomainsMode !== "prefer") invalid("includeDomainsMode");
  if (includeDomainsMode !== undefined && !includeDomains?.length) invalid("includeDomainsMode requires includeDomains");
  const country = options.country === undefined ? undefined : boundedText(options.country, "country", 64).toLowerCase();
  if (country && topic !== undefined && topic !== "general") invalid("country requires the general topic");
  const language = options.language === undefined ? undefined : boundedText(options.language, "language", 64);
  const filterByLanguage = boolOption(options, "filterByLanguage", "filterByLanguage");
  if (filterByLanguage && !language) invalid("filterByLanguage requires language");
  const safeSearch = boolOption(options, "safeSearch", "safeSearch");
  if (safeSearch !== undefined && (depth === "fast" || depth === "ultra-fast")) invalid("safeSearch is not supported for this searchDepth");
  return {
    ...(depth ? { search_depth: depth } : {}),
    ...(chunks !== undefined ? { chunks_per_source: chunks } : {}),
    ...(topic ? { topic } : {}), ...(timeRange ? { time_range: timeRange } : {}),
    ...(startDate ? { start_date: startDate } : {}), ...(endDate ? { end_date: endDate } : {}),
    ...(boolOption(options, "includePublishedDate", "includePublishedDate") !== undefined ? { include_published_date: options.includePublishedDate } : {}),
    ...(boolOption(options, "filterByPublishedDate", "filterByPublishedDate") !== undefined ? { filter_by_published_date: options.filterByPublishedDate } : {}),
    ...(includeAnswer !== undefined ? { include_answer: includeAnswer } : {}),
    ...(includeRawContent !== undefined ? { include_raw_content: includeRawContent } : {}),
    ...(includeImages !== undefined ? { include_images: includeImages } : {}),
    ...(includeImageDescriptions !== undefined ? { include_image_descriptions: includeImageDescriptions } : {}),
    ...(boolOption(options, "includeFavicon", "includeFavicon") !== undefined ? { include_favicon: options.includeFavicon } : {}),
    ...(includeDomains ? { include_domains: includeDomains } : {}), ...(excludeDomains ? { exclude_domains: excludeDomains } : {}),
    ...(includeDomainsMode ? { include_domains_mode: includeDomainsMode } : {}),
    ...(country ? { country } : {}), ...(language ? { language } : {}),
    ...(filterByLanguage !== undefined ? { filter_by_language: filterByLanguage } : {}),
    ...(boolOption(options, "autoParameters", "autoParameters") !== undefined ? { auto_parameters: options.autoParameters } : {}),
    ...(boolOption(options, "exactMatch", "exactMatch") !== undefined ? { exact_match: options.exactMatch } : {}),
    ...(boolOption(options, "includeUsage", "includeUsage") !== undefined ? { include_usage: options.includeUsage } : {}),
    ...(safeSearch !== undefined ? { safe_search: safeSearch } : {}),
  };
}

function validateExtractOptions(input: unknown): Record<string, unknown> {
  const options = input === undefined ? {} : asRecord(input, "extract options");
  validateOnlyKeys(options, ["query", "chunksPerSource", "extractDepth", "includeImages", "includeFavicon", "format", "timeoutSeconds", "includeUsage"], "extract options");
  const query = options.query === undefined ? undefined : validateQuery(options.query);
  const chunks = options.chunksPerSource;
  if (chunks !== undefined && (!Number.isInteger(chunks) || (chunks as number) < 1 || (chunks as number) > 5 || !query)) invalid("chunksPerSource requires query and must be 1–5");
  const extractDepth = options.extractDepth;
  if (extractDepth !== undefined && extractDepth !== "basic" && extractDepth !== "advanced") invalid("extractDepth");
  const format = options.format;
  if (format !== undefined && format !== "markdown" && format !== "text") invalid("format");
  const timeout = options.timeoutSeconds;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1 || timeout > 60)) invalid("timeoutSeconds");
  return {
    ...(query ? { query } : {}), ...(chunks !== undefined ? { chunks_per_source: chunks } : {}),
    ...(extractDepth ? { extract_depth: extractDepth } : {}),
    ...(boolOption(options, "includeImages", "includeImages") !== undefined ? { include_images: options.includeImages } : {}),
    ...(boolOption(options, "includeFavicon", "includeFavicon") !== undefined ? { include_favicon: options.includeFavicon } : {}),
    ...(format ? { format } : {}), ...(timeout !== undefined ? { timeout } : {}),
    ...(boolOption(options, "includeUsage", "includeUsage") !== undefined ? { include_usage: options.includeUsage } : {}),
  };
}

function timeoutValue(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 1) invalid("timeoutMs");
  return Math.min(TAVILY_LIMITS.maxTimeoutMs, Math.floor(value));
}

function responseLimit(value: number | undefined): number {
  if (value === undefined) return TAVILY_LIMITS.maxResponseBytes;
  if (!Number.isFinite(value) || value < 1) invalid("maxResponseBytes");
  return Math.min(TAVILY_LIMITS.maxResponseBytes, Math.floor(value));
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new TavilyProviderError("unknown", "unknown", "Tavily response exceeded the configured size limit", response.status);
  }
  if (!response.body) throw new TavilyProviderError("unknown", "unknown", "Tavily returned an empty response", response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TavilyProviderError("unknown", "unknown", "Tavily response exceeded the configured size limit", response.status);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new TavilyProviderError("unknown", "unknown", "Tavily returned invalid JSON", response.status); }
}

function httpError(status: number, headers: Headers): TavilyProviderError {
  let category: TavilyErrorCategory = "unknown";
  if (status === 401) category = "auth";
  else if (status === 432 || status === 433) category = "quota";
  else if (status === 429) category = "rate_limit";
  else if (status === 408 || status === 425 || status >= 500) category = "transient";
  const outcome: TavilyRequestOutcome = status >= 500 || status === 408 || status === 425 ? "unknown" : "rejected";
  const header = headers.get("retry-after");
  const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : undefined;
  return new TavilyProviderError(category, outcome, `Tavily request failed (${category})`, status,
    seconds !== undefined && Number.isFinite(seconds) ? Math.min(seconds * 1_000, 300_000) : undefined);
}

function responseObject(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TavilyProviderError("unknown", "unknown", `Tavily returned an invalid ${label} response`);
  }
  return value as JsonRecord;
}

function safeString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > TAVILY_LIMITS.urlChars || CONTROL_CHARS.test(value)) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname && !url.username && !url.password ? value : undefined;
  } catch { return undefined; }
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usage(payload: JsonRecord): TavilyUsage {
  const usageValue = payload.usage;
  if (usageValue && typeof usageValue === "object" && !Array.isArray(usageValue)) {
    const credits = finiteNonnegative((usageValue as JsonRecord).credits);
    if (credits !== undefined) return { known: true, credits, source: "provider-response" };
  }
  return { known: false, reason: "Tavily response did not include documented usage" };
}

function numericField(payload: JsonRecord, key: string): number | undefined {
  return finiteNonnegative(payload[key]);
}

function searchResults(payload: JsonRecord, maxResults: number): TavilySearchResult[] {
  if (!Array.isArray(payload.results)) throw new TavilyProviderError("unknown", "unknown", "Tavily returned an invalid search result list");
  return payload.results.slice(0, maxResults).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as JsonRecord;
    const url = safeUrl(row.url);
    if (!url) return [];
    const publishedAt = safeString(row.published_date, 100);
    const score = finiteNonnegative(row.score);
    return [{
      url,
      ...(safeString(row.title, 500) ? { title: safeString(row.title, 500) } : {}),
      ...(safeString(row.content, TAVILY_LIMITS.maxSnippetChars) ? { snippet: safeString(row.content, TAVILY_LIMITS.maxSnippetChars) } : {}),
      ...(safeString(row.raw_content, TAVILY_LIMITS.maxContentChars) ? { rawContent: safeString(row.raw_content, TAVILY_LIMITS.maxContentChars) } : {}),
      ...(publishedAt ? { publishedAt } : {}), ...(score !== undefined ? { score } : {}),
    }];
  });
}

function searchImages(value: unknown): TavilyImageResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, TAVILY_LIMITS.maxResults).flatMap((entry) => {
    const row = typeof entry === "string" ? { url: entry } : entry && typeof entry === "object" && !Array.isArray(entry) ? entry as JsonRecord : undefined;
    const url = row && safeUrl(row.url);
    if (!url) return [];
    const description = row && safeString(row.description, TAVILY_LIMITS.maxSnippetChars);
    return [{ url, ...(description ? { description } : {}) }];
  });
}

function extractionResults(payload: JsonRecord): TavilyExtractResult[] {
  if (!Array.isArray(payload.results)) throw new TavilyProviderError("unknown", "unknown", "Tavily returned an invalid extraction result list");
  return payload.results.slice(0, TAVILY_LIMITS.maxExtractUrls).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as JsonRecord;
    const url = safeUrl(row.url);
    if (!url) return [];
    const images = Array.isArray(row.images) ? row.images.slice(0, 20).filter((item): item is string => safeUrl(item) !== undefined) : undefined;
    return [{
      url,
      ...(safeString(row.raw_content, TAVILY_LIMITS.maxContentChars) ? { content: safeString(row.raw_content, TAVILY_LIMITS.maxContentChars) } : {}),
      ...(images?.length ? { images } : {}),
      ...(safeUrl(row.favicon) ? { favicon: safeUrl(row.favicon) } : {}),
    }];
  });
}

function extractionFailures(payload: JsonRecord): Array<{ url?: string }> {
  if (!Array.isArray(payload.failed_results)) return [];
  return payload.failed_results.slice(0, TAVILY_LIMITS.maxExtractUrls).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [{}];
    const url = safeUrl((value as JsonRecord).url);
    return [url ? { url } : {}];
  });
}

function credentialValue(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 8_192 || /[\r\n]/.test(value)) {
    throw new TavilyProviderError("auth", "not_sent", "Tavily credential is unavailable or invalid");
  }
  return value;
}

export function createTavilyAdapter(dependencies: TavilyAdapterDependencies): TavilyAdapter {
  if (!dependencies || typeof dependencies.resolveCredential !== "function") invalid("resolveCredential");
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") invalid("fetch");

  async function post(path: "/search" | "/extract", body: JsonRecord, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new TavilyProviderError("transient", "not_sent", "Tavily request cancelled before sending");
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).byteLength > TAVILY_LIMITS.maxRequestBytes) invalid("request size");
    let resolved: string;
    try { resolved = await dependencies.resolveCredential(); }
    catch { throw new TavilyProviderError("auth", "not_sent", "Tavily credential is unavailable"); }
    const credential = credentialValue(resolved);
    if (signal?.aborted) throw new TavilyProviderError("transient", "not_sent", "Tavily request cancelled before sending");
    const timeoutMs = timeoutValue(dependencies.timeoutMs);
    const maxBytes = responseLimit(dependencies.maxResponseBytes);
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    let response: Response;
    try {
      response = await fetcher(`${TAVILY_API_ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${credential}` },
        body: serialized,
        signal: requestSignal,
        redirect: "error",
      });
    } catch {
      clearTimeout(timer);
      throw new TavilyProviderError("transient", "unknown", timeoutController.signal.aborted ? "Tavily request timed out" : "Tavily request failed before a response");
    }
    try {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw httpError(response.status, response.headers);
      }
      return await readBoundedJson(response, maxBytes);
    } catch (error) {
      if (error instanceof TavilyProviderError) throw error;
      throw new TavilyProviderError("unknown", "unknown", "Tavily response could not be read", response.status);
    } finally { clearTimeout(timer); }
  }

  return {
    provider: "tavily",
    capabilities: TAVILY_CAPABILITIES,
    async search({ query, maxResults = 10, providerOptions, signal }) {
      const validatedQuery = validateQuery(query);
      if (!Number.isInteger(maxResults) || maxResults < 0 || maxResults > TAVILY_LIMITS.maxResults) invalid("maxResults");
      const options = validateSearchOptions(providerOptions);
      const payload = responseObject(await post("/search", { query: validatedQuery, max_results: maxResults, ...options }, signal), "search");
      const result: TavilySearchResponse = {
        provider: "tavily",
        results: searchResults(payload, maxResults),
        usage: usage(payload),
      };
      const answer = safeString(payload.answer, TAVILY_LIMITS.maxSnippetChars);
      const images = searchImages(payload.images);
      const responseTime = numericField(payload, "response_time");
      if (answer) result.answer = answer;
      if (images) result.images = images;
      if (responseTime !== undefined) result.responseTime = responseTime;
      return result;
    },
    async extract({ url, providerOptions, signal }) {
      const validatedUrl = validateUrl(url);
      const options = validateExtractOptions(providerOptions);
      const payload = responseObject(await post("/extract", { urls: [validatedUrl], ...options }, signal), "extract");
      const result: TavilyExtractResponse = {
        provider: "tavily",
        results: extractionResults(payload),
        failedResults: extractionFailures(payload),
        usage: usage(payload),
      };
      const responseTime = numericField(payload, "response_time");
      if (responseTime !== undefined) result.responseTime = responseTime;
      return result;
    },
  };
}
