import {ResourceRoutingRulesStore, boundedAccountCapacity} from "./resource-routing.js";
import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PROVIDER_PROFILES } from "./provider-capabilities.js";
import { createJobWorker, type JobBridge, type JobWorkerOptions, type PinnedJobsAdapter } from "./job-worker.js";
import { JobInputError, validateJobToolArguments, type JobTaskInput, type JobToolName } from "./job-submit.js";
import { LightSprintJobsAdapter } from "./providers/lightsprint-jobs.js";
import { LightSprintWorkspacePinnedJobsAdapter, workspaceBranchName } from "./providers/lightsprint-workspace-pinned-jobs.js";
import type { StateStore } from "./store.js";
import type { UpstreamAccount } from "./types.js";
import { redactString } from "./telemetry.js";
import { fleetLabel, isPrimaryFleet } from "./fleet-identity.js";
import { SupervisorBridge, type SupervisorBridgeOptions } from "./supervisor-bridge.js";
import type { SupervisorBackend, SupervisorCaller, WorkspaceAccessSnapshot, WorkspaceAccessUpdate } from "./supervisor-api.js";
import type { SupervisorAccountUsage, SupervisorEvent, SupervisorJob, SupervisorSnapshot, SupervisorTask, SupervisorUsage, SupervisorWorker } from "./supervisor-ui.js";
import { evaluateToolCall } from "./tool-policy.js";
import { normalizeParkedQuestion } from "./worker-observation.js";
import { WorkerGuidanceLedger, WorkerGuidanceService, type WorkerGuidanceInput, type WorkerGuidanceResult } from "./worker-guidance.js";
import { safeClientId } from "./oauth-client-id.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
// Provider-generated session IDs may begin with '_' or '-'; neither is a path separator.
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const FRESH_PROVIDERS = ["claude", "codex", "auto", "pi"] as const;
const STACK_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
const MAX_CONFIG = 64 * 1024;
type RuntimeStateGroup = "supervision" | "oracle-pool";
const STATE_FILES: Record<RuntimeStateGroup, string[]> = {
  supervision: ["inbox.sqlite", "recovery.sqlite3"],
  "oracle-pool": ["config.json", "queue.sqlite3"],
};
/** Existing legacy persistence remains authoritative until the explicit root-owned migration. */
export function runtimeStateRoot(group: RuntimeStateGroup, home = homedir()): string {
  const canonical = join(home, ".local", "state", "rotoxy");
  const legacy = join(home, ".local", "state", "token2oauth");
  const hasKnownState = (root: string) => STATE_FILES[group].some((relative) => existsSync(join(root, group, relative)));
  if (hasKnownState(canonical)) return canonical;
  if (hasKnownState(legacy)) return legacy;
  return canonical;
}
export function runtimeStatePath(group: RuntimeStateGroup, ...parts: string[]): string { return join(runtimeStateRoot(group), group, ...parts); }
type RegisteredSession = { sessionId: string; accountId: string; model: string; workspaceId: string };
type FreshProvisioningBinding = { accountId: string; workspaceId: string; stackId: string; provider: "claude" | "codex" | "auto" | "pi" };
type ProjectPolicy = { projectId: string; clientIds: string[]; accountIds: string[]; registeredSessions: RegisteredSession[]; freshProvisioningBindings?: FreshProvisioningBinding[] };
/** An operator-opted-in shared provider workspace, distinct from project folders. */
type SharedWorkspacePolicy = { projectId: string; membership: "consented_oauth" | "authenticated_mcp" };
export interface SupervisorRuntimeConfig {
  version: 1;
  projects: ProjectPolicy[];
  sharedWorkspace?: SharedWorkspacePolicy;
  maxWorkers: number;
  allowUnknownQuota: true;
  localLimits: { maxTasks: number; maxJobBytes: number; maxOutputBytes: number };
}
export interface SupervisorRuntimeOptions {
  configPath?: string;
  configDir: string;
  supervisorCwd?: string;
  /** Private local database shared with the persistent read-only workforce monitor. */
  supervisionDbPath?: string;
  /** Private RecoveryEngine/service database. Tests and isolated installs must provide their own path. */
  recoveryDbPath?: string;
  oracleConfigPath?: string;
  oracleDbPath?: string;
  store: StateStore;
  bridgeOptions?: Partial<SupervisorBridgeOptions>;
  /** Injection seam for deterministic tests; production defaults to the pinned LightSprint adapter. */
  adapterFactory?: JobWorkerOptions["adapterFactory"];
  workerOptions?: Partial<Pick<JobWorkerOptions, "pollIntervalMs" | "requestTimeoutMs" | "adapterTimeoutMs" | "now" | "onDiagnostic">>;
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function usageProjection(value: unknown): SupervisorUsage | undefined {
  if (!object(value)) return undefined;
  const nonnegative = (key: string) => typeof value[key] === "number" && Number.isFinite(value[key]) && Number(value[key]) >= 0 ? Number(value[key]) : undefined;
  const text = (key: string) => typeof value[key] === "string" && (value[key] as string).length <= 64 ? redactString(value[key] as string, 64) : undefined;
  const usage: SupervisorUsage = {
    reportedSessionCostUsd: nonnegative("reportedSessionCostUsd"), reportedCostDeltaUsd: nonnegative("reportedCostDeltaUsd"),
    promptCountDelta: (() => { const n = nonnegative("promptCountDelta"); return n !== undefined && Number.isInteger(n) ? n : undefined; })(),
    budgetUsed: nonnegative("budgetUsed"),
    maxBudget: (() => { const n = value.maxBudget; return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined; })(),
    fundingSource: text("fundingSource"), sandboxTier: text("sandboxTier"),
    observedAt: typeof value.observedAt === "number" && Number.isFinite(value.observedAt) ? value.observedAt : typeof value.observedAt === "string" && Number.isFinite(Date.parse(value.observedAt)) ? value.observedAt : undefined,
    source: value.source === "lightsprint-session-status" ? value.source : undefined,
    provisional: typeof value.provisional === "boolean" ? value.provisional : undefined,
    budgetUnit: value.budgetUnit === "unknown" ? "unknown" : undefined,
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}
function safeAccountId(value: unknown): value is string { return typeof value === "string" && ACCOUNT_ID.test(value); }
function safeId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function safeSessionId(value: unknown): value is string { return typeof value === "string" && SESSION_ID.test(value); }
function inboxEvent(value: unknown): Record<string, unknown> | undefined {
  if (!object(value) || !Number.isSafeInteger(value.id) || Number(value.id) < 1 ||
      typeof value.eventId !== "string" || !/^(?:repo|job):[1-9][0-9]{0,18}$/.test(value.eventId) ||
      typeof value.at !== "number" || !Number.isFinite(value.at) || value.at < 0 ||
      typeof value.type !== "string" || !/^[A-Za-z0-9_.:@/-]{1,256}$/.test(value.type) ||
      typeof value.acknowledged !== "boolean") return undefined;
  const boundedOptional = (input: unknown, max: number) => input === null ? null :
    typeof input === "string" && input.length <= max && /^[A-Za-z0-9_.:@/-]{1,256}$/.test(input) ? input : null;
  const assignmentId = boundedOptional(value.assignmentId, 128);
  const taskId = boundedOptional(value.taskId, 256);
  const state = boundedOptional(value.state, 64);
  return { id: value.id, eventId: value.eventId, at: value.at, type: value.type,
    assignmentId, taskId, state, acknowledged: value.acknowledged };
}
function assertKeys(value: Record<string, unknown>, keys: string[], where: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`Invalid supervisor config fields: ${where}`);
}
function parseJson(body: unknown): Record<string, unknown> {
  if (!body) return {};
  if (object(body)) return body;
  try { const encoded = typeof body === "string" ? body : Buffer.from(body as Uint8Array).toString("utf8"); const value: unknown = JSON.parse(encoded); return object(value) ? value : {}; }
  catch { throw new Error("invalid_supervisor_response"); }
}
function boundedJson(value: unknown, max = 1_048_576): unknown {
  if (Buffer.byteLength(JSON.stringify(value)) > max) throw new JobInputError("supervisor response exceeds configured bounds");
  return value;
}
function nativeLightSprintTarget(url: string): boolean {
  try {
    const actual = new URL(url);
    const expected = new URL(PROVIDER_PROFILES.lightsprint.defaultServerUrl);
    return actual.href === expected.href && actual.protocol === "https:" && actual.pathname === "/mcp" && !actual.search && !actual.hash;
  } catch { return false; }
}
function accountSignal(account: UpstreamAccount | undefined, nativeTarget: boolean) {
  const providerOk = account?.provider === "lightsprint" || (account?.provider === "generic-bearer-mcp" && nativeTarget);
  const enabled = account?.enabled === true;
  const authFailed = account?.stats?.state === "auth-failed" || account?.stats?.lastStatus === 401;
  const cooldownUntil = account?.stats?.cooldownUntil;
  const finiteCooldown = typeof cooldownUntil === "number" && Number.isFinite(cooldownUntil);
  const cooling = finiteCooldown && cooldownUntil > Date.now();
  const cooldownExpired = account?.stats?.state === "cooldown" && finiteCooldown && cooldownUntil <= Date.now();
  const health = authFailed ? "auth_failed" : !cooling && (account?.stats?.state === "healthy" || account?.stats?.state === "exhausted" || cooldownExpired) ? "healthy" : "degraded";
  // A 429 is a rate-limit observation, not proof that account credits are depleted.
  const quota = account?.stats?.state === "exhausted" || account?.stats?.lastStatus === 402 ? "depleted" : "unknown";
  return { providerOk, enabled, authorized: !!providerOk && !authFailed, health, quota };
}

type CreditReadiness = { kind: "strict"; accounts: Map<string, { available: number | null; operationUpperBound: number | null; boundVerified: boolean }> } | { kind: "disabled" | "legacy" | "malformed" | "unavailable" };
function creditReadinessShape(value: unknown, projectAccounts: ReadonlySet<string>): CreditReadiness {
  if (!object(value)) return { kind: "malformed" };
  if (value.mode === "legacy") return { kind: "legacy" };
  if (value.mode === "disabled") return { kind: "disabled" };
  if (value.mode !== "strict" || !Array.isArray(value.accounts)) return { kind: "malformed" };
  const accounts = new Map<string, { available: number | null; operationUpperBound: number | null; boundVerified: boolean }>();
  for (const item of value.accounts) {
    if (!object(item) || !safeAccountId(item.accountId)) return { kind: "malformed" };
    if (!projectAccounts.has(item.accountId)) continue;
    if (typeof item.unit !== "string" || item.unit.length > 64 ||
        !(item.available === null || Number.isSafeInteger(item.available) && Number(item.available) >= 0) ||
        !(item.operationUpperBound === null || Number.isSafeInteger(item.operationUpperBound) && Number(item.operationUpperBound) > 0) ||
        typeof item.boundVerified !== "boolean" || accounts.has(item.accountId)) return { kind: "malformed" };
    accounts.set(item.accountId, { available: item.available as number | null, operationUpperBound: item.operationUpperBound as number | null, boundVerified: item.boundVerified });
  }
  return { kind: "strict", accounts };
}

/** Parse strict private configuration. Every usable session includes its actual workspace identifier. */
export async function readSupervisorRuntimeConfig(path: string): Promise<SupervisorRuntimeConfig> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0 || info.size > MAX_CONFIG) {
    throw new Error("Supervisor config must be a private, owner-only regular file no larger than 64 KiB");
  }
  const raw: unknown = JSON.parse(await readFile(absolute, "utf8"));
  if (!object(raw)) throw new Error("Supervisor config must be an object");
  assertKeys(raw, ["version", "projects", "sharedWorkspace", "maxWorkers", "allowUnknownQuota", "localLimits"], "root");
  if (raw.version !== 1 || raw.allowUnknownQuota !== true || !Number.isInteger(raw.maxWorkers) || Number(raw.maxWorkers) < 1 || Number(raw.maxWorkers) > 32 || !Array.isArray(raw.projects) || !object(raw.localLimits)) throw new Error("Invalid supervisor config");
  assertKeys(raw.localLimits, ["maxTasks", "maxJobBytes", "maxOutputBytes"], "localLimits");
  if (!Number.isInteger(raw.localLimits.maxTasks) || Number(raw.localLimits.maxTasks) < 1 || Number(raw.localLimits.maxTasks) > 100 ||
      !Number.isInteger(raw.localLimits.maxJobBytes) || Number(raw.localLimits.maxJobBytes) < 1024 || Number(raw.localLimits.maxJobBytes) > 1_048_576 ||
      !Number.isInteger(raw.localLimits.maxOutputBytes) || Number(raw.localLimits.maxOutputBytes) < 1 || Number(raw.localLimits.maxOutputBytes) > 32_768) throw new Error("Supervisor limits exceed supported bounds");
  const projects: ProjectPolicy[] = raw.projects.map((candidate: unknown): ProjectPolicy => {
    if (!object(candidate)) throw new Error("Invalid project policy");
    assertKeys(candidate, ["projectId", "clientIds", "accountIds", "registeredSessions", "freshProvisioningBindings"], "project");
    const projectId = candidate.projectId, rawClientIds = candidate.clientIds, rawAccountIds = candidate.accountIds, rawSessions = candidate.registeredSessions;
    if (!safeId(projectId) || !Array.isArray(rawClientIds) || rawClientIds.length > 50 || !rawClientIds.every(safeClientId) || new Set(rawClientIds).size !== rawClientIds.length ||
        !Array.isArray(rawAccountIds) || rawAccountIds.length > 50 || !rawAccountIds.every(safeAccountId) || new Set(rawAccountIds).size !== rawAccountIds.length || !Array.isArray(rawSessions)) throw new Error("Invalid project bindings");
    const accountIds = rawAccountIds as string[];
    const registeredSessions: RegisteredSession[] = rawSessions.map((item: unknown): RegisteredSession => {
      if (!object(item)) throw new Error("Invalid registered session");
      assertKeys(item, ["sessionId", "accountId", "model", "workspaceId"], "registeredSession");
      if (!safeSessionId(item.sessionId) || !safeAccountId(item.accountId) || !accountIds.includes(item.accountId) || typeof item.model !== "string" || !MODEL_ID.test(item.model) || !safeSessionId(item.workspaceId)) throw new Error("Registered sessions must be bound to an eligible account, workspace, and declared model");
      return { sessionId: item.sessionId, accountId: item.accountId, model: item.model, workspaceId: item.workspaceId };
    });
    if (registeredSessions.length * rawClientIds.length > 1000) throw new Error("Project has too many registered monitoring bindings");
    if (new Set(registeredSessions.map((item) => item.sessionId)).size !== registeredSessions.length) throw new Error("Duplicate registered session");
    let freshProvisioningBindings: FreshProvisioningBinding[] | undefined;
    if (candidate.freshProvisioningBindings !== undefined) {
      if (!Array.isArray(candidate.freshProvisioningBindings) || candidate.freshProvisioningBindings.length > 50) throw new Error("Invalid fresh-provisioning bindings");
      freshProvisioningBindings = candidate.freshProvisioningBindings.map((item: unknown): FreshProvisioningBinding => {
        if (!object(item)) throw new Error("Invalid fresh-provisioning binding");
        assertKeys(item, ["accountId", "workspaceId", "stackId", "provider"], "freshProvisioningBinding");
        if (!safeAccountId(item.accountId) || !accountIds.includes(item.accountId) || !safeId(item.workspaceId) || typeof item.stackId !== "string" || !STACK_ID.test(item.stackId) ||
            typeof item.provider !== "string" || !(FRESH_PROVIDERS as readonly string[]).includes(item.provider)) {
          throw new Error("Fresh-provisioning bindings must name a project account, verified workspace, safe stack ID, and supported provider");
        }
        return { accountId: item.accountId, workspaceId: item.workspaceId, stackId: item.stackId, provider: item.provider as FreshProvisioningBinding["provider"] };
      });
      if (new Set(freshProvisioningBindings.map((item) => `${item.accountId}:${item.provider}`)).size !== freshProvisioningBindings.length) throw new Error("Each account/provider pair may have only one fresh-provisioning binding");
    }
    return { projectId, clientIds: rawClientIds as string[], accountIds, registeredSessions,
      ...(freshProvisioningBindings ? { freshProvisioningBindings } : {}) };
  });
  if (!projects.length || new Set(projects.map((item) => item.projectId)).size !== projects.length) throw new Error("Supervisor config needs unique projects");
  let sharedWorkspace: SharedWorkspacePolicy | undefined;
  if (raw.sharedWorkspace !== undefined) {
    if (!object(raw.sharedWorkspace)) throw new Error("Invalid shared workspace policy");
    assertKeys(raw.sharedWorkspace, ["projectId", "membership"], "sharedWorkspace");
    if (!safeId(raw.sharedWorkspace.projectId) || !["consented_oauth", "authenticated_mcp"].includes(String(raw.sharedWorkspace.membership)) ||
        !projects.some((project) => project.projectId === (raw.sharedWorkspace as Record<string, unknown>).projectId)) {
      throw new Error("Shared workspace must reference a configured project and supported membership policy");
    }
    sharedWorkspace = { projectId: raw.sharedWorkspace.projectId, membership: raw.sharedWorkspace.membership as SharedWorkspacePolicy["membership"] };
  }
  const sessionIds = projects.flatMap((p) => p.registeredSessions.map((s) => s.sessionId));
  if (new Set(sessionIds).size !== sessionIds.length) throw new Error("A registered session may be owned by only one project");
  return { version: 1, projects, ...(sharedWorkspace ? { sharedWorkspace } : {}), maxWorkers: Number(raw.maxWorkers), allowUnknownQuota: true,
    localLimits: { maxTasks: Number(raw.localLimits.maxTasks), maxJobBytes: Number(raw.localLimits.maxJobBytes), maxOutputBytes: Number(raw.localLimits.maxOutputBytes) } };
}

