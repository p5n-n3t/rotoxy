import { readFile, lstat } from "node:fs/promises";
import { WebTools, WEB_TOOL_DEFINITIONS, WebToolError, type WebProviderName, type WebFeature, type FeatureCapability, type WebToolName } from "./web-tools.js";
import type { StateStore } from "./store.js";

type Binding = { enabled: boolean; accountId?: string; features?: Partial<Record<WebFeature, FeatureCapability>> };
type PrivateConfig = { providers: Partial<Record<WebProviderName, Binding>>; permissions: { clients: Record<string, WebToolName[]> } };
const providers: WebProviderName[] = ["exa", "firecrawl", "tavily"];
const tools: WebToolName[] = ["web_search", "web_extract"];
const features: WebFeature[] = ["search", "extract"];

function validate(value: unknown): PrivateConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid web tools config.");
  const raw = value as Record<string, any>;
  if (Object.keys(raw).some((key) => !["providers", "permissions"].includes(key)) || !raw.providers || typeof raw.providers !== "object" || Array.isArray(raw.providers)) throw new Error("Invalid web tools config.");
  const normalized: PrivateConfig = { providers: {}, permissions: { clients: {} } };
  for (const [name, rawBinding] of Object.entries(raw.providers)) {
    const binding = rawBinding as Record<string, any>;
    if (!providers.includes(name as WebProviderName) || !binding || typeof binding !== "object" || Array.isArray(binding) || typeof binding.enabled !== "boolean" || Object.keys(binding).some((key) => !["enabled", "accountId", "features"].includes(key))) throw new Error("Invalid web tools provider binding.");
    if (binding.enabled && (typeof binding.accountId !== "string" || !binding.accountId.trim())) throw new Error("Enabled web provider requires an existing account id.");
    const selected: Partial<Record<WebFeature, FeatureCapability>> = {};
    if (binding.features !== undefined) {
      if (!binding.features || typeof binding.features !== "object" || Array.isArray(binding.features) || Object.keys(binding.features).some((key) => !features.includes(key as WebFeature))) throw new Error("Invalid web provider feature capabilities.");
      for (const [feature, status] of Object.entries(binding.features)) {
        if (!["supported", "unsupported", "unknown"].includes(status as string)) throw new Error("Invalid web provider feature capability.");
        selected[feature as WebFeature] = status as FeatureCapability;
      }
    }
    normalized.providers[name as WebProviderName] = { enabled: binding.enabled, accountId: binding.accountId, features: selected };
  }
  const permissions = raw.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions) || Object.keys(permissions).some((key) => key !== "clients") || !permissions.clients || typeof permissions.clients !== "object" || Array.isArray(permissions.clients)) throw new Error("Explicit per-client web tool permissions are required.");
  for (const [client, allowed] of Object.entries(permissions.clients)) {
    if (!client || client.length > 512 || !Array.isArray(allowed) || allowed.some((name) => !tools.includes(name))) throw new Error("Invalid per-client web tool permission.");
    normalized.permissions.clients[client] = [...new Set(allowed)];
  }
  return normalized;
}

/** Reads only an explicitly supplied, owner-private mapping. No credentials are stored in this file. */
export async function loadWebToolsConfig(path: string | undefined, store: StateStore, options: { fetch?: typeof globalThis.fetch } = {}) {
  if (!path) return undefined;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 128 * 1024) throw new Error("Web tools config must be an owner-private regular file (mode 0600 or stricter).");
  const config = validate(JSON.parse(await readFile(path, "utf8")));
  const facade = new WebTools({
    config: { providers: config.providers },
    fetch: options.fetch,
    resolveCredential: async (provider) => {
      const binding = config.providers[provider];
      if (!binding?.enabled || !binding.accountId) throw new WebToolError("provider_not_enabled");
      const state = await store.load();
      const account = state.accounts.find((candidate) => candidate.id === binding.accountId);
      if (!account || !account.enabled || account.provider !== provider) throw new WebToolError("provider_account_mismatch");
      return store.revealToken(account);
    },
    isToolAllowed: (caller, name) => (config.permissions.clients[caller] || []).includes(name),
  });
  return {
    call: async (name: string, args: unknown, caller: string) => {
      const selected = args && typeof args === "object" ? (args as Record<string, unknown>).provider : undefined;
      const binding = typeof selected === "string" ? config.providers[selected as WebProviderName] : undefined;
      const permission = config.permissions.clients[caller] || [];
      const feature = name === "web_search" ? "search" : name === "web_extract" ? "extract" : undefined;
      if (!feature || !tools.includes(name as WebToolName) || !permission.includes(name as WebToolName)) throw new WebToolError("tool_not_allowed");
      if (!binding?.enabled || binding.features?.[feature] !== "supported") throw new WebToolError("provider_not_enabled");
      return facade.call(name, args, caller);
    },
    definitionsFor: async (caller: string, scopes: ReadonlySet<string>) => {
      const state = await store.load();
      return WEB_TOOL_DEFINITIONS.flatMap((definition) => {
        const scope = definition.name === "web_search" ? "web:search" : "web:extract";
        if (!scopes.has(scope) || !(config.permissions.clients[caller] || []).includes(definition.name)) return [];
        const feature = definition.name === "web_search" ? "search" : "extract";
        const selected = providers.filter((provider) => {
          const binding = config.providers[provider];
          const account = state.accounts.find((candidate) => candidate.id === binding?.accountId);
          return Boolean(binding?.enabled && binding.features?.[feature] === "supported" && account?.enabled && account.provider === provider);
        });
        if (!selected.length) return [];
        const schema = structuredClone(definition.inputSchema);
        (schema.properties as Record<string, any>).provider.enum = selected;
        return [{ ...definition, inputSchema: schema }];
      });
    },
  };
}

export type ConfiguredWebTools = NonNullable<Awaited<ReturnType<typeof loadWebToolsConfig>>> & { configured?: () => Promise<boolean> };

/** Reload private bindings for each operation so permission revocation takes effect immediately. */
export function liveWebToolsConfig(path: string, store: StateStore): ConfiguredWebTools {
  const current = async () => { try { return await loadWebToolsConfig(path, store); } catch (error: any) { if (error?.code === "ENOENT") return undefined; throw new WebToolError("provider_not_enabled"); } };
  return {
    configured: async () => Boolean(await current()),
    call: async (name, args, caller) => { const active = await current(); if (!active) throw new WebToolError("provider_not_enabled"); return active.call(name, args, caller); },
    definitionsFor: async (caller, scopes) => (await current())?.definitionsFor(caller, scopes) ?? [],
  };
}
