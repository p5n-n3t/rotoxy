import {
  createExaWebInformationAdapter,
  createFirecrawlWebInformationAdapter,
  WebInformationInputError,
  WebInformationProviderError,
  type ExaExtractOptions,
  type ExaSearchOptions,
  type FirecrawlExtractOptions,
  type FirecrawlSearchOptions,
  type WebProvider,
} from "./providers/web-information.js";
import {
  createTavilyAdapter,
  TavilyInputError,
  TavilyProviderError,
  TAVILY_CAPABILITIES,
  type TavilyExtractOptions,
  type TavilySearchOptions,
} from "./providers/tavily.js";

export type WebToolName = "web_search" | "web_extract";
export type WebProviderName = WebProvider | "tavily";
export type WebFeature = "search" | "extract";
export type FeatureCapability = "supported" | "unsupported" | "unknown";
export type WebToolScope = "web:search" | "web:extract";

export interface WebToolDefinition {
  name: WebToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

const providerNames: WebProviderName[] = ["exa", "firecrawl", "tavily"];
const providerEnum = [...providerNames];
const providerOptions = {
  type: "object",
  description: "Provider-specific options. The selected adapter validates its own documented options.",
  additionalProperties: true,
};

export const WEB_TOOL_DEFINITIONS: WebToolDefinition[] = [
  {
    name: "web_search",
    description: "Run one web search with the explicitly selected Exa, Firecrawl, or Tavily provider. Provider-specific options are validated by that adapter; no fallback provider is tried.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: providerEnum },
        query: { type: "string", minLength: 1, maxLength: 2_000 },
        maxResults: { type: "integer", minimum: 1, maximum: 20 },
        providerOptions,
      },
      required: ["provider", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "web_extract",
    description: "Extract one supplied HTTP(S) URL with the explicitly selected Exa, Firecrawl, or Tavily provider. Provider-specific options are validated by that adapter; no fallback provider is tried.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: providerEnum },
        url: { type: "string", minLength: 1, maxLength: 2_048 },
        providerOptions,
      },
      required: ["provider", "url"],
      additionalProperties: false,
    },
  },
];

const toolNames = new Set<string>(WEB_TOOL_DEFINITIONS.map((definition) => definition.name));

export function isToolName(value: unknown): value is WebToolName {
  return typeof value === "string" && toolNames.has(value);
}

export function requiredScope(name: WebToolName): WebToolScope {
  return name === "web_search" ? "web:search" : "web:extract";
}

export class WebToolError extends Error {
  constructor(readonly code: string, readonly details?: Record<string, string | number>) {
    super(code);
    this.name = "WebToolError";
  }
}

export interface WebProviderConfig {
  enabled: boolean;
  features?: Partial<Record<WebFeature, FeatureCapability>>;
}

export interface WebToolsConfig {
  /** Exact provider ids only. Missing providers/features remain unavailable. */
  providers: Partial<Record<WebProviderName, WebProviderConfig>>;
}

export type WebCredentialResolver = (provider: WebProviderName, caller: string) => string | Promise<string>;
export type WebToolPermissionResolver = (caller: string, tool: WebToolName) => boolean | Promise<boolean>;

export interface WebToolsOptions {
  config: WebToolsConfig;
  resolveCredential: WebCredentialResolver;
  isToolAllowed: WebToolPermissionResolver;
  fetch?: typeof globalThis.fetch;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closedRecord(value: unknown, required: string[], allowed: string[]): JsonRecord {
  if (!isRecord(value)) throw new WebToolError("invalid_arguments");
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new WebToolError("invalid_arguments");
  }
  return value;
}

function providerName(value: unknown): WebProviderName {
  if (typeof value !== "string" || !providerNames.includes(value as WebProviderName)) {
    throw new WebToolError("invalid_provider");
  }
  return value as WebProviderName;
}

function localCapability(provider: WebProviderName, feature: WebFeature): FeatureCapability {
  if (provider === "tavily") return TAVILY_CAPABILITIES[feature];
  // The REST adapters expose exactly these two operations.
  return feature === "search" || feature === "extract" ? "supported" : "unsupported";
}

function assertCapability(config: WebToolsConfig, provider: WebProviderName, feature: WebFeature): void {
  const providerConfig = config.providers[provider];
  if (!providerConfig?.enabled) throw new WebToolError("provider_not_enabled", { provider });
  const selected = providerConfig.features?.[feature] ?? "unknown";
  if (selected !== "supported") {
    throw new WebToolError(selected === "unsupported" ? "provider_feature_unsupported" : "provider_feature_unknown", { provider, feature });
  }
  if (localCapability(provider, feature) !== "supported") {
    throw new WebToolError("provider_feature_unsupported", { provider, feature });
  }
}

