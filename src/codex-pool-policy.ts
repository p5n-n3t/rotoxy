import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { StateStore } from "./store.js";
import type { CodexProfileSnapshot } from "./codex-profiles.js";

export const CODEX_POOL_POLICY_FILE = "codex-pool-policy.json";
export const CODEX_PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
export const CODEX_PROFILE_MAX_CONCURRENCY = 16;

export interface CodexProfilePoolRule {
  profileId: string;
  enabled: boolean;
  maxConcurrent: number;
}

export interface CodexPoolPolicy {
  version: 1;
  dispatchEnabled: boolean;
  protectInitiatingAccount: true;
  profiles: CodexProfilePoolRule[];
}

/** Resolved by the caller binding, never guessed from an MCP OAuth client ID.
 * A client may use an account outside the registered pool (resolved + empty).
 * Unresolved origin identity cannot authorize automatic subscription dispatch.
 */
export interface CodexOriginContext {
  resolved: boolean;
  protectedProfileIds: readonly string[];
}

export interface CodexPoolActiveCounts {
  [profileId: string]: number;
}

/** Conservative local worker policy, not a statement of Free-plan entitlement.
 * Discovery can include models an account cannot execute. Until independently
 * verified, Free workers are restricted to routine work on economical models.
 */
export function codexProfileFitsTask(snapshot: CodexProfileSnapshot, task: {
  modelId: string; complexity: "routine" | "standard" | "complex"; reasoningEffort?: string;
}, now = Date.now()): boolean {
  if (!snapshot || snapshot.authMode !== "chatgpt" || !Number.isFinite(snapshot.capturedAt) ||
      snapshot.capturedAt > now || now - snapshot.capturedAt > 300_000 ||
      !["routine", "standard", "complex"].includes(task.complexity)) return false;
  const model = snapshot.models.find(model => model.id === task.modelId);
  if (!model || task.reasoningEffort && !model.reasoningEfforts?.includes(task.reasoningEffort)) return false;
  if (snapshot.planType === "free" && (task.complexity !== "routine" || !["gpt-6-luna", "gpt-5.6-luna"].includes(task.modelId))) return false;
  if (!snapshot.planType || !snapshot.rateWindows.length) return false;
  return snapshot.rateWindows.every(window => typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 && window.usedPercent < 100 && !window.exhausted);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProfileId(value: unknown): value is string {
  return typeof value === "string" && CODEX_PROFILE_ID_PATTERN.test(value);
}

function defaultPolicy(profileIds: readonly string[]): CodexPoolPolicy {
  return {
    version: 1,
    dispatchEnabled: false,
    protectInitiatingAccount: true,
    profiles: profileIds.map((profileId) => ({ profileId, enabled: true, maxConcurrent: 1 })),
  };
}

function validateProfileIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("codex_profile_registry_invalid");
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw) || !isProfileId(raw.id) || seen.has(raw.id)) throw new Error("codex_profile_registry_invalid");
    seen.add(raw.id);
    ids.push(raw.id);
  }
  return ids.sort();
}

function parseProfileRegistry(value: unknown): string[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles)) throw new Error("codex_profile_registry_invalid");
  return validateProfileIds(value.profiles);
}

function parsePolicy(value: unknown, registryIds: readonly string[], allowMissingProfiles: boolean): CodexPoolPolicy {
  if (!isRecord(value) || value.version !== 1 || typeof value.dispatchEnabled !== "boolean" ||
      value.protectInitiatingAccount !== true ||
      !Array.isArray(value.profiles) || value.profiles.length > 16 ||
      Object.keys(value).some((key) => !["version", "dispatchEnabled", "protectInitiatingAccount", "profiles"].includes(key))) throw new Error("codex_pool_policy_invalid");

  const registrySet = new Set(registryIds);
  const rows = new Map<string, CodexProfilePoolRule>();
  for (const raw of value.profiles) {
    if (!isRecord(raw) || !isProfileId(raw.profileId) || typeof raw.enabled !== "boolean" ||
        !Number.isSafeInteger(raw.maxConcurrent) || Number(raw.maxConcurrent) < 1 ||
        Number(raw.maxConcurrent) > CODEX_PROFILE_MAX_CONCURRENCY || rows.has(raw.profileId) ||
        Object.keys(raw).some((key) => !["profileId", "enabled", "maxConcurrent"].includes(key))) {
      throw new Error("codex_pool_policy_invalid");
    }
    if (!registrySet.has(raw.profileId)) throw new Error("codex_pool_policy_stale_profile");
    rows.set(raw.profileId, { profileId: raw.profileId, enabled: raw.enabled, maxConcurrent: Number(raw.maxConcurrent) });
  }

  if (!allowMissingProfiles && rows.size !== registrySet.size) throw new Error("codex_pool_policy_profiles_incomplete");

  const profiles = registryIds.map((profileId) => rows.get(profileId) ?? { profileId, enabled: true, maxConcurrent: 1 });
  return { version: 1, dispatchEnabled: value.dispatchEnabled, protectInitiatingAccount: true, profiles };
}

/**
 * Durable operator policy for Codex profile workers. It stores profile IDs and
 * scheduling limits only; authentication remains owned by CodexProfiles.
 *
 * Mutations and reads run inside StateStore.update so this sidecar shares the
 * gateway's existing cross-process state.lock. This class deliberately does
 * not launch Codex, reserve tasks, or treat quota percentages as fungible.
 */
