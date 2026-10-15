import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { PROVIDER_PROFILES } from "./provider-capabilities.js";
import { createJobWorker, type JobBridge, type JobWorkerOptions, type PinnedJobsAdapter } from "./job-worker.js";
import { JobInputError, validateJobToolArguments, type JobTaskInput, type JobToolName } from "./job-submit.js";
import { LightSprintJobsAdapter } from "./providers/lightsprint-jobs.js";
import type { StateStore } from "./store.js";
import type { UpstreamAccount } from "./types.js";
import { redactString } from "./telemetry.js";
import { SupervisorBridge, type SupervisorBridgeOptions } from "./supervisor-bridge.js";
import type { SupervisorBackend, SupervisorCaller } from "./supervisor-api.js";
import type { SupervisorAccountUsage, SupervisorEvent, SupervisorJob, SupervisorSnapshot, SupervisorTask, SupervisorUsage, SupervisorWorker } from "./supervisor-ui.js";
import { evaluateToolCall } from "./tool-policy.js";
import { normalizeParkedQuestion } from "./worker-observation.js";
import { WorkerGuidanceLedger, WorkerGuidanceService, type WorkerGuidanceInput, type WorkerGuidanceResult } from "./worker-guidance.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MAX_CONFIG = 64 * 1024;
type RegisteredSession = { sessionId: string; accountId: string; model: string; workspaceId: string };
type ProjectPolicy = { projectId: string; clientIds: string[]; accountIds: string[]; registeredSessions: RegisteredSession[] };
export interface SupervisorRuntimeConfig {
  version: 1;
  projects: ProjectPolicy[];
  maxWorkers: number;
  allowUnknownQuota: true;
  localLimits: { maxTasks: number; maxJobBytes: number; maxOutputBytes: number };
}
export interface SupervisorRuntimeOptions {
  configPath: string;
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
function safeId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
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
  const health = authFailed ? "auth_failed" : account?.stats?.state === "healthy" || account?.stats?.state === "exhausted" ? "healthy" : "degraded";
  // A 429 is a rate-limit observation, not proof that account credits are depleted.
  const quota = account?.stats?.state === "exhausted" || account?.stats?.lastStatus === 402 ? "depleted" : "unknown";
  return { providerOk, enabled, authorized: !!providerOk && !authFailed, health, quota };
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
  assertKeys(raw, ["version", "projects", "maxWorkers", "allowUnknownQuota", "localLimits"], "root");
  if (raw.version !== 1 || raw.allowUnknownQuota !== true || !Number.isInteger(raw.maxWorkers) || Number(raw.maxWorkers) < 1 || Number(raw.maxWorkers) > 8 || !Array.isArray(raw.projects) || !object(raw.localLimits)) throw new Error("Invalid supervisor config");
  assertKeys(raw.localLimits, ["maxTasks", "maxJobBytes", "maxOutputBytes"], "localLimits");
  if (!Number.isInteger(raw.localLimits.maxTasks) || Number(raw.localLimits.maxTasks) < 1 || Number(raw.localLimits.maxTasks) > 100 ||
      !Number.isInteger(raw.localLimits.maxJobBytes) || Number(raw.localLimits.maxJobBytes) < 1024 || Number(raw.localLimits.maxJobBytes) > 1_048_576 ||
      !Number.isInteger(raw.localLimits.maxOutputBytes) || Number(raw.localLimits.maxOutputBytes) < 1 || Number(raw.localLimits.maxOutputBytes) > 32_768) throw new Error("Supervisor limits exceed supported bounds");
  const projects: ProjectPolicy[] = raw.projects.map((candidate: unknown): ProjectPolicy => {
    if (!object(candidate)) throw new Error("Invalid project policy");
    assertKeys(candidate, ["projectId", "clientIds", "accountIds", "registeredSessions"], "project");
    const projectId = candidate.projectId, rawClientIds = candidate.clientIds, rawAccountIds = candidate.accountIds, rawSessions = candidate.registeredSessions;
    if (!safeId(projectId) || !Array.isArray(rawClientIds) || !rawClientIds.length || rawClientIds.length > 50 || !rawClientIds.every(safeId) || new Set(rawClientIds).size !== rawClientIds.length ||
        !Array.isArray(rawAccountIds) || !rawAccountIds.length || rawAccountIds.length > 50 || !rawAccountIds.every(safeId) || new Set(rawAccountIds).size !== rawAccountIds.length || !Array.isArray(rawSessions)) throw new Error("Invalid project bindings");
    const accountIds = rawAccountIds as string[];
    const registeredSessions: RegisteredSession[] = rawSessions.map((item: unknown): RegisteredSession => {
      if (!object(item)) throw new Error("Invalid registered session");
      assertKeys(item, ["sessionId", "accountId", "model", "workspaceId"], "registeredSession");
      if (!safeId(item.sessionId) || !safeId(item.accountId) || !accountIds.includes(item.accountId) || typeof item.model !== "string" || !MODEL_ID.test(item.model) || !safeId(item.workspaceId)) throw new Error("Registered sessions must be bound to an eligible account, workspace, and declared model");
      return { sessionId: item.sessionId, accountId: item.accountId, model: item.model, workspaceId: item.workspaceId };
    });
    if (registeredSessions.length * rawClientIds.length > 1000) throw new Error("Project has too many registered monitoring bindings");
    if (new Set(registeredSessions.map((item) => item.sessionId)).size !== registeredSessions.length) throw new Error("Duplicate registered session");
    return { projectId, clientIds: rawClientIds as string[], accountIds, registeredSessions };
  });
  if (!projects.length || new Set(projects.map((item) => item.projectId)).size !== projects.length) throw new Error("Supervisor config needs unique projects");
  const sessionIds = projects.flatMap((p) => p.registeredSessions.map((s) => s.sessionId));
  if (new Set(sessionIds).size !== sessionIds.length) throw new Error("A registered session may be owned by only one project");
  return { version: 1, projects, maxWorkers: Number(raw.maxWorkers), allowUnknownQuota: true,
    localLimits: { maxTasks: Number(raw.localLimits.maxTasks), maxJobBytes: Number(raw.localLimits.maxJobBytes), maxOutputBytes: Number(raw.localLimits.maxOutputBytes) } };
}