function safeAdapterError(error: unknown): WebToolError {
  if (error instanceof WebInformationInputError || error instanceof TavilyInputError) {
    return new WebToolError("invalid_arguments");
  }
  if (error instanceof WebInformationProviderError) {
    return new WebToolError("provider_request_failed", {
      provider: error.provider,
      category: error.category,
      requestOutcome: error.requestOutcome,
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    });
  }
  if (error instanceof TavilyProviderError) {
    return new WebToolError("provider_request_failed", {
      provider: "tavily",
      category: error.category,
      requestOutcome: error.requestOutcome,
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    });
  }
  // Adapter and transport messages can contain a query, response body, or credential.
  return new WebToolError("provider_request_failed");
}

function toolResponse(provider: WebProviderName, operation: WebFeature, response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.provider !== provider || !Object.hasOwn(response, "usage")) {
    throw new WebToolError("invalid_provider_response", { provider });
  }
  const { provider: _provider, usage, ...data } = response;
  return { provider, operation, ...data, providerUsage: usage };
}

function redactCredential(value: unknown, credential: string | undefined): unknown {
  if (typeof value === "string") return credential ? value.split(credential).join("[REDACTED]") : value;
  if (Array.isArray(value)) return value.map((item) => redactCredential(item, credential));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCredential(item, credential)]));
  }
  return value;
}

/**
 * Caller-scoped local search/extract facade. It performs one selected adapter
 * operation per call and deliberately has no retry or cross-provider fallback.
 */
export class WebTools {
  private readonly config: WebToolsConfig;
  private readonly resolveCredential: WebCredentialResolver;
  private readonly isToolAllowed: WebToolPermissionResolver;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: WebToolsOptions) {
    if (!options || !isRecord(options.config) || !isRecord(options.config.providers) ||
        typeof options.resolveCredential !== "function" || typeof options.isToolAllowed !== "function") {
      throw new WebToolError("invalid_configuration");
    }
    this.config = options.config;
    this.resolveCredential = options.resolveCredential;
    this.isToolAllowed = options.isToolAllowed;
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (typeof this.fetcher !== "function") throw new WebToolError("invalid_configuration");
  }

  async call(name: string, rawArgs: unknown, caller: string): Promise<Record<string, unknown>> {
    if (!isToolName(name)) throw new WebToolError("unknown_tool");
    if (typeof caller !== "string" || caller.length < 1 || caller.length > 512 || caller.includes("\0")) {
      throw new WebToolError("invalid_caller");
    }
    let allowed = false;
    try { allowed = await this.isToolAllowed(caller, name); } catch { /* permission checks fail closed */ }
    if (!allowed) throw new WebToolError("tool_not_allowed");

    const operation: WebFeature = name === "web_search" ? "search" : "extract";
    const args = name === "web_search"
      ? closedRecord(rawArgs, ["provider", "query"], ["provider", "query", "maxResults", "providerOptions"])
      : closedRecord(rawArgs, ["provider", "url"], ["provider", "url", "providerOptions"]);
    const provider = providerName(args.provider);
    assertCapability(this.config, provider, operation);
    if (args.providerOptions !== undefined && !isRecord(args.providerOptions)) throw new WebToolError("invalid_arguments");

    // Construct the chosen adapter with a call-local credential resolver so
    // credentials remain caller-specific and are never retained on the object.
    let activeCredential: string | undefined;
    const resolveForCaller = async (requested: WebProviderName) => {
      const credential = await this.resolveCredential(requested, caller);
      activeCredential = credential;
      return credential;
    };
    try {
      let response: unknown;
      if (provider === "exa") {
        const adapter = createExaWebInformationAdapter({ fetch: this.fetcher, resolveCredential: resolveForCaller });
        response = operation === "search"
          ? await adapter.search({ query: args.query as string, maxResults: args.maxResults as number | undefined, providerOptions: args.providerOptions as ExaSearchOptions | undefined })
          : await adapter.extract({ url: args.url as string, providerOptions: args.providerOptions as ExaExtractOptions | undefined });
      } else if (provider === "firecrawl") {
        const adapter = createFirecrawlWebInformationAdapter({ fetch: this.fetcher, resolveCredential: resolveForCaller });
        response = operation === "search"
          ? await adapter.search({ query: args.query as string, maxResults: args.maxResults as number | undefined, providerOptions: args.providerOptions as FirecrawlSearchOptions | undefined })
          : await adapter.extract({ url: args.url as string, providerOptions: args.providerOptions as FirecrawlExtractOptions | undefined });
      } else {
        const adapter = createTavilyAdapter({ fetch: this.fetcher, resolveCredential: () => resolveForCaller("tavily") });
        response = operation === "search"
          ? await adapter.search({ query: args.query as string, maxResults: args.maxResults as number | undefined, providerOptions: args.providerOptions as TavilySearchOptions | undefined })
          : await adapter.extract({ url: args.url as string, providerOptions: args.providerOptions as TavilyExtractOptions | undefined });
      }
      return redactCredential(toolResponse(provider, operation, response), activeCredential) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof WebToolError) throw error;
      throw safeAdapterError(error);
    } finally {
      // Drop this call's only facade reference as soon as the result is built.
      activeCredential = undefined;
    }
  }
}