function configuredProject(config: SupervisorRuntimeConfig, caller: SupervisorCaller): ProjectPolicy {
  const project = config.projects.find((item) => item.projectId === caller.projectId && item.clientIds.includes(caller.clientId));
  if (!project) throw new JobInputError("project is not authorized for this OAuth client");
  return project;
}

function workspaceAccessRevision(raw: string, clients: Array<{ clientId: string; label: string }>): string {
  return createHash("sha256").update(raw).update("\0").update(JSON.stringify(clients)).digest("hex");
}

export class SupervisorRuntime implements SupervisorBackend {
  private readonly bridge: SupervisorBridge;
  private worker?: ReturnType<typeof createJobWorker>;
  private closed = false;
  private started = false;
  private readonly adapterCache = new Map<string, PinnedJobsAdapter>();
  private readonly owner = (caller: SupervisorCaller) => ({ ownerPrincipalId: `oauth-client:${caller.clientId}`, clientId: caller.clientId });
  private readonly supervisorCwd: string;
  private readonly supervisionDbPath: string;
  private readonly recoveryDbPath: string;
  private readonly monitorRegistrationByProject = new Map<string, { expected: number; registered: number; failed: number }>();
  private readonly workerGuidance: WorkerGuidanceService;

  constructor(private config: SupervisorRuntimeConfig, private readonly options: SupervisorRuntimeOptions) {
    this.supervisorCwd = options.supervisorCwd ?? resolve(process.cwd(), "supervisor");
    this.supervisionDbPath = options.supervisionDbPath ?? runtimeStatePath("supervision", "inbox.sqlite");
    this.recoveryDbPath = options.recoveryDbPath ?? runtimeStatePath("supervision", "recovery.sqlite3");
    this.workerGuidance = new WorkerGuidanceService({
      ledger: new WorkerGuidanceLedger(options.store, options.configDir),
      findWorker: (projectId, workerId) => {
        const project = this.config.projects.find((row) => row.projectId === projectId);
        const session = project?.registeredSessions.find((row) => row.sessionId === workerId);
        return session ? { projectId, sessionId: session.sessionId, accountId: session.accountId, model: session.model } : undefined;
      },
      adapterFor: async (accountId) => {
        const timeoutMs = this.options.workerOptions?.adapterTimeoutMs ?? 30_000;
        if (this.options.adapterFactory) return this.options.adapterFactory(accountId, { timeoutMs });
        let adapter = this.adapterCache.get(accountId);
        if (!adapter) { adapter = new LightSprintJobsAdapter(this.options.store, accountId, { timeoutMs }); this.adapterCache.set(accountId, adapter); }
        return adapter;
      },
      accountEligible: async (accountId) => {
        const latest = await this.options.store.load();
        const signal = accountSignal(latest.accounts.find((row) => row.id === accountId), nativeLightSprintTarget(latest.config.upstreamUrl));
        return signal.enabled && signal.authorized && signal.health === "healthy" && (signal.quota === "available" || signal.quota === "unknown" && this.config.allowUnknownQuota);
      },
      policyAllows: async (worker, message, clientMessageId) => {
        const latest = await this.options.store.load();
        return evaluateToolCall(latest.config.toolPolicy, { name: "lightsprint_api", arguments: {
          method: "POST", path: `/api/agent-sessions/${worker.sessionId}/chat`, body: { message, clientMessageId },
        } }).allowed;
      },
    });
    const spawnChild = options.bridgeOptions?.spawnChild ?? ((function (command: string, args?: readonly string[], spawnOptions?: any) {
      if (!args || args[0] !== "-m" || args[1] !== "snooze.bridge") throw new Error("Unexpected supervisor command");
      const code = "import os,runpy,sys; os.umask(0o177); sys.argv=['snooze.bridge',*sys.argv[1:]]; runpy.run_module('snooze.bridge',run_name='__main__')";
      return nodeSpawn(command, ["-c", code, ...args.slice(2)], spawnOptions);
    }) as typeof nodeSpawn);
    this.bridge = new SupervisorBridge({ enabled: true, configDir: options.configDir, supervisorCwd: this.supervisorCwd, ...options.bridgeOptions, spawnChild });
  }

