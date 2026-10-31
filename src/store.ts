import { open, readFile, rename, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  decryptSecret,
  encryptSecret,
  ensureMasterKey,
  hashPassword,
  randomToken,
} from "./crypto.js";
import { planAdminCredentialRotation } from "./admin-security.js";
import type {
  GatewayConfig,
  PersistedState,
  PoolStrategy,
  UpstreamAccount,
} from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function configDir(): string {
  const home = homedir();
  const explicit = process.env.ROTOXY_CONFIG_DIR || process.env.TOKEN2OAUTH_CONFIG_DIR;
  if (explicit) return resolve(explicit.replace(/^~(?=\/|$)/, home));
  const canonical = join(home, ".config", "rotoxy");
  const legacy = join(home, ".config", "token2oauth");
  // Until the root-owned data migration runs, keep opening an existing legacy
  // store rather than silently initializing an empty canonical store.
  const raw = !existsSync(join(canonical, "state.json")) && existsSync(join(legacy, "state.json"))
    ? legacy : canonical;
  return resolve(raw.replace(/^~(?=\/|$)/, homedir()));
}

export function defaultConfig(): GatewayConfig {
  const basePath = normalizeBasePath(process.env.ROTOXY_BASE_PATH ?? process.env.TOKEN2OAUTH_BASE_PATH ?? "");
  const publicBaseUrl =
    process.env.ROTOXY_PUBLIC_BASE_URL || process.env.TOKEN2OAUTH_PUBLIC_BASE_URL || "http://127.0.0.1:2030" + basePath;
  return {
    upstreamUrl: process.env.ROTOXY_UPSTREAM_URL || process.env.TOKEN2OAUTH_UPSTREAM_URL || "",
    upstreamAuthHeader: "authorization",
    upstreamAuthScheme: "Bearer",
    strategy:
      ((process.env.ROTOXY_POOL_STRATEGY || process.env.TOKEN2OAUTH_POOL_STRATEGY) as PoolStrategy) || "adaptive-sticky",
    basePath,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
    requestTimeoutMs: 120_000,
    maxFailoverAttempts: 3,
    failoverStateful: false,
    quotaCooldownSeconds: 15 * 60,
    errorCooldownSeconds: 30,
    quotaStatuses: [402, 429],
    authFailureStatuses: [401],
    retryStatuses: [401, 402, 408, 425, 429, 500, 502, 503, 504],
    quotaBodyPatterns: [
      "credit(?:s)?(?:\\s+are)?\\s+(?:depleted|exhausted|used up)",
      "insufficient\\s+(?:credits?|quota|balance)",
      "(?:quota|limit)\\s+(?:exceeded|reached|exhausted)",
      "out of (?:credits?|quota)",
      "usage limit",
      "rate limit",
    ],
  };
}

export function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return "/" + trimmed.replace(/^\/+|\/+$/g, "");
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + ".tmp." + process.pid + "." + Date.now();
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, path);
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
      try {
        return await fn();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error: any) {
      if (handle) await handle.close().catch(() => undefined);
      if (error?.code !== "EEXIST") throw error;
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > 30_000) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // lock disappeared between calls
      }
      await sleep(25 + Math.min(250, attempt * 5));
    }
  }
  throw new Error("timed out waiting for ROTOXY state lock");
}

export class StateStore {
  readonly dir = configDir();
  readonly statePath = join(this.dir, "state.json");
  readonly keyPath = join(this.dir, "master.key");
  readonly lockPath = join(this.dir, "state.lock");
  private key?: Buffer;

  async init(options: {
    adminPassword?: string;
    publicBaseUrl?: string;
    upstreamUrl?: string;
    basePath?: string;
  } = {}): Promise<{ created: boolean; adminPassword?: string; state: PersistedState }> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.key = await ensureMasterKey(this.keyPath);
    try {
      const state = await this.load();
      return { created: false, state };
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }

    const generatedPassword = options.adminPassword || randomToken(18);
    const cfg = defaultConfig();
    if (options.basePath !== undefined) cfg.basePath = normalizeBasePath(options.basePath);
    if (options.publicBaseUrl) cfg.publicBaseUrl = options.publicBaseUrl.replace(/\/$/, "");
    if (options.upstreamUrl) cfg.upstreamUrl = options.upstreamUrl;