function configuredProject(config: SupervisorRuntimeConfig, caller: SupervisorCaller): ProjectPolicy {
  const project = config.projects.find((item) => item.projectId === caller.projectId && item.clientIds.includes(caller.clientId));
  if (!project) throw new JobInputError("project is not authorized for this OAuth client");
  return project;
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

  constructor(private readonly config: SupervisorRuntimeConfig, private readonly options: SupervisorRuntimeOptions) {
    this.supervisorCwd = options.supervisorCwd ?? resolve(process.cwd(), "supervisor");
    this.supervisionDbPath = options.supervisionDbPath ?? resolve(homedir(), ".local/state/token2oauth/supervision/inbox.sqlite");
    this.recoveryDbPath = options.recoveryDbPath ?? resolve(homedir(), ".local/state/token2oauth/supervision/recovery.sqlite3");
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
        "--oracle-db", this.options.oracleDbPath ?? resolve(homedir(), ".local/state/token2oauth/oracle-pool/queue.sqlite3")];
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

  async start(): Promise<void> {
    if (this.started) return;
    if (this.closed) throw new Error("supervisor_closed");
    const state = await this.options.store.load();
    const sessionsByAccount = new Map<string, RegisteredSession[]>();
    for (const project of this.config.projects) for (const session of project.registeredSessions) {
      sessionsByAccount.set(session.accountId, [...(sessionsByAccount.get(session.accountId) ?? []), session]);
    }
    if ([...sessionsByAccount.values()].some((sessions) => sessions.length > 100)) throw new Error("Supervisor config exceeds 100 sessions per account");
    const supportedTarget = nativeLightSprintTarget(state.config.upstreamUrl);
    await this.bridge.start();
    try {
      for (const accountId of new Set(this.config.projects.flatMap((project) => project.accountIds))) {
        const account = state.accounts.find((row) => row.id === accountId);
        if (!account) throw new Error("Configured supervisor account is unavailable");
        const signal = accountSignal(account, supportedTarget);
        await this.bridge.request("POST", "/v1/accounts", {
          accountId, enabled: signal.enabled, authorized: signal.authorized,
          allowUnknownQuota: this.config.allowUnknownQuota, health: signal.health, quota: signal.quota,
          // One active task per account guarantees its registered session is never reused concurrently.
          localCapacity: 1,
          registeredSessions: (sessionsByAccount.get(accountId) ?? []).map((session) => ({ id: session.sessionId, model: session.model, workspace: session.workspaceId })),
        });
      }
    const adapters = this.options.adapterFactory ?? ((accountId, limits) => {
      let adapter = this.adapterCache.get(accountId);
      if (!adapter) { adapter = new LightSprintJobsAdapter(this.options.store, accountId, { timeoutMs: limits.timeoutMs }); this.adapterCache.set(accountId, adapter); }
      return adapter;
    });
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
      this.worker = createJobWorker({
        bridge: workerBridge,
        adapterFactory: adapters,
        isAccountEligible: async (accountId) => {
          const latest = await this.options.store.load();
          const signal = accountSignal(latest.accounts.find((row) => row.id === accountId), nativeLightSprintTarget(latest.config.upstreamUrl));
          return signal.enabled && signal.authorized && signal.health === "healthy" && (signal.quota === "available" || signal.quota === "unknown" && this.config.allowUnknownQuota);
        },
        workerId: `token2oauth-${createHash("sha256").update(this.options.configDir).digest("hex").slice(0, 12)}`,
        allowedModels: [...new Set(this.config.projects.flatMap((p) => p.registeredSessions.map((session) => session.model)))], maxConcurrent: Math.min(this.config.maxWorkers, Math.max(1, new Set(this.config.projects.flatMap((p) => p.accountIds)).size)),
        allowFreshOperations: false, ...this.options.workerOptions,
      });
      this.worker.start();
      await this.registerMonitoredSessions();
      this.started = true;
    } catch (error) {
      await this.bridge.close();
      throw error;
    }
  }

  get status() { return { ...this.bridge.status(), workerStarted: this.started && !this.closed }; }

  async guidanceAdmin(input: WorkerGuidanceInput): Promise<WorkerGuidanceResult> {
    if (this.closed || !this.started) return { requestId: input.requestId, state: "rejected", reason: "supervisor_not_running" };
    if (!this.config.projects.some((project) => project.projectId === input.projectId)) return { requestId: input.requestId, state: "rejected", reason: "worker_not_registered" };
    return this.workerGuidance.submit(input);
  }

  async callTool(name: JobToolName, rawArgs: unknown, caller: SupervisorCaller): Promise<unknown> {
    if (this.closed || !this.started) throw new Error("supervisor_not_running");
    const project = configuredProject(this.config, caller);
    const args = validateJobToolArguments(name, rawArgs) as Record<string, any>;
    if (args.projectId !== project.projectId) throw new JobInputError("project is not authorized for this OAuth client");
    const owner = this.owner(caller);
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
      const sessions = project.registeredSessions.filter((session) => eligible.includes(session.accountId));
      if (!sessions.length) throw new JobInputError("no registered session is configured for the eligible accounts");
      let nextSession = 0;
      const tasks = (args.tasks as JobTaskInput[]).map((task) => {
        const output = task.output;
        if (output.kind !== "text") throw new JobInputError("the current supervisor supports bounded text output only");
        if (output.maxBytes > this.config.localLimits.maxOutputBytes) throw new JobInputError("text output exceeds the configured supervisor limit");
        const session = sessions[nextSession++ % sessions.length]!;
        const markerLine = `\n\nInclude this exact completion marker on its own line: ${output.expectedMarker}`;
        if (Buffer.byteLength(task.instructions + markerLine) > 16_384) throw new JobInputError("instructions plus completion marker exceed 16 KiB");
        return { ...task, instructions: task.instructions + markerLine,
          execution: { mode: "existing-session", accountId: session.accountId, sessionId: session.sessionId } };
      });
      const assignment = { schemaVersion: 1, assignmentId: args.jobId, idempotencyKey: args.idempotencyKey,
        projectId: project.projectId, eligibleAccountIds: eligible, maxWorkers: this.config.maxWorkers,
        ...(args.scheduling ? { scheduling: args.scheduling } : {}), tasks };
      if (Buffer.byteLength(JSON.stringify(assignment)) > this.config.localLimits.maxJobBytes) throw new JobInputError("job exceeds the configured supervisor byte limit");
      return boundedJson(await this.bridge.request("POST", "/v1/assignments", assignment, owner));
    }
    if (name === "job_status") {
      if (!safeId(args.jobId)) throw new JobInputError("jobId is invalid");
      const row = parseJson(await this.bridge.request("GET", `/admin/api/v1/assignments/${args.jobId}`, undefined, owner));
      if (row.projectId !== project.projectId) throw new JobInputError("job is not available");
      return boundedJson(row);
    }
    if (name === "job_results") {
      if (!safeId(args.jobId)) throw new JobInputError("jobId is invalid");
      // The durable results DTO intentionally omits projectId; verify the owning
      // assignment through the owner-filtered status route before reading results.
      const assignment = parseJson(await this.bridge.request("GET", `/admin/api/v1/assignments/${args.jobId}`, undefined, owner));
      if (assignment.projectId !== project.projectId) throw new JobInputError("job is not available");
      const row = parseJson(await this.bridge.request("GET", `/v1/assignments/${args.jobId}/results`, undefined, owner));
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
      return boundedJson({ projectId: project.projectId, workers, maxWorkers: this.config.maxWorkers, dispatchEnabled: true });
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
    if (name === "job_control" && args.action === "cancel_job") {
      const jobId = String(args.jobId);
      const row = parseJson(await this.bridge.request("GET", `/admin/api/v1/assignments/${jobId}`, undefined, owner));
      if (row.projectId !== project.projectId || !Number.isInteger(row.revision)) throw new JobInputError("job is not available");
      return boundedJson(await this.bridge.request("POST", `/v1/assignments/${jobId}/cancel`, { expectedRevision: row.revision }, owner));
    }
    // R21's event and global control endpoints have no project-scoped read/write contract.
    throw new JobInputError("global supervisor controls are unavailable through project-scoped MCP");
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
        tasks.push({ id: `${assignmentId}:${taskId}`, label: taskId, status: typeof task.state === "string" ? task.state : "unknown",
          ...(session ? { workspace: session.workspaceId, worker: session.sessionId } : {}),
          ...(typeof task.selectedAccountId === "string" ? { accountId: task.selectedAccountId } : {}),
          ...(typeof task.modelReported === "string" ? { reportedModel: redactString(task.modelReported, 64) } : {}),
          ...(generation !== undefined ? { generation } : {}), ...(usage ? { usage } : {}) });
      }
      const accounts = [...new Set(taskRows.flatMap((task) => typeof task.selectedAccountId === "string" ? [task.selectedAccountId] : []))];
      return { id: assignmentId, label: `${taskRows.length} task${taskRows.length === 1 ? "" : "s"}`, status: typeof assignment.state === "string" ? assignment.state : "unknown",
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
        ["--project", project.projectId, "--after", "0", "--limit", "20", "--pool-config", this.options.oracleConfigPath ?? resolve(homedir(), ".local/state/token2oauth/oracle-pool/config.json"),
          "--pool-db", this.options.oracleDbPath ?? resolve(homedir(), ".local/state/token2oauth/oracle-pool/queue.sqlite3")]);
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
    const creditAdmission = { mode: rawCredit.mode === "strict" ? "strict" : "legacy", accounts: (Array.isArray(rawCredit.accounts) ? rawCredit.accounts.filter(object) : [])
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
        ["--project", project.projectId, "--after", String(after), "--limit", String(limit), "--pool-config", this.options.oracleConfigPath ?? resolve(homedir(), ".local/state/token2oauth/oracle-pool/config.json"),
          "--pool-db", this.options.oracleDbPath ?? resolve(homedir(), ".local/state/token2oauth/oracle-pool/queue.sqlite3")]);
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
  const config = await readSupervisorRuntimeConfig(options.configPath);
  const runtime = new SupervisorRuntime(config, options);
  await runtime.start();
  return runtime;
}
