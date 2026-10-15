import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StateStore } from "./store.js";

export const RESOURCE_FAMILIES = ["workspace", "inference", "private", "search"] as const;
export type ResourceFamily = typeof RESOURCE_FAMILIES[number];
export type ResourceRoutingRules = {
  version: 1;
  unknownCapacity: number;
  providerCaps: Partial<Record<ResourceFamily, number>>;
  resources: Record<string, { enabled: boolean; weight: number; capacity?: number }>;
};
export type ResourceCandidate = {
  id: string;
  providerFamily: ResourceFamily;
  enabled: boolean;
  auth: "valid" | "invalid" | "unknown";
  health: "healthy" | "unhealthy" | "unknown";
  quota?: { state: "available" | "depleted" | "unknown"; observedAt?: number; expiresAt?: number };
  models?: string[];
  capabilities?: string[];
  maxContextTokens?: number;
  capacity?: number;
  inFlight?: number;
  completedTasks?: number;
};
export type RoutingTask = {
  id: string;
  model?: string;
  requiredCapabilities?: string[];
  contextTokens?: number;
  stickyResourceId?: string;
};
export type ResourceEvaluation = { resourceId: string; eligible: boolean; reasons: string[]; quota: "available" | "depleted" | "unknown"; capacity: number; weight: number };
export type ResourceRoutingPlan = {
  assignments: Array<{ workId: string; resourceId: string }>;
  eligible: ResourceEvaluation[];
  rejected: ResourceEvaluation[];
  nextCursor: number;
  explanation: string[];
};

