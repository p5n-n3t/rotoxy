import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as dotenv from "dotenv";
import type { ProviderConfig, RotoxyConfig } from "./types.js";

export const CONFIG_DIR = process.env.ROTOXY_CONFIG_DIR || path.join(os.homedir(), ".config", "rotoxy");
export const CONFIG_FILE = process.env.ROTOXY_CONFIG_FILE || path.join(CONFIG_DIR, "config.json");
export const SECRETS_FILE = process.env.ROTOXY_SECRETS_FILE || path.join(CONFIG_DIR, "secrets.env");
export const STATE_DIR = process.env.ROTOXY_STATE_DIR || path.join(os.homedir(), ".local", "state", "rotoxy");

export function ensureRuntimeDirs() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

export function loadSecrets() {
  ensureRuntimeDirs();
  if (fs.existsSync(SECRETS_FILE)) dotenv.config({ path: SECRETS_FILE, override: false, quiet: true });
}

export function loadConfig(): RotoxyConfig {
  ensureRuntimeDirs();
  loadSecrets();
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`Missing ${CONFIG_FILE}. Run: rotoxy configure`);
  }
  const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as RotoxyConfig;
  if (parsed.version !== 2) throw new Error("Unsupported ROTOXY config version. Run: rotoxy migrate");
  parsed.mcp ||= { servers: {}, assignments: {} };
  parsed.mcp.servers ||= {};
  parsed.mcp.assignments ||= {};
  validateConfig(parsed);
  return parsed;
}

export function saveConfig(config: RotoxyConfig) {
  ensureRuntimeDirs();
  const tmp = CONFIG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  fs.chmodSync(CONFIG_FILE, 0o600);
}

export function getSecret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing secret ${name} in ${SECRETS_FILE}`);
  return value;
}

function validateConfig(config: RotoxyConfig) {
  if (!config.listen?.port) throw new Error("listen.port is required");
  if (!config.defaultPool) throw new Error("defaultPool is required");
  if (!config.pools?.[config.defaultPool]) throw new Error(`defaultPool "${config.defaultPool}" does not exist`);
  for (const [id, provider] of Object.entries(config.providers || {})) validateProvider(id, provider);
  for (const [id, pool] of Object.entries(config.pools || {})) {
    if (pool.type === "provider" && (!pool.provider || !config.providers[pool.provider])) {
      throw new Error(`Pool "${id}" references missing provider "${pool.provider}"`);
    }
    if (pool.type === "federated") {
      if (!pool.targets?.length) throw new Error(`Federated pool "${id}" has no targets`);
      const wires = new Set<string>();
      for (const target of pool.targets) {
        const provider = config.providers[target.provider];
        if (!provider) throw new Error(`Pool "${id}" references missing provider "${target.provider}"`);
        wires.add(provider.wire);
      }
      if (wires.size > 1) throw new Error(`Federated pool "${id}" mixes incompatible wire protocols (${[...wires].join(", ")}). Use providers with the same wire protocol or separate pools.`);
    }
  }
  for (const [id, server] of Object.entries(config.mcp?.servers || {})) {
    if (server.transport === "streamable-http" && !server.url) throw new Error(`MCP server "${id}" requires a URL`);
    if (server.transport === "stdio" && !server.command) throw new Error(`MCP server "${id}" requires a command`);
    for (const ref of Object.values(server.secretEnv || {})) if (!ref) throw new Error(`MCP server "${id}" has an empty secret env reference`);
    for (const ref of Object.values(server.secretHeaders || {})) if (!ref) throw new Error(`MCP server "${id}" has an empty secret header reference`);
  }
}

function validateProvider(id: string, provider: ProviderConfig) {
  if (!provider.baseUrl) throw new Error(`Provider "${id}" has no baseUrl`);
  if (!provider.accounts?.length) throw new Error(`Provider "${id}" has no accounts`);
  for (const account of provider.accounts) {
    if (!account.secret) throw new Error(`Provider "${id}" account "${account.name}" has no secret reference`);
  }
}

export const PROVIDER_PRESETS: Record<string, Omit<ProviderConfig, "id" | "accounts">> = {
  ollama: {
    label: "Ollama Cloud", adapter: "ollama", wire: "openai", baseUrl: "https://ollama.com",
    auth: { kind: "bearer", header: "Authorization", prefix: "Bearer " },
    modelListPath: "/api/tags"
  },
  openrouter: {
    label: "OpenRouter Free", adapter: "openrouter", wire: "openai", baseUrl: "https://openrouter.ai/api",
    auth: { kind: "bearer", header: "Authorization", prefix: "Bearer " },
    modelListPath: "/v1/models", defaultModel: "openrouter/free", policy: { freeOnly: true },
    staticHeaders: { "X-Title": "ROTOXY" }
  },
  openai: {
    label: "OpenAI API", adapter: "openai", wire: "openai", baseUrl: "https://api.openai.com",
    auth: { kind: "bearer", header: "Authorization", prefix: "Bearer " }, modelListPath: "/v1/models"
  },
  anthropic: {
    label: "Anthropic API", adapter: "anthropic", wire: "anthropic", baseUrl: "https://api.anthropic.com",
    auth: { kind: "header", header: "x-api-key", prefix: "" },
    staticHeaders: { "anthropic-version": "2023-06-01" }, modelListPath: "/v1/models"
  },
  groq: {
    label: "Groq", adapter: "groq", wire: "openai", baseUrl: "https://api.groq.com/openai",
    auth: { kind: "bearer", header: "Authorization", prefix: "Bearer " }, modelListPath: "/v1/models"
  },
  together: {
    label: "Together", adapter: "together", wire: "openai", baseUrl: "https://api.together.xyz",
    auth: { kind: "bearer", header: "Authorization", prefix: "Bearer " }, modelListPath: "/v1/models"
  },
  deepseek: {
    label: "DeepSeek", adapter: "deepseek", wire: "openai", baseUrl: "https://api.deepseek.com",
    auth: { kind: "bearer", header: "Authorization", prefix: "Bearer " }, modelListPath: "/v1/models"
  },
  mistral: {
    label: "Mistral", adapter: "mistral", wire: "openai", baseUrl: "https://api.mistral.ai",
    auth: { kind: "bearer", header: "Authorization", prefix: "Bearer " }, modelListPath: "/v1/models"
  },
  google: {
    label: "Google Gemini API", adapter: "google", wire: "google", baseUrl: "https://generativelanguage.googleapis.com",
    auth: { kind: "header", header: "x-goog-api-key", prefix: "" }, modelListPath: "/v1beta/models"
  }
};