  private async guidanceCommand(command: string, payload?: unknown, extra: string[] = []): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      const python = "/usr/bin/python3";
      const child = nodeSpawn(python, ["-m", "snooze.guidance", "--db", this.supervisionDbPath, ...extra, command], {
        cwd: this.supervisorCwd,
        env: { ...process.env, PYTHONPATH: this.supervisorCwd },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.stdout.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 512 * 1024) child.kill("SIGKILL"); else chunks.push(bytes);
      });
      child.once("error", () => { clearTimeout(timer); rejectPromise(new Error("guidance_unavailable")); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return rejectPromise(new Error("guidance_unavailable"));
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
          resolvePromise(value);
        } catch { rejectPromise(new Error("guidance_unavailable")); }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(payload === undefined ? "" : JSON.stringify(payload));
    });
  }

  /** Read-only fixed-module projection. The HTTP request can select only its configured project, never a DB path. */
  private async recoverySnapshot(projectId: string, owners: string[], after = 0, limit = 20): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      const python = "/usr/bin/python3";
      const args = ["-m", "snooze.recovery_service", "--snapshot", "--db", this.recoveryDbPath,
        "--project", projectId, "--owners", ...owners, "--after", String(after), "--limit", String(limit),
        "--oracle-db", this.options.oracleDbPath ?? runtimeStatePath("oracle-pool", "queue.sqlite3")];
      const child = nodeSpawn(python, args, { cwd: this.supervisorCwd,
        env: { ...process.env, PYTHONPATH: this.supervisorCwd }, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let size = 0;
      let exceeded = false;
      const timer = setTimeout(() => { exceeded = true; child.kill("SIGKILL"); }, 5_000);
      child.stdout.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 256 * 1024) { exceeded = true; child.kill("SIGKILL"); } else chunks.push(bytes);
      });
      child.once("error", () => { clearTimeout(timer); rejectPromise(new Error("recovery_snapshot_unavailable")); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || exceeded) return rejectPromise(new Error("recovery_snapshot_unavailable"));
        try { resolvePromise(JSON.parse(Buffer.concat(chunks, size).toString("utf8"))); }
        catch { rejectPromise(new Error("recovery_snapshot_unavailable")); }
      });
    });
  }

  private async registerMonitoredSessions(): Promise<void> {
    this.monitorRegistrationByProject.clear();
    for (const project of this.config.projects) {
      const registration = { expected: project.clientIds.length * project.registeredSessions.length, registered: 0, failed: 0 };
      this.monitorRegistrationByProject.set(project.projectId, registration);
      const workers = project.clientIds.flatMap((clientId) => project.registeredSessions.map((session) => ({
        worker: `worker:${createHash("sha256").update(`${project.projectId}\0${clientId}\0${session.sessionId}`).digest("hex").slice(0, 40)}`,
        owner: `oauth-client:${clientId}`, account: session.accountId, session: session.sessionId, model: session.model,
      })));
      try {
        await this.guidanceCommand("sync-project", { project: project.projectId, workers });
        registration.registered = workers.length;
      } catch {
        // Monitoring registration is best-effort; it never blocks task dispatch or changes provider state.
        registration.failed = workers.length;
      }
    }
  }

  private dispatchPolicyFingerprint = "";
  private async syncDispatchPolicy():Promise<void>{
    const [state,rules]=await Promise.all([this.options.store.load(),new ResourceRoutingRulesStore(this.options.store,this.options.configDir).read()]);
    const payloads=[...new Set(this.config.projects.flatMap(p=>p.accountIds))].map(accountId=>{
      const account=state.accounts.find(a=>a.id===accountId);
      const signal=accountSignal(account,nativeLightSprintTarget(state.config.upstreamUrl));
      const sessions=this.config.projects.flatMap(p=>p.registeredSessions).filter(s=>s.accountId===accountId);
      if(sessions.length>100)throw new Error("Supervisor config exceeds 100 sessions per account");
      const rule=rules.resources[accountId];const paused=rules.pools?.lightsprint?.enabled===false||rule?.enabled===false;
      return {accountId,enabled:signal.enabled,authorized:signal.authorized,allowUnknownQuota:this.config.allowUnknownQuota,health:paused?"degraded":signal.health,quota:signal.quota,
        localCapacity:boundedAccountCapacity(rule?.capacity,Math.min(16,Math.max(1,sessions.length))),
        registeredSessions:sessions.map(s=>({id:s.sessionId,model:s.model,workspace:s.workspaceId}))};
    });
    const fingerprint=JSON.stringify(payloads);if(fingerprint===this.dispatchPolicyFingerprint)return;
    for(const payload of payloads)await this.bridge.request("POST","/v1/accounts",payload);
    this.dispatchPolicyFingerprint=fingerprint;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.closed) throw new Error("supervisor_closed");
    await this.bridge.start();
    try {
      await this.syncDispatchPolicy();
    const adapters = this.options.adapterFactory ?? ((accountId, limits) => {
      let adapter = this.adapterCache.get(accountId);
      if (!adapter) { adapter = new LightSprintJobsAdapter(this.options.store, accountId, { timeoutMs: limits.timeoutMs }); this.adapterCache.set(accountId, adapter); }
      return adapter;
    });
    const operationAdapters: JobWorkerOptions["operationAdapterFactory"] = async (op, limits) => {
      // This factory is reached only after the bridge has durably claimed the operation.
      // Bind its single chat mutation to one private runtime registration; never infer
      // authority from the operation's project/client fields or caller-supplied headers.
      const freshKinds = new Set(["create_task", "patch_task", "verify_task_packet", "launch_task"]);
      const workspaceId = op.input.workspaceId;
      const workspaceOperation = freshKinds.has(op.kind) || (op.kind === "observe_session" && typeof workspaceId === "string" &&
        this.config.projects.flatMap((project) => project.freshProvisioningBindings ?? []).some((candidate) =>
          candidate.accountId === op.selectedAccountId && candidate.workspaceId === workspaceId));
      if (workspaceOperation && typeof workspaceId === "string") {
        const stackId = op.input.stackId;
        const provider = op.input.provider;
        const taskId = op.providerTaskId ?? op.input.providerTaskId;
        const sessionId = op.sessionId ?? op.input.sessionId;
        const title = op.input.title;
        const instructions = op.input.instructions;
        const binding = this.config.projects.flatMap((project) => project.freshProvisioningBindings ?? [])
          .filter((candidate) => candidate.accountId === op.selectedAccountId && candidate.workspaceId === workspaceId && candidate.stackId === stackId && candidate.provider === provider);
        if (!safeId(op.operationId) || !safeId(op.attemptId) || !Number.isSafeInteger(op.generation) || op.generation < 1 ||
            !safeAccountId(op.selectedAccountId) || binding.length !== 1 || !safeId(workspaceId) || typeof stackId !== "string" || !STACK_ID.test(stackId) ||
            typeof provider !== "string" || !(FRESH_PROVIDERS as readonly string[]).includes(provider) ||
            (op.kind !== "observe_session" && (typeof instructions !== "string" || instructions.trim().length === 0 || instructions.length > 16_384)) ||
            (op.kind === "create_task" && (typeof title !== "string" || title.trim().length === 0 || title.length > 500)) ||
            (freshKinds.has(op.kind) && op.kind !== "create_task" && (typeof taskId !== "string" || !safeId(taskId))) ||
            (op.kind === "observe_session" && (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)))) return undefined;
        if (this.options.adapterFactory) return this.options.adapterFactory(op.selectedAccountId, limits);
        const base = `/api/workspaces/${workspaceId}`;
        const expected = op.kind === "create_task"
          ? [Object.freeze({ method: "POST", path: `${base}/tasks`, body: Object.freeze({ title, stackId }) })]
          : op.kind === "patch_task"
            ? [Object.freeze({ method: "PATCH", path: `${base}/tasks/${taskId}`, body: Object.freeze({ description: instructions }) }),
              Object.freeze({ method: "GET", path: `${base}/tasks/${taskId}` })]
            : op.kind === "verify_task_packet"
              ? [Object.freeze({ method: "GET", path: `${base}/tasks/${taskId}` })]
            : op.kind === "launch_task"
              ? [Object.freeze({ method: "GET", path: `${base}/tasks/${taskId}` }),
                Object.freeze({ method: "GET", path: `${base}/tasks/${taskId}` }),
                Object.freeze({ method: "POST", path: `${base}/agent-sessions`, body: Object.freeze({ taskRef: taskId, branchName: workspaceBranchName(taskId as string), provider, autoMerge: false }) })]
              : [Object.freeze({ method: "GET", path: `${base}/agent-sessions/${sessionId}/status` }),
                Object.freeze({ method: "GET", path: `${base}/agent-sessions/${sessionId}/transcript?limit=100&include=text&maxBytes=131072` })];
        let cursor = 0;
        const permit = (request: Readonly<{ accountId: string; workspaceId: string; method: string; path: string; body?: Readonly<Record<string, unknown>> }>): boolean => {
          const candidate = expected[cursor];
          if (!candidate || request.accountId !== op.selectedAccountId || request.workspaceId !== workspaceId ||
              request.method !== candidate.method || request.path !== candidate.path ||
              JSON.stringify(request.body) !== JSON.stringify("body" in candidate ? candidate.body : undefined)) return false;
          cursor += 1;
          return true;
        };
        const upstream = new LightSprintJobsAdapter(this.options.store, op.selectedAccountId, { timeoutMs: limits.timeoutMs, trustedWorkspacePermit: permit });
        return new LightSprintWorkspacePinnedJobsAdapter(upstream, workspaceId);
      }
      if (op.kind !== "chat_session" || !safeId(op.operationId) || !safeId(op.attemptId) ||
          !Number.isSafeInteger(op.generation) || op.generation < 1 || !safeAccountId(op.selectedAccountId)) return undefined;
      const sessionId = op.sessionId ?? op.input.sessionId;
      const message = op.input.instructions;
      const clientMessageId = op.input.clientMessageId;
      const model = op.input.model;
      const registration = this.config.projects.flatMap((project) => project.registeredSessions)
        .filter((session) => session.accountId === op.selectedAccountId && session.sessionId === sessionId);
      if (registration.length !== 1 || typeof sessionId !== "string" || !SESSION_ID.test(sessionId) ||
          (op.sessionId !== undefined && op.input.sessionId !== undefined && op.sessionId !== op.input.sessionId) ||
          typeof model !== "string" || model !== registration[0].model || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(model) ||
          typeof message !== "string" || message.trim().length === 0 || message.length > 20_000 ||
          typeof clientMessageId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(clientMessageId)) return undefined;
      // Preserve the injected adapter seam for deterministic tests and embedders.
      if (this.options.adapterFactory) return this.options.adapterFactory(op.selectedAccountId, limits);
      const expected = Object.freeze({ path: `/api/agent-sessions/${sessionId}/chat`, message, clientMessageId });
      let unused = true;
      const permit = (request: Readonly<{ method: "POST"; path: string; body: Readonly<{ message: string; clientMessageId: string }> }>): boolean => {
        if (!unused) return false;
        unused = false; // invalidate on the first attempt, before any provider network request
        return request.method === "POST" && request.path === expected.path &&
          request.body.message === expected.message && request.body.clientMessageId === expected.clientMessageId;
      };
      return new LightSprintJobsAdapter(this.options.store, op.selectedAccountId, {
        timeoutMs: limits.timeoutMs, trustedChatMutationPermit: permit,
      });
    };
    const workerBridge: JobBridge = {
      request: async <T = unknown>(method: "POST", route: string, body?: unknown, requestOptions?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T | undefined> => {
        // The current worker emits ISO text for assistantAt; Python persists seconds. Newer
        // workers already emit numeric seconds and pass through unchanged.
        if (route.endsWith("/result") && object(body) && object(body.result)) {
          let result = body.result;
          if (typeof result.assistantAt === "string") {
            const timestamp = Date.parse(result.assistantAt);
            if (Number.isFinite(timestamp)) result = { ...result, assistantAt: timestamp / 1000 };
          }
          // The Python observer contract consumes the provider's terminal session status.
          if (result.status === "assistant_result_ready" && typeof result.assistantText === "string") result = { ...result, status: "idle" };
          body = { ...body, result };
        }
        return this.bridge.request<T>(method, route, body, requestOptions);
      },
    };
      const registeredModels = [...new Set(this.config.projects.flatMap(project => project.registeredSessions.map(session => session.model)))];
      const freshBindingsConfigured = this.config.projects.some((project) => (project.freshProvisioningBindings?.length ?? 0) > 0);
      // Fleet discovery and collaboration work before the first worker is bound.
      // Empty fleets have no dispatch worker; do not invent an allowed model.
      if (registeredModels.length || freshBindingsConfigured) {
      this.worker = createJobWorker({
        bridge: workerBridge,
        beforeClaim: () => this.syncDispatchPolicy(),
        adapterFactory: adapters,
        operationAdapterFactory: operationAdapters,
        isAccountEligible: async (accountId) => {
          const latest = await this.options.store.load();
          const rules=await new ResourceRoutingRulesStore(this.options.store,this.options.configDir).read();
          if(rules.pools?.lightsprint?.enabled===false||rules.resources[accountId]?.enabled===false)return false;
          const signal = accountSignal(latest.accounts.find((row) => row.id === accountId), nativeLightSprintTarget(latest.config.upstreamUrl));
          return signal.enabled && signal.authorized && signal.health === "healthy" && (signal.quota === "available" || signal.quota === "unknown" && this.config.allowUnknownQuota);
        },
        isAccountObservable: async (accountId) => {
          const latest = await this.options.store.load();
          const signal = accountSignal(latest.accounts.find((row) => row.id === accountId), nativeLightSprintTarget(latest.config.upstreamUrl));
          // Observations bypass quota and transient health; disabled accounts and
          // revoked auth (including provider identity mismatch) remain blocked.
          return signal.enabled && signal.authorized;
        },
        workerId: `token2oauth-${createHash("sha256").update(this.options.configDir).digest("hex").slice(0, 12)}`,
        allowedModels: registeredModels, maxConcurrent: Math.min(this.config.maxWorkers, Math.max(1,
          new Set(this.config.projects.flatMap((p) => p.registeredSessions.map((session) => session.sessionId))).size,
          this.config.projects.flatMap((p) => p.freshProvisioningBindings ?? []).length)),
        allowFreshOperations: freshBindingsConfigured, ...this.options.workerOptions,
      });
      this.worker.start();
      }
      await this.registerMonitoredSessions();
      this.started = true;
    } catch (error) {
      await this.bridge.close();
      throw error;
    }
  }

  get status() { return { ...this.bridge.status(), workerStarted: Boolean(this.worker) && this.started && !this.closed }; }

  async guidanceAdmin(input: WorkerGuidanceInput): Promise<WorkerGuidanceResult> {
    if (this.closed || !this.started) return { requestId: input.requestId, state: "rejected", reason: "supervisor_not_running" };
    if (!this.config.projects.some((project) => project.projectId === input.projectId)) return { requestId: input.requestId, state: "rejected", reason: "worker_not_registered" };
    return this.workerGuidance.submit(input);
  }

  async callTool(name: JobToolName, rawArgs: unknown, caller: SupervisorCaller): Promise<unknown> {
    if (this.closed || !this.started) throw new Error("supervisor_not_running");
    // Project folder identity never grants or denies shared workspace resources by itself.
    // Recheck the persisted owner policy and OAuth consent for each operation.
    await this.authorizeWorkspace(caller.projectId, caller.clientId);
    const project = this.config.projects.find((row) => row.projectId === caller.projectId)!;
    const args = validateJobToolArguments(name, rawArgs) as Record<string, any>;
    if (args.projectId !== project.projectId) throw new JobInputError("project is not authorized for this OAuth client");
    const owner = this.owner(caller);
    // A Fleet is explicitly shared by consented OAuth clients. The private
    // bridge still limits a shared read to the same project; task-context
    // projects and clients without Fleet consent retain per-origin ownership.
    const sharedRead = this.config.sharedWorkspace?.projectId === project.projectId && await this.consentedSharedClient(caller.clientId);
    // Retain the caller identity for the private bridge audit trail. The
    // bridge uses sharedProject only to grant a read after it has checked the
    // assignment is in this exact Fleet project.
    const readOwner = sharedRead ? { ...owner, sharedProject: project.projectId } : owner;
    if (name === "job_submit") {
      const requested = args.eligibleAccountIds as string[];
      if (requested.some((id) => !project.accountIds.includes(id))) throw new JobInputError("eligible accounts are outside this project binding");
      const state = await this.options.store.load();
      const nativeTarget = nativeLightSprintTarget(state.config.upstreamUrl);
      const eligible = requested.filter((id) => {
        const signal = accountSignal(state.accounts.find((row) => row.id === id), nativeTarget);
        return signal.enabled && signal.authorized && signal.health === "healthy" && (signal.quota === "available" || signal.quota === "unknown" && this.config.allowUnknownQuota);
      });
      if (!eligible.length) throw new JobInputError("no requested account is currently enabled, authorized, healthy, and quota-eligible");
      const requestedTasks = args.tasks as JobTaskInput[];
      const freshTasks = requestedTasks.filter((task): task is JobTaskInput & { execution: Extract<JobTaskInput["execution"], { mode: "fresh" }> } =>
        task.execution.mode === "fresh");
      let dispatchEligible = eligible;
      // Fresh work is account-pinned per task.  This lets a single durable job
      // fan out across verified account/workspace/stack tuples while preserving
      // ownership at the scheduler and provider boundary.  We deliberately do
      // not infer a model, provider slot limit, or quota from this binding.
      const freshBindingsByTask = new Map<string, FreshProvisioningBinding>();
      if (freshTasks.length) {
        const bindings = project.freshProvisioningBindings ?? [];
        const cursorByProvider = new Map<FreshProvisioningBinding["provider"], number>();
        for (const task of freshTasks) {
          const candidates = bindings.filter((candidate) =>
            eligible.includes(candidate.accountId) && candidate.provider === task.execution.provider);
          if (!candidates.length) throw new JobInputError(`fresh ${task.execution.provider} execution requires an explicitly bound eligible account and stack`);
          const cursor = cursorByProvider.get(task.execution.provider) ?? 0;
          const binding = candidates[cursor % candidates.length]!;
          cursorByProvider.set(task.execution.provider, cursor + 1);
          freshBindingsByTask.set(task.taskId, binding);
        }
        // Keep every eligible account in the assignment.  Each fresh task is
        // individually pinned below; existing-session tasks retain their own
        // session affinity.  The bridge enforces that a worker can only claim
        // the account written into that task's execution binding.
        dispatchEligible = eligible;
      }
      const sessions = project.registeredSessions.filter((session) => dispatchEligible.includes(session.accountId));
      if (requestedTasks.some((task) => task.execution.mode === "existing-session") && !sessions.length) throw new JobInputError("no registered session is configured for the eligible accounts");
      if (!freshTasks.length && !sessions.length) throw new JobInputError("no registered session is configured for the eligible accounts");
      let nextSession = 0;
      const tasks = requestedTasks.map((task) => {
        const output = task.output;
        if (output.kind !== "text") throw new JobInputError("the current supervisor supports bounded text output only");
        if (output.maxBytes > this.config.localLimits.maxOutputBytes) throw new JobInputError("text output exceeds the configured supervisor limit");
        const markerLine = `\n\nInclude this exact completion marker on its own line: ${output.expectedMarker}`;
        if (Buffer.byteLength(task.instructions + markerLine) > 16_384) throw new JobInputError("instructions plus completion marker exceed 16 KiB");
        if (task.execution.mode === "fresh") {
          const binding = freshBindingsByTask.get(task.taskId);
          if (!binding) throw new JobInputError(`fresh ${task.execution.provider} task is missing its verified binding`);
          return { ...task, instructions: task.instructions + markerLine,
            execution: { mode: "fresh", accountId: binding.accountId,
              workspaceId: binding.workspaceId, stackId: binding.stackId, provider: binding.provider },
            stackId: binding.stackId, provider: binding.provider };
        }
        const session = sessions[nextSession++ % sessions.length]!;
        return { ...task, instructions: task.instructions + markerLine,
          execution: { mode: "existing-session", accountId: session.accountId, sessionId: session.sessionId } };
      });
      const assignment = { schemaVersion: 1, assignmentId: args.jobId, idempotencyKey: args.idempotencyKey,
        projectId: project.projectId, eligibleAccountIds: dispatchEligible, maxWorkers: this.config.maxWorkers,
        ...(args.scheduling ? { scheduling: args.scheduling } : {}), tasks };
      if (Buffer.byteLength(JSON.stringify(assignment)) > this.config.localLimits.maxJobBytes) throw new JobInputError("job exceeds the configured supervisor byte limit");
      return boundedJson(await this.bridge.request("POST", "/v1/assignments", assignment, owner));
    }
    if (name === "job_status") {
      if (!safeId(args.jobId)) throw new JobInputError("jobId is invalid");
      const row = parseJson(await this.bridge.request("GET", `/admin/api/v1/assignments/${args.jobId}`, undefined, readOwner));
      if (row.projectId !== project.projectId) throw new JobInputError("job is not available");
      return boundedJson(row);
    }
    if (name === "job_results") {
      if (!safeId(args.jobId)) throw new JobInputError("jobId is invalid");
      // The durable results DTO intentionally omits projectId; verify the owning
      // assignment through the owner-filtered status route before reading results.
      const assignment = parseJson(await this.bridge.request("GET", `/admin/api/v1/assignments/${args.jobId}`, undefined, readOwner));
      if (assignment.projectId !== project.projectId) throw new JobInputError("job is not available");
      const row = parseJson(await this.bridge.request("GET", `/v1/assignments/${args.jobId}/results`, undefined, readOwner));
      if (row.assignmentId !== args.jobId) throw new JobInputError("job is not available");
      const results = Array.isArray(row.results) ? row.results.filter((item: unknown) => object(item) && (!args.taskId || (item.taskId ?? item.task_id) === args.taskId)).map((item: Record<string, unknown>) => ({
        taskId: item.taskId ?? item.task_id, generation: item.generation, text: item.text,
        assistantAt: item.assistantAt ?? item.assistant_at, reportedModel: item.reportedModel ?? item.reported_model,
        createdAt: item.createdAt ?? item.created_at,
      })) : [];
      return boundedJson({ assignmentId: args.jobId, results });
    }
    if (name === "job_workers") {
      const state = await this.options.store.load();
      const nativeTarget = nativeLightSprintTarget(state.config.upstreamUrl);
      const workers = project.registeredSessions.map((session) => {
        const signal = accountSignal(state.accounts.find((row) => row.id === session.accountId), nativeTarget);
        return { sessionId: session.sessionId, accountId: session.accountId, model: session.model, state: "configured",
          eligible: signal.enabled && signal.authorized && signal.health === "healthy" && (signal.quota === "available" || signal.quota === "unknown" && this.config.allowUnknownQuota),
          quota: signal.quota, capacity: "unknown" };
      });
      // Inventory includes connected accounts outside the legacy static dispatch binding.
      // Account visibility never grants dispatch or manufactures worker capacity.
      const accounts = state.accounts.filter((account) => accountSignal(account, nativeTarget).providerOk).map((account) => {
        const signal = accountSignal(account, nativeTarget);
        const sessions = project.registeredSessions.filter((session) => session.accountId === account.id);
        const bound = project.accountIds.includes(account.id);
        const freshBindings = (project.freshProvisioningBindings ?? []).filter((binding) => binding.accountId === account.id);
        const freshBinding = freshBindings[0];
        return { accountId: account.id, label: redactString(typeof account.label === "string" ? account.label : account.id, 120), enabled: signal.enabled,
          dispatchBound: bound, health: signal.health, quota: signal.quota,
          registeredSessionCount: sessions.length, providerSlotLimit: null, availableSlots: null,
          provisioningState: !signal.enabled ? "disabled" : freshBinding ? "fresh_ready" : !bound ? "not_bound" : !sessions.length ? "needs_sessions" : "registered_sessions",
          automaticProvisioning: freshBinding !== undefined,
          ...(freshBinding ? { freshProvisioning: { workspaceId: freshBinding.workspaceId, stackId: freshBinding.stackId, provider: freshBinding.provider },
            freshProvisioningBindings: freshBindings.map(({ workspaceId, stackId, provider }) => ({ workspaceId, stackId, provider })) } : {}) };
      });
      return boundedJson({ projectId: project.projectId, accounts, workers, maxWorkers: this.config.maxWorkers, dispatchEnabled: true });
    }
    if (name === "job_inbox") {
      const after = (args.after ?? "0") as string;
      const limit = (args.limit ?? 50) as number;
      const route = `/v1/inbox?projectId=${encodeURIComponent(project.projectId)}&after=${encodeURIComponent(after)}&limit=${limit}`;
      const raw = parseJson(await this.bridge.request("GET", route, undefined, owner));
      if (raw.projectId !== project.projectId || !Array.isArray(raw.events) || typeof raw.hasMore !== "boolean" ||
          !(raw.cursor === null || typeof raw.cursor === "string" && raw.cursor.length <= 128 && !/[\u0000-\u001f\u007f]/.test(raw.cursor))) {
        throw new JobInputError("inbox response is invalid");
      }
      const events = raw.events.slice(0, limit).map(inboxEvent);
      if (events.some((event) => event === undefined)) throw new JobInputError("inbox event is invalid");
      return boundedJson({ projectId: project.projectId, events, cursor: raw.cursor, hasMore: raw.hasMore });
    }
    if (name === "job_inbox_ack") {
      const eventId = args.eventId as string;
      const raw = parseJson(await this.bridge.request("POST", `/v1/inbox/${eventId}/ack`, { projectId: project.projectId }, owner));
      if (raw.eventId !== eventId || raw.acknowledged !== true) throw new JobInputError("inbox event is unavailable");
      return boundedJson({ projectId: project.projectId, eventId, acknowledged: true });
    }
    if (name === "job_control" && args.action === "reconcile_task") {
      const jobId = String(args.jobId);
      const taskId = String(args.taskId);
      const expectedRevision = Number(args.expectedRevision);
      const row = parseJson(await this.bridge.request("GET", `/admin/api/v1/assignments/${jobId}`, undefined, owner));
      if (row.projectId !== project.projectId) throw new JobInputError("job is not available");
      return boundedJson(await this.bridge.request("POST", `/v1/assignments/${jobId}/reconcile`,
        { taskId, expectedRevision }, owner));
    }
    if (name === "job_control" && args.action === "cancel_job") {
      const jobId = String(args.jobId);
      const row = parseJson(await this.bridge.request("GET", `/admin/api/v1/assignments/${jobId}`, undefined, owner));
      if (row.projectId !== project.projectId || !Number.isInteger(row.revision)) throw new JobInputError("job is not available");
      return boundedJson(await this.bridge.request("POST", `/v1/assignments/${jobId}/cancel`, { expectedRevision: row.revision }, owner));
    }
    if (name === "job_control") {
      const controlRoute = `/admin/api/v1/projects/${encodeURIComponent(project.projectId)}/control`;
      const control = parseJson(await this.bridge.request("GET", controlRoute, undefined, owner));
      if (control.projectId !== project.projectId || !Number.isInteger(control.revision)) throw new JobInputError("project control is unavailable");
      return boundedJson(await this.bridge.request("POST", controlRoute, {
        action: args.action, expectedRevision: control.revision,
      }, owner));
    }
    throw new JobInputError("unsupported job control action");
  }

  async workspaceResources(projectId: string): Promise<unknown> {
    const project = this.config.projects.find(item => item.projectId === projectId);
    if (!project) throw new JobInputError("project is not configured");
    const state = await this.options.store.load();
    let credit: CreditReadiness;
    try { credit = creditReadinessShape(await this.bridge.request("GET", "/admin/api/v1/credit-admission"), new Set(project.accountIds)); }
    catch { credit = { kind: "unavailable" }; }
    const nativeTarget = nativeLightSprintTarget(state.config.upstreamUrl);
    return project.registeredSessions.map((session) => {
      const account = state.accounts.find((row) => row.id === session.accountId);
      const signal = accountSignal(account, nativeTarget);
      let executionAvailability: string;
      if (!account) executionAvailability = "Account not configured";
      else if (!signal.enabled) executionAvailability = "Account disabled";
      else if (!signal.authorized) executionAvailability = "Account authorization unavailable";
      else if (signal.health !== "healthy") executionAvailability = "Account health unavailable";
      else if (signal.quota === "depleted") executionAvailability = "Account quota reported depleted";
      else if (signal.quota === "unknown" && !this.config.allowUnknownQuota) executionAvailability = "Blocked: quota was not reported and policy requires a verified balance";
      else if (credit.kind === "disabled") executionAvailability = "Manual credit gate disabled; live session readiness not checked";
      else if (credit.kind !== "strict") executionAvailability = credit.kind === "unavailable" ? "Credit admission check unavailable; live session readiness not checked" : credit.kind === "malformed" ? "Credit admission data needs correction; live session readiness not checked" : "Legacy credit policy needs confirmation; live session readiness not checked";
      else {
        const policy = credit.accounts.get(session.accountId);
        if (!policy || !policy.boundVerified || policy.available === null || policy.operationUpperBound === null) executionAvailability = "Blocked: no verified credit policy";
        else if (policy.available < policy.operationUpperBound) executionAvailability = "Blocked: available balance below verified operation upper bound";
        else executionAvailability = "Credit check passed; live session readiness not checked";
      }
      return { provider: "lightsprint", sessionId: session.sessionId, workspaceId: session.workspaceId, accountId: session.accountId,
        accountLabel: typeof account?.label === "string" ? account.label : "Account label unavailable", model: session.model,
        modelSource: "registered configuration", executionAvailability };
    });
  }

  /** Catch out-of-band admin edits and revocations without requiring a gateway restart. */
  private async refreshWorkspacePolicy(): Promise<void> {
    if (this.options.configPath) this.config = await readSupervisorRuntimeConfig(this.options.configPath);
  }

  /** Registration alone is insufficient: an unexpired, issued OAuth refresh grant proves consent. */
  private async consentedSharedClient(clientId: string): Promise<boolean> {
    if (!this.config.sharedWorkspace || !safeClientId(clientId)) return false;
    if (this.config.sharedWorkspace.membership === "authenticated_mcp") return true;
    const state = await this.options.store.load();
    if (!Array.isArray(state.oauthClients) || !state.oauthClients.some((client) => client.clientId === clientId)) return false;
    return Array.isArray(state.refreshTokens) && state.refreshTokens.some((grant) =>
      grant.clientId === clientId && typeof grant.expiresAt === "number" && grant.expiresAt > Date.now() &&
      typeof grant.scope === "string" && grant.scope.split(/\s+/).includes("mcp"));
  }

  async authorizeWorkspace(projectId: string, clientId: string): Promise<void> {
    await this.refreshWorkspacePolicy();
    if (!safeId(projectId) || !safeClientId(clientId)) throw new JobInputError("project is not authorized for this OAuth client");
    const project = this.config.projects.find((item) => item.projectId === projectId);
    if (!project) throw new JobInputError("project is not authorized for this OAuth client");
    if (project.clientIds.includes(clientId)) return;
    if (this.config.sharedWorkspace?.projectId === projectId && await this.consentedSharedClient(clientId)) return;
    throw new JobInputError("project is not authorized for this OAuth client");
  }

  async workspaceProjects(clientId: string): Promise<Array<{ projectId: string; label: string; kind: "fleet" | "task_context" }>> {
    await this.refreshWorkspacePolicy();
    if (!safeClientId(clientId)) return [];
    const shared = this.config.sharedWorkspace;
    const consented = shared ? await this.consentedSharedClient(clientId) : false;
    return this.config.projects.filter((project) =>
      project.clientIds.includes(clientId) || (consented && project.projectId === shared?.projectId)).map(({ projectId }) => ({
        projectId,
        label: fleetLabel(projectId),
        kind: isPrimaryFleet(projectId) ? "fleet" : "task_context",
      }));
  }

  private async accessSnapshot(rawConfig?: string, editable = false): Promise<WorkspaceAccessSnapshot> {
    const state = await this.options.store.load();
    const clients = state.oauthClients.filter((client) => safeClientId(client.clientId)).slice(0, 100).map((client) => ({
      clientId: client.clientId,
      label: redactString(typeof client.clientName === "string" ? client.clientName : "Unnamed client", 120) || "Unnamed client",
    }));
    return {
      ...(this.config.sharedWorkspace ? { sharedWorkspace: { ...this.config.sharedWorkspace } } : {}),
      projects: this.config.projects.map((project) => ({ projectId: project.projectId, clientIds: [...project.clientIds] })),
      clients,
      revision: workspaceAccessRevision(rawConfig ?? JSON.stringify(this.config), clients),
      editable,
    };
  }

  async workspaceAccessAdmin(): Promise<WorkspaceAccessSnapshot> {
    const configPath = this.options.configPath;
    if (!configPath) return this.accessSnapshot(undefined, false);
    try {
      const raw = await readFile(configPath, "utf8");
      const parsed = await readSupervisorRuntimeConfig(configPath);
      this.config = parsed;
      return this.accessSnapshot(raw, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return this.accessSnapshot(undefined, false);
      throw new Error("workspace access configuration unavailable");
    }
  }

  async updateWorkspaceAccessAdmin(input: WorkspaceAccessUpdate): Promise<WorkspaceAccessSnapshot> {
    const configPath = this.options.configPath;
    if (!configPath) throw new Error("workspace_access_not_persisted");
    if (!safeId(input.projectId) || !Array.isArray(input.clientIds) || input.clientIds.length > 50 ||
        !input.clientIds.every(safeClientId) || new Set(input.clientIds).size !== input.clientIds.length ||
        typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
      throw new Error("workspace_access_invalid");
    }
    const lockPath = `${configPath}.access.lock`;
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch { throw new Error("workspace_access_conflict"); }
    const tempPath = `${configPath}.access.tmp.${process.pid}.${Date.now()}`;
    const backupPath = `${configPath}.bak`;
    const backupTemp = `${backupPath}.tmp.${process.pid}.${Date.now()}`;
    try {
      const rawText = await readFile(configPath, "utf8");
      const parsed = await readSupervisorRuntimeConfig(configPath);
      const state = await this.options.store.load();
      const clients = state.oauthClients.filter((client) => safeClientId(client.clientId)).slice(0, 100).map((client) => ({
        clientId: client.clientId,
        label: redactString(typeof client.clientName === "string" ? client.clientName : "Unnamed client", 120) || "Unnamed client",
      }));
      if (workspaceAccessRevision(rawText, clients) !== input.expectedRevision) throw new Error("workspace_access_conflict");
      const known = new Set(clients.map((client) => client.clientId));
      if (input.clientIds.some((clientId) => !known.has(clientId))) throw new Error("workspace_access_unknown_client");
      const raw = JSON.parse(rawText) as Record<string, unknown>;
      if (!Array.isArray(raw.projects)) throw new Error("workspace_access_invalid");
      const project = raw.projects.find((row) => object(row) && row.projectId === input.projectId);
      if (!object(project)) throw new Error("workspace_access_unknown_project");
      project.clientIds = [...input.clientIds];
      const nextText = JSON.stringify(raw, null, 2) + "\n";
      await writeFile(tempPath, nextText, { flag: "wx", mode: 0o600 });
      await chmod(tempPath, 0o600);
      const nextConfig = await readSupervisorRuntimeConfig(tempPath);
      await writeFile(backupTemp, rawText, { flag: "wx", mode: 0o600 });
      await chmod(backupTemp, 0o600);
      await rename(backupTemp, backupPath);
      await chmod(backupPath, 0o600);
      await rename(tempPath, configPath);
      await chmod(configPath, 0o600);
      this.config = nextConfig;
      return this.accessSnapshot(nextText, true);
    } catch (error) {
      if (error instanceof Error && ["workspace_access_conflict", "workspace_access_unknown_client", "workspace_access_unknown_project", "workspace_access_invalid"].includes(error.message)) throw error;
      throw new Error("workspace access update unavailable");
    } finally {
      await unlink(tempPath).catch(() => undefined);
      await unlink(backupTemp).catch(() => undefined);
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async readAdmin(projectId: string): Promise<unknown> {
    const project = this.config.projects.find((item) => item.projectId === projectId);
    if (!project) throw new Error("project unavailable");
    const observedAt = new Date().toISOString();
    const state = await this.options.store.load();
    const nativeTarget = nativeLightSprintTarget(state.config.upstreamUrl);
    const summaries = new Map<string, { owner: { ownerPrincipalId: string; clientId: string } }>();
    for (const clientId of project.clientIds) {
      if (summaries.size >= 50) break;
      const owner = this.owner({ clientId, projectId: project.projectId });
      const listing = parseJson(await this.bridge.request("GET", `/admin/api/v1/assignments?projectId=${encodeURIComponent(project.projectId)}&limit=50`, undefined, owner));
      for (const summary of Array.isArray(listing.assignments) ? listing.assignments.filter(object) : []) {
        if (safeId(summary.assignmentId) && !summaries.has(summary.assignmentId)) summaries.set(summary.assignmentId, { owner });
      }
    }
    const assignments = (await Promise.all([...summaries].map(async ([id, context]) => {
      const row = parseJson(await this.bridge.request("GET", `/admin/api/v1/assignments/${id}`, undefined, context.owner));
      return row.projectId === project.projectId ? row : undefined;
    }))).filter((row): row is Record<string, unknown> => !!row);
    const sessionById = new Map(project.registeredSessions.map((session) => [session.sessionId, session]));
    const tasks: SupervisorTask[] = [];
    const jobs: SupervisorJob[] = assignments.map((assignment) => {
      const assignmentId = String(assignment.assignmentId);
      const taskRows = Array.isArray(assignment.tasks) ? assignment.tasks.filter(object) : [];
      const dependencies = [...new Set(taskRows.flatMap((task) => Array.isArray(task.dependsOn) ? task.dependsOn.filter((value): value is string => typeof value === "string") : []))];
      for (const task of taskRows) {
        const taskId = typeof task.taskId === "string" ? task.taskId : "unknown";
        const sessionId = typeof task.sessionId === "string" ? task.sessionId : undefined;
        const session = sessionId ? sessionById.get(sessionId) : undefined;
        const usage = usageProjection(task.usage);
        const generation = Number.isInteger(task.generation) && Number(task.generation) >= 0 ? Number(task.generation) : undefined;
        tasks.push({ id: `${assignmentId}:${taskId}`, label: typeof task.summary === "string" ? redactString(task.summary,160) : "Task summary not provided", status: typeof task.state === "string" ? task.state : "unknown",
          ...(session ? { workspace: session.workspaceId, worker: session.sessionId } : typeof task.workspaceId === "string" ? { workspace: redactString(task.workspaceId, 128) } : {}),
          ...(typeof task.selectedAccountId === "string" ? { accountId: task.selectedAccountId } : {}),
          ...(typeof task.requestedProvider === "string" ? { requestedProvider: redactString(task.requestedProvider, 64) } : {}),
          ...(typeof task.modelReported === "string" ? { reportedModel: redactString(task.modelReported, 64) } : {}),
          ...(typeof task.errorClass === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(task.errorClass) ? { errorClass: task.errorClass } : {}),
          ...(generation !== undefined ? { generation } : {}), ...(usage ? { usage } : {}) });
      }
      const accounts = [...new Set(taskRows.flatMap((task) => typeof task.selectedAccountId === "string" ? [task.selectedAccountId] : []))];
      return { id: assignmentId, label: `Work batch · ${taskRows.length} task${taskRows.length === 1 ? "" : "s"}`, status: typeof assignment.state === "string" ? assignment.state : "unknown",
        provider: "LightSprint", ...(accounts.length ? { account: accounts.join(", ") } : {}), dependencies };
    });
    const accountIds = [...new Set(project.accountIds)];
    const accountUsage = (accountId: string): SupervisorAccountUsage | undefined => {
      const generations = new Map<string, SupervisorTask>();
      for (const task of tasks) if (task.accountId === accountId) generations.set(`${task.id}:${task.generation ?? "unknown"}`, task);
      if (!generations.size) return undefined;
      const rows = [...generations.values()];
      const reported = rows.filter((task) => task.usage?.reportedCostDeltaUsd !== undefined);
      const latest = reported.map((task) => task.usage!).sort((a, b) => Number(b.observedAt ?? 0) - Number(a.observedAt ?? 0))[0];
      return { totalTaskGenerations: rows.length, coveredTaskGenerations: reported.length,
        ...(reported.length ? { reportedCostDeltaUsd: reported.reduce((sum, task) => sum + task.usage!.reportedCostDeltaUsd!, 0) } : {}),
        ...(latest?.observedAt !== undefined ? { observedAt: latest.observedAt } : {}),
        ...(latest?.source ? { source: latest.source } : {}), ...(reported.some((task) => task.usage?.provisional === true) ? { provisional: true } : {}) };
    };
    let supervision: unknown;
    try {
      supervision = await this.guidanceCommand("project-snapshot", { owners: project.clientIds.map((clientId) => `oauth-client:${clientId}`) },
        ["--project", project.projectId, "--after", "0", "--limit", "20", "--pool-config", this.options.oracleConfigPath ?? runtimeStatePath("oracle-pool", "config.json"),
          "--pool-db", this.options.oracleDbPath ?? runtimeStatePath("oracle-pool", "queue.sqlite3")]);
    } catch { supervision = { available: false, workers: [], events: [], models: [], error: "supervision_unavailable" }; }
    const monitorBySession = new Map<string, Record<string, unknown>>();
    if (object(supervision) && Array.isArray(supervision.workers)) for (const row of supervision.workers.filter(object)) {
      if (typeof row.sessionId === "string" && project.registeredSessions.some((session) => session.sessionId === row.sessionId)) monitorBySession.set(row.sessionId, row);
    }
    const workers: SupervisorWorker[] = project.registeredSessions.map((session) => {
      const signal = accountSignal(state.accounts.find((account) => account.id === session.accountId), nativeTarget);
      const eligible = signal.enabled && signal.authorized && signal.health === "healthy" && (signal.quota === "available" || signal.quota === "unknown" && this.config.allowUnknownQuota);
      const account = state.accounts.find((candidate) => candidate.id === session.accountId);
      const observations = tasks.filter((task) => task.worker === session.sessionId).sort((a, b) => Number(b.usage?.observedAt ?? 0) - Number(a.usage?.observedAt ?? 0));
      const currentTask = observations.find((task) => !/complete|failed|cancelled|rejected/i.test(task.status)) ?? observations[0];
      const monitored = monitorBySession.get(session.sessionId);
      const question = normalizeParkedQuestion(monitored?.question);
      const actualModel = currentTask?.reportedModel || (monitored?.modelSource === "observed" && typeof monitored.model === "string" ? monitored.model : undefined);
      return { id: session.sessionId, label: `Worker ${session.sessionId}`, workspace: session.workspaceId,
        status: typeof monitored?.state === "string" ? monitored.state : "unobserved", dispatchStatus: eligible ? "eligible" : "unavailable",
        accountId: session.accountId, accountLabel: typeof account?.label === "string" ? account.label : session.accountId,
        requestedModel: session.model, ...(actualModel ? { actualModel, model: actualModel } : {}),
        ...(Number.isSafeInteger(monitored?.promptCount) ? {promptCount:Number(monitored?.promptCount)} : {}),
        ...(question ? {question} : {}),
        ...(typeof monitored?.heartbeatAt === "number" ? { heartbeatAt: monitored.heartbeatAt } : {}),
        ...(typeof monitored?.lastProgressAt === "number" ? { lastProgressAt: monitored.lastProgressAt } : {}),
        ...(typeof monitored?.state === "string" ? { monitorState: monitored.state } : {}),
        ...(currentTask ? { taskId: currentTask.id, taskCorrelation: currentTask.id, ...(currentTask.usage ? { usage: currentTask.usage } : {}) } : {}) };
    });
    const providers = [{ id: "lightsprint", label: "LightSprint", status: accountIds.some((accountId) => {
      const signal = accountSignal(state.accounts.find((account) => account.id === accountId), nativeTarget);
      return signal.enabled && signal.authorized && signal.health === "healthy";
    }) ? "available" : "unavailable", accounts: accountIds.map((accountId) => {
      const account = state.accounts.find((candidate) => candidate.id === accountId);
      const signal = accountSignal(account, nativeTarget);
      const status = !account || !signal.enabled ? "disabled" : !signal.providerOk ? "unsupported" : !signal.authorized ? "auth_failed" : signal.health;
      const workspaces = project.registeredSessions.filter((session) => session.accountId === accountId).reduce((groups, session) => {
        let group = groups.find((item) => item.id === session.workspaceId);
        if (!group) { group = { id: session.workspaceId, workers: [] as SupervisorWorker[] }; groups.push(group); }
        group.workers.push(workers.find((worker) => worker.id === session.sessionId)!);
        return groups;
      }, [] as Array<{ id: string; workers: SupervisorWorker[] }>);
      const usage = accountUsage(accountId);
      return { id: accountId, label: account?.label || accountId, status, workspaces, ...(usage ? { usage } : {}) };
    }) }];
    const assignmentIds = new Set(assignments.map((assignment) => String(assignment.assignmentId)));
    const eventPage = parseJson(await this.bridge.request("GET", "/admin/api/v1/events?after=0&limit=50"));
    const events: SupervisorEvent[] = (Array.isArray(eventPage.events) ? eventPage.events.filter(object) : [])
      .filter((event) => event.projectId === project.projectId || (typeof event.assignmentId === "string" && assignmentIds.has(event.assignmentId)))
      .map((event) => ({ id: String(event.id ?? ""), at: typeof event.at === "string" || typeof event.at === "number" ? event.at : undefined,
        severity: typeof event.kind === "string" && /error|fail|ambiguous/i.test(event.kind) ? "warning" : "info", source: "supervisor",
        message: typeof event.kind === "string" ? event.kind.slice(0, 120) : "event" }));
    const recoveryOwners = project.clientIds.map((clientId) => `oauth-client:${clientId}`);
    let recovery: unknown;
    try { recovery = await this.recoverySnapshot(project.projectId, recoveryOwners, 0, 20); }
    catch { recovery = { available: false, project: project.projectId, state: "unavailable", cursor: 0, decisions: [], pendingHandoffs: [], notifyReceipts: [], oracleAdvice: [] }; }
    if (object(supervision)) supervision = { ...supervision, recovery };
    if (object(supervision)) supervision = { ...supervision, monitorRegistration: { ...(this.monitorRegistrationByProject.get(project.projectId) ?? { expected: project.clientIds.length * project.registeredSessions.length, registered: 0, failed: 0 }) } };
    const rawCredit = parseJson(await this.bridge.request("GET", "/admin/api/v1/credit-admission"));
    const creditAdmission = { mode: rawCredit.mode === "strict" || rawCredit.mode === "disabled" ? rawCredit.mode : "legacy", accounts: (Array.isArray(rawCredit.accounts) ? rawCredit.accounts.filter(object) : [])
      .filter(account => accountIds.includes(String(account.accountId)))
      .map(account => ({ accountId: account.accountId, unit: typeof account.unit === "string" ? redactString(account.unit, 64) : "unknown",
        available: typeof account.available === "number" && Number.isSafeInteger(account.available) && account.available >= 0 ? account.available : null,
        operationUpperBound: typeof account.operationUpperBound === "number" && Number.isSafeInteger(account.operationUpperBound) && account.operationUpperBound > 0 ? account.operationUpperBound : null,
        boundVerified: account.boundVerified === true })) };
    const rawControl = parseJson(await this.bridge.request("GET", `/admin/api/v1/projects/${encodeURIComponent(project.projectId)}/control`));
    if (rawControl.projectId !== project.projectId || !Number.isSafeInteger(rawControl.revision) || Number(rawControl.revision) < 1 ||
        !Number.isInteger(rawControl.maxConcurrency) || Number(rawControl.maxConcurrency) < 1 || Number(rawControl.maxConcurrency) > 32 ||
        !Number.isSafeInteger(rawControl.activeTaskCount) || Number(rawControl.activeTaskCount) < 0 ||
        typeof rawControl.paused !== "boolean" || typeof rawControl.emergencyStop !== "boolean" ||
        !["running", "paused", "emergency_stopped"].includes(String(rawControl.state))) throw new Error("project controls unavailable");
    const projectControl = { projectId: project.projectId, state: rawControl.state, paused: rawControl.paused,
      emergencyStop: rawControl.emergencyStop, maxConcurrency: rawControl.maxConcurrency,
      activeTaskCount: rawControl.activeTaskCount, revision: rawControl.revision,
      ...(typeof rawControl.updatedAt === "number" && Number.isFinite(rawControl.updatedAt) ? { updatedAt: rawControl.updatedAt } : {}) };
    const snapshot: SupervisorSnapshot = { observedAt, state: "ready", providers, jobs, tasks, workers, events,
      supervisor: { status: this.bridge.status().state, observedAt },
      orchestrator: { status: "unknown", detail: "Originating client heartbeat is not registered.", observedAt },
      supervision, creditAdmission, projectControl } as SupervisorSnapshot & { supervision: unknown; creditAdmission: unknown; projectControl: typeof projectControl };
    return boundedJson(snapshot);
  }
  listProjects(): string[] { return this.config.projects.map(project => project.projectId); }

  async readSupervision(projectId: string, after = 0, limit = 20): Promise<unknown> {
    const project = this.config.projects.find((item) => item.projectId === projectId);
    if (!project || !Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new JobInputError("invalid supervision request");
    let value: unknown;
    try {
      value = await this.guidanceCommand("project-snapshot", { owners: project.clientIds.map((clientId) => `oauth-client:${clientId}`) },
        ["--project", project.projectId, "--after", String(after), "--limit", String(limit), "--pool-config", this.options.oracleConfigPath ?? runtimeStatePath("oracle-pool", "config.json"),
          "--pool-db", this.options.oracleDbPath ?? runtimeStatePath("oracle-pool", "queue.sqlite3")]);
    } catch { value = { available: false, project: project.projectId, workers: [], events: [], models: [], error: "supervision_unavailable" }; }
    const owners = project.clientIds.map((clientId) => `oauth-client:${clientId}`);
    let recovery: unknown;
    try { recovery = await this.recoverySnapshot(project.projectId, owners, after, limit); }
    catch { recovery = { available: false, project: project.projectId, state: "unavailable", cursor: after, decisions: [], pendingHandoffs: [], notifyReceipts: [], oracleAdvice: [] }; }
    if (object(value)) value = { ...value, recovery };
    return boundedJson(object(value) ? { ...value, monitorRegistration: { ...(this.monitorRegistrationByProject.get(project.projectId) ?? { expected: project.clientIds.length * project.registeredSessions.length, registered: 0, failed: 0 }) } } : value);
  }
  async readCompactSummary(projectId: string, after = 0, limit = 20): Promise<unknown> {
    const project = this.config.projects.find((item) => item.projectId === projectId);
    if (!project || !project.clientIds.length || !Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new JobInputError("invalid compact summary request");
    }
    const owners = project.clientIds.map((clientId) => `oauth-client:${clientId}`);
    const value = await this.guidanceCommand("compact-summary", { owners }, [
      "--project", project.projectId, "--after", String(after), "--limit", String(limit),
    ]);
    return boundedJson(value, 512 * 1024);
  }
  async acknowledgeSupervision(projectId: string, eventId: number): Promise<unknown> {
    const project = this.config.projects.find((item) => item.projectId === projectId);
    if (!project || !Number.isSafeInteger(eventId) || eventId < 1) throw new JobInputError("invalid supervision acknowledgment");
    return boundedJson(await this.guidanceCommand("ack-project", { project: project.projectId, eventId,
      owners: project.clientIds.map((clientId) => `oauth-client:${clientId}`) }));
  }
  async controlAdmin(input: { projectId: string; action: "pause_dispatch" | "resume_dispatch" | "emergency_stop" | "set_concurrency"; expectedRevision: number; value?: number }): Promise<unknown> {
    if (!this.config.projects.some((project) => project.projectId === input.projectId)) throw new Error("project unavailable");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new JobInputError("invalid project control revision");
    if (input.action === "set_concurrency" ? !Number.isInteger(input.value) || input.value! < 1 || input.value! > 32 : input.value !== undefined) {
      throw new JobInputError("invalid project control value");
    }
    return boundedJson(await this.bridge.request("POST", `/admin/api/v1/projects/${encodeURIComponent(input.projectId)}/control`, {
      action: input.action, ...(input.value !== undefined ? { value: input.value } : {}), expectedRevision: input.expectedRevision,
    }));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.worker?.stop(); }
    finally {
      await this.bridge.close();
      this.adapterCache.clear();
      this.started = false;
    }
  }
}

export async function createSupervisorRuntime(options: SupervisorRuntimeOptions): Promise<SupervisorRuntime> {
  if (!options.configPath) throw new Error("Supervisor config path is required");
  const config = await readSupervisorRuntimeConfig(options.configPath);
  const runtime = new SupervisorRuntime(config, options);
  await runtime.start();
  return runtime;
}