const FILE = "resource-routing-rules.json";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_RULES: ResourceRoutingRules = { version: 1, unknownCapacity: 1, providerCaps: {}, resources: {} };
function obj(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function closed(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${label} has unsupported field: ${key}`);
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new TypeError(`${label} is invalid`);
  return value as number;
}

export function validateResourceRoutingRules(value: unknown): ResourceRoutingRules {
  const root = obj(value);
  if (!root) throw new TypeError("resource routing rules must be an object");
  closed(root, ["version", "unknownCapacity", "providerCaps", "resources"], "rules");
  if (root.version !== 1) throw new TypeError("unsupported resource routing rules version");
  const unknownCapacity = root.unknownCapacity === undefined ? 1 : integer(root.unknownCapacity, 1, 100, "unknownCapacity");
  const rawCaps = root.providerCaps === undefined ? {} : obj(root.providerCaps);
  if (!rawCaps) throw new TypeError("providerCaps must be an object");
  const providerCaps: Partial<Record<ResourceFamily, number>> = {};
  for (const [family, cap] of Object.entries(rawCaps)) {
    if (!(RESOURCE_FAMILIES as readonly string[]).includes(family)) throw new TypeError(`unknown provider family: ${family}`);
    providerCaps[family as ResourceFamily] = integer(cap, 1, 1000, `providerCaps.${family}`);
  }
  const rawResources = root.resources === undefined ? {} : obj(root.resources);
  if (!rawResources) throw new TypeError("resources must be an object");
  const resources: ResourceRoutingRules["resources"] = Object.create(null);
  for (const [id, raw] of Object.entries(rawResources)) {
    if (!ID.test(id)) throw new TypeError("resource rule ID is invalid");
    const item = obj(raw);
    if (!item) throw new TypeError(`resource rule ${id} must be an object`);
    closed(item, ["enabled", "weight", "capacity"], `resource rule ${id}`);
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new TypeError(`resource rule ${id}.enabled is invalid`);
    const weight = item.weight === undefined ? 1 : item.weight;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0.01 || weight > 100) throw new TypeError(`resource rule ${id}.weight is invalid`);
    resources[id] = { enabled: item.enabled ?? true, weight, ...(item.capacity === undefined ? {} : { capacity: integer(item.capacity, 1, 1000, `resource rule ${id}.capacity`) }) };
  }
  return { version: 1, unknownCapacity, providerCaps, resources };
}

/** Rules contain routing policy only, never provider credentials or tokens. Writes serialize on StateStore's cross-process lock. */
export class ResourceRoutingRulesStore {
  readonly path: string;
  constructor(private readonly state: StateStore) { this.path = join(state.dir, FILE); }
  async read(): Promise<ResourceRoutingRules> {
    try { return validateResourceRoutingRules(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error: any) { if (error?.code === "ENOENT") return structuredClone(DEFAULT_RULES); throw error; }
  }
  template(): string { return JSON.stringify(DEFAULT_RULES, null, 2) + "\n"; }
  async replace(value: unknown): Promise<ResourceRoutingRules> {
    const rules = validateResourceRoutingRules(value);
    await this.state.update(async () => {
      await mkdir(this.state.dir, { recursive: true, mode: 0o700 });
      await chmod(this.state.dir, 0o700).catch(() => undefined);
      const temp = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temp, JSON.stringify(rules, null, 2) + "\n", { mode: 0o600 });
      await rename(temp, this.path); await chmod(this.path, 0o600);
    });
    return rules;
  }
}

/** An account rule can reduce an adapter limit, but can never raise it. */
export function boundedAccountCapacity(configured: number | undefined, hardLimit: number): number {
  if (!Number.isSafeInteger(hardLimit) || hardLimit < 1) throw new TypeError("hard account capacity is invalid");
  if (configured !== undefined && (!Number.isSafeInteger(configured) || configured < 1)) throw new TypeError("configured account capacity is invalid");
  return Math.min(configured ?? hardLimit, hardLimit);
}

export function planResourceRouting(input: {
  resources: ResourceCandidate[];
  task: RoutingTask;
  rules?: ResourceRoutingRules;
  workItems?: string[];
  inProgressWorkIds?: string[];
  maxFanout?: number;
  cursor?: number;
  now?: number;
}): ResourceRoutingPlan {
  const rules = validateResourceRoutingRules(input.rules ?? DEFAULT_RULES);
  const task = input.task;
  if (!task || !ID.test(task.id)) throw new TypeError("routing task ID is invalid");
  if (!Array.isArray(input.resources)) throw new TypeError("resource metadata must be an array");
  const maxFanout = integer(input.maxFanout ?? 1, 1, 32, "maxFanout");
  const now = input.now ?? Date.now();
  const seenResources = new Set<string>();
  const all = input.resources.map((resource) => {
    const reasons: string[] = [];
    if (!resource || !ID.test(resource.id) || !(RESOURCE_FAMILIES as readonly string[]).includes(resource.providerFamily)) throw new TypeError("resource metadata is invalid");
    if (seenResources.has(resource.id)) throw new TypeError("resource IDs must be unique");
    seenResources.add(resource.id);
    if (!["valid", "invalid", "unknown"].includes(resource.auth) || !["healthy", "unhealthy", "unknown"].includes(resource.health) ||
        resource.quota && !["available", "depleted", "unknown"].includes(resource.quota.state) ||
        resource.capacity !== undefined && (!Number.isSafeInteger(resource.capacity) || resource.capacity < 1 || resource.capacity > 1000) ||
        resource.inFlight !== undefined && (!Number.isSafeInteger(resource.inFlight) || resource.inFlight < 0) ||
        resource.completedTasks !== undefined && (!Number.isSafeInteger(resource.completedTasks) || resource.completedTasks < 0) ||
        resource.models !== undefined && (!Array.isArray(resource.models) || resource.models.some((x) => typeof x !== "string")) ||
        resource.capabilities !== undefined && (!Array.isArray(resource.capabilities) || resource.capabilities.some((x) => typeof x !== "string"))) throw new TypeError(`resource ${resource.id} metadata is invalid`);
    if (!resource.enabled || rules.resources[resource.id]?.enabled === false) reasons.push("disabled");
    if (resource.auth !== "valid") reasons.push(`auth_${resource.auth}`);
    if (resource.health !== "healthy") reasons.push(`health_${resource.health}`);
    let quota: ResourceEvaluation["quota"] = resource.quota?.state ?? "unknown";
    if (resource.quota?.state === "available" && (!Number.isFinite(resource.quota.expiresAt) || resource.quota.expiresAt! <= now)) quota = "unknown";
    if (quota === "depleted") reasons.push("quota_depleted");
    if (task.model && !resource.models?.includes(task.model)) reasons.push(resource.models ? "model_unsupported" : "model_unknown");
    for (const capability of task.requiredCapabilities ?? []) if (!resource.capabilities?.includes(capability)) reasons.push("capability_missing");
    if (task.contextTokens !== undefined && (!Number.isSafeInteger(task.contextTokens) || task.contextTokens < 0)) throw new TypeError("contextTokens is invalid");
    if (task.contextTokens && (!Number.isSafeInteger(resource.maxContextTokens) || resource.maxContextTokens! < task.contextTokens)) reasons.push(resource.maxContextTokens === undefined ? "context_unknown" : "context_too_small");
    const accountRule = rules.resources[resource.id];
    const capacity = Math.min(accountRule?.capacity ?? resource.capacity ?? rules.unknownCapacity, resource.capacity ?? accountRule?.capacity ?? rules.unknownCapacity);
    const weight = accountRule?.weight ?? 1;
    return { resource, evaluation: { resourceId: resource.id, eligible: reasons.length === 0, reasons, quota, capacity, weight } satisfies ResourceEvaluation };
  });
  const eligible = all.filter((x) => x.evaluation.eligible).map((x) => x.evaluation);
  const rejected = all.filter((x) => !x.evaluation.eligible).map((x) => x.evaluation);
  const rawWork = input.workItems ?? [task.id];
  if (!Array.isArray(rawWork) || rawWork.some((id) => typeof id !== "string" || !ID.test(id))) throw new TypeError("work item IDs are invalid");
  const running = input.inProgressWorkIds ?? [];
  if (!Array.isArray(running) || running.some((id) => typeof id !== "string" || !ID.test(id))) throw new TypeError("in-progress work IDs are invalid");
  const activeWork = new Set(running);
  const work = [...new Set(rawWork)].filter((id) => !activeWork.has(id));
  const assignments: ResourceRoutingPlan["assignments"] = [];
  const explanation: string[] = [];
  let cursor = Number.isSafeInteger(input.cursor) ? Math.abs(input.cursor!) : 0;
  const familyLoads = new Map<ResourceFamily, number>();
  for (const { resource } of all) familyLoads.set(resource.providerFamily, (familyLoads.get(resource.providerFamily) || 0) + Math.max(0, resource.inFlight ?? 0));
  const plannedPerResource = new Map<string, number>();
  const pinned = task.stickyResourceId;
  const candidates = pinned ? all.filter((x) => x.resource.id === pinned) : all.filter((x) => x.evaluation.eligible);
  if (pinned && (!candidates.length || !candidates[0].evaluation.eligible)) {
    explanation.push(`Sticky resource ${pinned} is unavailable; stateful work will not move to another resource.`);
  } else {
    const uniqueWork = work.slice(0, maxFanout);
    if (input.workItems && work.length > uniqueWork.length) explanation.push(`Fanout capped at ${maxFanout}; remaining unique work was deferred.`);
    for (const workId of uniqueWork) {
      const eligibleNow = candidates.filter(({ resource, evaluation }) => {
        if (!evaluation.eligible) return false;
        const accountCap = evaluation.capacity;
        const familyCap = rules.providerCaps[resource.providerFamily] ?? rules.unknownCapacity;
        const usedAccount = Math.max(0, resource.inFlight ?? 0) + (plannedPerResource.get(resource.id) || 0);
        const usedProvider = (familyLoads.get(resource.providerFamily) || 0) + assignments.filter((a) => all.find((x) => x.resource.id === a.resourceId)?.resource.providerFamily === resource.providerFamily).length;
        return usedAccount < accountCap && usedProvider < familyCap;
      });
      if (!eligibleNow.length) { explanation.push("No idle eligible capacity remains; excess work was deferred."); break; }
      const score = (resource: ResourceCandidate, weight: number) => ((resource.completedTasks ?? 0) + Math.max(0, resource.inFlight ?? 0) + (plannedPerResource.get(resource.id) || 0)) / weight;
      const ordered = [...eligibleNow].sort((a, b) => score(a.resource, a.evaluation.weight) - score(b.resource, b.evaluation.weight) || ((a.resource.inFlight ?? 0) + (plannedPerResource.get(a.resource.id) || 0)) - ((b.resource.inFlight ?? 0) + (plannedPerResource.get(b.resource.id) || 0)) || a.resource.id.localeCompare(b.resource.id));
      const bestScore = score(ordered[0].resource, ordered[0].evaluation.weight);
      const bestUsed = (ordered[0].resource.inFlight ?? 0) + (plannedPerResource.get(ordered[0].resource.id) || 0);
      const ties = ordered.filter((x) => Math.abs(score(x.resource, x.evaluation.weight) - bestScore) < 1e-9 && (x.resource.inFlight ?? 0) + (plannedPerResource.get(x.resource.id) || 0) === bestUsed);
      const pick = ties[cursor % ties.length];
      const index = input.resources.findIndex((r) => r.id === pick.resource.id);
      assignments.push({ workId, resourceId: pick.resource.id });
      plannedPerResource.set(pick.resource.id, (plannedPerResource.get(pick.resource.id) || 0) + 1);
      cursor = (index + 1) % Math.max(1, input.resources.length);
    }
    if (pinned && !assignments.length) explanation.push(`Sticky resource ${pinned} has no idle capacity; stateful work was not rerouted.`);
    if (pinned && assignments.length) explanation.push(`Sticky resource ${pinned} retained for the follow-up.`);
  }
  if (!work.length) explanation.push("No new work was planned; duplicate or already-running work is not replayed.");
  for (const item of eligible) if (all.find((x) => x.resource.id === item.resourceId)?.resource.capacity === undefined && rules.resources[item.resourceId]?.capacity === undefined) explanation.push(`${item.resourceId} uses conservative unknown capacity ${rules.unknownCapacity}.`);
  for (const family of new Set(eligible.map((item) => all.find((x) => x.resource.id === item.resourceId)!.resource.providerFamily))) if (rules.providerCaps[family] === undefined) explanation.push(`${family} provider cap is unknown; conservative cap ${rules.unknownCapacity} applies.`);
  if (eligible.some((item) => item.quota === "unknown")) explanation.push("Quota is unknown; expired snapshots are not treated as available.");
  return { assignments, eligible, rejected, nextCursor: cursor, explanation: [...new Set(explanation)].slice(0, 32) };
}
