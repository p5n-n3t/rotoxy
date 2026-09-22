export type AuthKind = "bearer" | "header";
export type PoolStrategy = "round-robin" | "random" | "failover";
export type PoolType = "provider" | "federated";

export interface AccountConfig {
  id: string;
  name: string;
  secret: string;
  enabled?: boolean;
  weight?: number;
}

export interface ProviderPolicy {
  freeOnly?: boolean;
  allowModels?: string[];
  denyModels?: string[];
}

export interface ProviderConfig {
  id: string;
  label: string;
  adapter: "ollama" | "openai" | "anthropic" | "openrouter" | "groq" | "together" | "deepseek" | "mistral" | "google" | "generic";
  wire: "openai" | "anthropic" | "ollama" | "google";
  baseUrl: string;
  auth: {
    kind: AuthKind;
    header?: string;
    prefix?: string;
  };
  staticHeaders?: Record<string, string>;
  accounts: AccountConfig[];
  policy?: ProviderPolicy;
  modelListPath?: string;
  defaultModel?: string;
  enabled?: boolean;
}

export interface PoolTarget {
  provider: string;
  model?: string;
  weight?: number;
}

export interface PoolConfig {
  id: string;
  label: string;
  type: PoolType;
  strategy: PoolStrategy;
  provider?: string;
  targets?: PoolTarget[];
  defaultModel?: string;
  enabled?: boolean;
}

export interface SmartTarget {
  pool: string;
  model?: string;
}

export interface SmartRouterConfig {
  enabled: boolean;
  fallbackPool: string;
  mappings: Record<string, SmartTarget | null>;
}


export type McpTransport = "streamable-http" | "stdio";

export interface McpServerConfig {
  id: string;
  label: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  secretEnv?: Record<string, string>;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, string>;
  bearerTokenSecret?: string;
  enabled?: boolean;
  timeoutSeconds?: number;
  preset?: string;
}

export interface McpRegistryConfig {
  servers: Record<string, McpServerConfig>;
  assignments: Record<string, string[]>;
}

export interface WorkerProfile {
  id: string;
  label: string;
  adapter: "codex" | "gemini" | "claude" | "copilot" | "agy" | "opencode" | "custom";
  command: string;
  enabled?: boolean;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface WorkerPool {
  id: string;
  label: string;
  strategy: PoolStrategy;
  workers: string[];
}

export interface RotoxyConfig {
  version: 2;
  listen: { host: string; port: number };
  security: { tokenFile: string };
  exposure: {
    mode: "serve" | "funnel" | "none";
    layout: "single" | "services";
    servicePrefix: string;
  };
  defaultPool: string;
  providers: Record<string, ProviderConfig>;
  pools: Record<string, PoolConfig>;
  routers: {
    task: SmartRouterConfig;
    difficulty: SmartRouterConfig;
    autoPolicy: "task" | "difficulty" | "task-then-difficulty";
  };
  workers: {
    profiles: Record<string, WorkerProfile>;
    pools: Record<string, WorkerPool>;
  };
  mcp: McpRegistryConfig;
}

export interface RouteDecision {
  poolId: string;
  providerId: string;
  accountId: string;
  accountName: string;
  accountSecret: string;
  upstreamModel?: string;
  requestedModel?: string;
  routeReason: string;
  path: string;
}

export interface Classification {
  task: string;
  difficulty: "easy" | "medium" | "hard";
  reasons: string[];
}