export class CodexPoolPolicyStore {
  private readonly path: string;

  constructor(private readonly store: StateStore) {
    if (!store || typeof store.dir !== "string" || !store.dir.startsWith("/")) throw new Error("codex_pool_policy_requires_state_store");
    this.path = join(store.dir, CODEX_POOL_POLICY_FILE);
  }

  private async readRegistryIds(): Promise<string[]> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(join(this.store.dir, "codex-profiles.json"), "utf8")); }
    catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw new Error("codex_profile_registry_invalid");
    }
    return parseProfileRegistry(parsed);
  }

  private async readPolicyFile(registryIds: readonly string[]): Promise<{ policy: CodexPoolPolicy; needsPersist: boolean }> {
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error: any) {
      if (error?.code === "ENOENT") return { policy: defaultPolicy(registryIds), needsPersist: true };
      throw new Error("codex_pool_policy_unavailable");
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) {
        throw new Error("codex_pool_policy_permissions_invalid");
      }
      const raw = await handle.readFile("utf8");
      if (Buffer.byteLength(raw) > 64 * 1024) throw new Error("codex_pool_policy_invalid");
      const parsed: unknown = JSON.parse(raw);
      // A profile added since the policy was last saved gets the safe default;
      // a removed profile remains a hard validation error instead of being reused.
      const policy = parsePolicy(parsed, registryIds, true);
      return { policy, needsPersist: Array.isArray((parsed as Record<string, unknown>).profiles) &&
        (parsed as { profiles: unknown[] }).profiles.length !== policy.profiles.length };
    } catch (error: any) {
      if (error instanceof SyntaxError) throw new Error("codex_pool_policy_invalid");
      throw error;
    } finally {
      await handle.close();
    }
  }

  private async writePolicy(policy: CodexPoolPolicy): Promise<void> {
    await mkdir(this.store.dir, { recursive: true, mode: 0o700 });
    await chmod(this.store.dir, 0o700).catch(() => undefined);
    const temp = `${this.path}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(policy, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, this.path);
      await chmod(this.path, 0o600);
      const directory = await open(this.store.dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  async read(): Promise<CodexPoolPolicy> {
    let result!: CodexPoolPolicy;
    await this.store.update(async () => {
      const registryIds = await this.readRegistryIds();
      const loaded = await this.readPolicyFile(registryIds);
      result = loaded.policy;
      // Persist the first-run disabled policy and defaults for any newly added profiles.
      if (loaded.needsPersist) await this.writePolicy(result);
    });
    return structuredClone(result);
  }

  async configure(value: unknown): Promise<CodexPoolPolicy> {
    let result!: CodexPoolPolicy;
    await this.store.update(async () => {
      const registryIds = await this.readRegistryIds();
      const policy = parsePolicy(value, registryIds, false);
      await this.writePolicy(policy);
      result = policy;
    });
    return structuredClone(result);
  }

  /**
   * Filters CodexProfiles' already ranked candidates. `activeCounts` must come
   * from the scheduler's authoritative assignment ledger; omitting it is a
   * fail-closed error. The returned list is advisory until a durable scheduler
   * atomically reserves the chosen profile/task.
   */
  async eligibleCandidates(rankedEligibleProfileIds: readonly string[], activeCounts: CodexPoolActiveCounts, origin: CodexOriginContext): Promise<string[]> {
    if (!Array.isArray(rankedEligibleProfileIds) || !isRecord(activeCounts)) throw new Error("codex_pool_capacity_required");
    if (!isRecord(origin) || typeof origin.resolved !== "boolean" || !Array.isArray(origin.protectedProfileIds) ||
        origin.protectedProfileIds.some(id => !isProfileId(id)) || new Set(origin.protectedProfileIds).size !== origin.protectedProfileIds.length) throw new Error("codex_origin_context_invalid");
    let result: string[] = [];
    await this.store.update(async () => {
      const registryIds = await this.readRegistryIds();
      const { policy } = await this.readPolicyFile(registryIds);
      const registrySet = new Set(registryIds);
      if (origin.protectedProfileIds.some(id => !registrySet.has(id))) throw new Error("codex_origin_profile_stale");
      if (rankedEligibleProfileIds.some((id) => !isProfileId(id) || !registrySet.has(id)) || new Set(rankedEligibleProfileIds).size !== rankedEligibleProfileIds.length) {
        throw new Error("codex_pool_candidate_profile_invalid");
      }
      for (const [profileId, active] of Object.entries(activeCounts)) {
        if (!registrySet.has(profileId) || !Number.isSafeInteger(active) || active < 0) throw new Error("codex_pool_capacity_invalid");
      }
      if (!policy.dispatchEnabled || !origin.resolved) return;
      const rules = new Map(policy.profiles.map((rule) => [rule.profileId, rule]));
      result = rankedEligibleProfileIds.filter((profileId) => {
        if (origin.protectedProfileIds.includes(profileId)) return false;
        const rule = rules.get(profileId);
        return !!rule?.enabled && (activeCounts[profileId] ?? 0) < rule.maxConcurrent;
      });
    });
    return result;
  }
}