    const state: PersistedState = {
      version: 1,
      config: cfg,
      admin: hashPassword(generatedPassword),
      accounts: [],
      oauthClients: [],
      refreshTokens: [],
    };
    await atomicWrite(this.statePath, JSON.stringify(state, null, 2) + "\n");
    return {
      created: true,
      adminPassword: options.adminPassword ? undefined : generatedPassword,
      state,
    };
  }

  private async getKey(): Promise<Buffer> {
    if (!this.key) this.key = await ensureMasterKey(this.keyPath);
    return this.key;
  }

  async load(): Promise<PersistedState> {
    const raw = await readFile(this.statePath, "utf8");
    const state = JSON.parse(raw) as PersistedState;
    if (state.version !== 1) throw new Error("unsupported state version");
    return state;
  }

  async update(mutator: (state: PersistedState) => void | Promise<void>): Promise<PersistedState> {
    return withLock(this.lockPath, async () => {
      const state = await this.load();
      await mutator(state);
      await atomicWrite(this.statePath, JSON.stringify(state, null, 2) + "\n");
      return state;
    });
  }

  async setConfig<K extends keyof GatewayConfig>(
    key: K,
    value: GatewayConfig[K],
  ): Promise<PersistedState> {
    return this.update((state) => {
      state.config[key] = value;
    });
  }

  async addAccount(input: {
    label: string;
    token: string;
    provider?: string;
    weight?: number;
    priority?: number;
    metadata?: Record<string, string>;
  }): Promise<UpstreamAccount> {
    const key = await this.getKey();
    const account: UpstreamAccount = {
      id: randomToken(9),
      label: input.label,
      provider: input.provider || "generic-bearer-mcp",
      secret: encryptSecret(input.token, key),
      enabled: true,
      weight: Math.max(0.01, input.weight || 1),
      priority: input.priority ?? 100,
      createdAt: Date.now(),
      stats: {
        requests: 0,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        state: "unknown",
      },
      metadata: input.metadata,
    };
    await this.update((state) => {
      state.accounts.push(account);
    });
    return account;
  }

  async revealToken(account: UpstreamAccount): Promise<string> {
    return decryptSecret(account.secret, await this.getKey());
  }

  async removeAccount(id: string): Promise<boolean> {
    let removed = false;
    await this.update((state) => {
      const before = state.accounts.length;
      state.accounts = state.accounts.filter((a) => a.id !== id);
      removed = state.accounts.length !== before;
      if (state.capabilities) delete state.capabilities[id];
    });
    return removed;
  }

  async setAccountEnabled(id: string, enabled: boolean): Promise<void> {
    await this.update((state) => {
      const account = state.accounts.find((a) => a.id === id);
      if (!account) throw new Error("account not found");
      account.enabled = enabled;
      account.stats.state = enabled ? "unknown" : "disabled";
      // This method is only used by explicit operator toggles. Once an
      // operator chooses the state, a later scheduled-renewal check must not
      // treat an old quota pause as permission to restore routing.
      if (account.metadata) {
        delete account.metadata.quotaDisabledBy;
        delete account.metadata.disabledReason;
      }
      if (enabled) {
        account.stats.cooldownUntil = undefined;
        account.stats.consecutiveFailures = 0;
      }
    });
  }

  async resetAccountHealth(id?: string): Promise<void> {
    await this.update((state) => {
      for (const account of state.accounts) {
        if (id && account.id !== id) continue;
        account.stats.consecutiveFailures = 0;
        account.stats.cooldownUntil = undefined;
        account.stats.lastError = undefined;
        account.stats.lastStatus = undefined;
        account.stats.lastProbeAt = undefined;
        account.stats.lastProbeOk = undefined;
        account.stats.lastProbeStatus = undefined;
        account.stats.lastProbeError = undefined;
        account.stats.state = account.enabled ? "unknown" : "disabled";
      }
    });
  }

  /**
   * Rotate the admin password. Persists only the admin hash, the admin epoch
   * (which invalidates admin sessions and pending authorization codes in the
   * running server, even when called from the CLI) and, when requested, the
   * OAuth refresh tokens plus an access-token iat cutoff. Upstream credentials,
   * configuration, OAuth clients and the master key are never touched.
   */
  async rotateAdminPassword(
    newPassword: string,
    options: { revokeConnections?: boolean; nowMs?: number } = {},
  ): Promise<{ adminEpoch: number; revokedConnections: boolean }> {
    const nowMs = options.nowMs ?? Date.now();
    let epoch = 0;
    await this.update((state) => {
      const plan = planAdminCredentialRotation(state, newPassword, nowMs, {
        revokeConnections: options.revokeConnections === true,
      });
      state.admin = plan.statePatch.admin;
      if (plan.statePatch.refreshTokens) state.refreshTokens = plan.statePatch.refreshTokens;
      const security = { ...(state.security || {}) };
      security.adminEpoch = (security.adminEpoch ?? 0) + 1;
      security.adminRotatedAt = nowMs;
      if (plan.minimumAcceptedAccessTokenIat !== undefined) {
        security.accessTokenNotBefore = plan.minimumAcceptedAccessTokenIat;
      }
      state.security = security;
      epoch = security.adminEpoch;
    });
    return { adminEpoch: epoch, revokedConnections: options.revokeConnections === true };
  }

  async recordProbe(
    id: string,
    result: { ok: boolean; status?: number; error?: string },
  ): Promise<void> {
    await this.update((state) => {
      const account = state.accounts.find((a) => a.id === id);
      if (!account) return;
      account.stats.lastProbeAt = Date.now();
      account.stats.lastProbeOk = result.ok;
      account.stats.lastProbeStatus = result.status;
      account.stats.lastProbeError = result.error;
    });
  }
}
