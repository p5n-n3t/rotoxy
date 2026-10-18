import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export const CODEX_PROFILE_REGISTRY = "codex-profiles.json";
export const CODEX_APP_SERVER_ARGS = ["app-server", "--stdio"] as const;
export const CODEX_RPC_TIMEOUT_MS = 15_000;
export const CODEX_MAX_IN_FLIGHT = 4;
export const CODEX_MAX_PROFILES = 16;
export const CODEX_MAX_ACTIVE_PROCESSES = 8;
const MAX_FRAME_BYTES = 1024 * 1024;
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

export interface CodexProfile {
  id: string;
  label: string;
  profileDir: string;
  createdAt: number;
  updatedAt: number;
}

export interface CodexRateWindow {
  limitId: string;
  slot: string;
  windowDurationMins?: number;
  usedPercent?: number;
  resetsAt?: number;
  exhausted: boolean;
}

export interface CodexProfileSnapshot {
  profileId: string;
  capturedAt: number;
  authMode?: "chatgpt" | "other";
  planType?: string;
  models: Array<{ id: string; name?: string; reasoningEfforts?: string[] }>;
  rateWindows: CodexRateWindow[];
}

export type DeviceLoginState = "pending" | "complete" | "failed" | "cancelled";
export interface DeviceLoginPrompt {
  verificationUrl: "https://auth.openai.com/codex/device";
  userCode: string;
}

export interface CodexTransport {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): void;
  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  close(): Promise<void>;
}

export interface CodexProfilesOptions {
  /** Trusted absolute path supplied by local configuration; only its fixed app-server args are executed. */
  codexBinary: string;
  configDir: string;
  transportFactory?: (binary: string, profileDir: string) => CodexTransport;
  now?: () => number;
  rpcTimeoutMs?: number;
  maxInFlight?: number;
}

interface ProfileAuditEntry { action: "profile_removed"; profileId: string; at: number }
interface Registry { version: 1; profiles: CodexProfile[]; audit?: ProfileAuditEntry[] }
interface PendingLogin { loginId: string; state: DeviceLoginState }
const MAX_PROFILE_AUDIT = 500;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function safeString(value: unknown, max = 120): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}
function htmlEscape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function privateEnv(profileDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CODEX_HOME: profileDir, HOME: process.env.HOME || homedir() };
  for (const name of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "USER", "LOGNAME", "SystemRoot"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

class StdioCodexTransport implements CodexTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private frameBuffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private nextId = 1;
  private closed = false;

  constructor(binary: string, profileDir: string, private readonly maxInFlight = CODEX_MAX_IN_FLIGHT) {
    this.child = spawn(binary, [...CODEX_APP_SERVER_ARGS], { cwd: profileDir, env: privateEnv(profileDir), shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume();
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.on("error", () => this.failAll("Codex App Server process failed"));
    this.child.on("exit", () => { this.closed = true; this.failAll("Codex App Server exited"); });
  }

  private receive(chunk: Buffer): void {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    let newline: number;
    while ((newline = this.frameBuffer.indexOf(10)) >= 0) {
      if (newline > MAX_FRAME_BYTES) { this.failAll("Codex App Server frame exceeded limit"); void this.close(); return; }
      const line = this.frameBuffer.subarray(0, newline).toString("utf8");
      this.frameBuffer = this.frameBuffer.subarray(newline + 1);
      this.receiveFrame(line);
    }
    if (this.frameBuffer.length > MAX_FRAME_BYTES) { this.failAll("Codex App Server frame exceeded limit"); void this.close(); }
  }

  private receiveFrame(line: string): void {
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { this.failAll("Codex App Server frame exceeded limit"); void this.close(); return; }
    let message: Record<string, unknown>;
    try { const parsed = JSON.parse(line); const obj = record(parsed); if (!obj) return; message = obj; } catch { return; }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      const result = record(message.result);
      if (result) pending.resolve(result);
      else pending.reject(new Error("Codex App Server request failed"));
      return;
    }
    if (typeof message.method === "string") {
      const params = record(message.params) || {};
      for (const listener of this.listeners) listener(message.method, params);
    }
  }

  private failAll(message: string): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = CODEX_RPC_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("Codex App Server is closed"));
    if (this.pending.size >= this.maxInFlight) return Promise.reject(new Error("Codex App Server is at its in-flight limit"));
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => { this.pending.delete(id); rejectRequest(new Error("Codex App Server request timed out")); }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      try { this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`); }
      catch { clearTimeout(timer); this.pending.delete(id); rejectRequest(new Error("Codex App Server write failed")); }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) throw new Error("Codex App Server is closed");
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (!this.closed) { this.closed = true; this.child.kill("SIGTERM"); }
    this.failAll("Codex App Server closed");
    await new Promise<void>((resolveClose) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolveClose();
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); resolveClose(); }, 1000);
      this.child.once("exit", () => { clearTimeout(timer); resolveClose(); });
    });
  }
}

/** Local-only profile registry and official Codex App Server client. No credential file is opened or copied. */
export class CodexProfiles {
  private readonly configDir: string;
  private readonly profileRoot: string;
  private readonly registryPath: string;
  private readonly ownershipPath: string;
  private readonly registryLockPath: string;
  private readonly now: () => number;
  private readonly rpcTimeoutMs: number;
  private readonly maxInFlight: number;
  private readonly transportFactory: (binary: string, profileDir: string) => CodexTransport;
  private binaryPath?: string;
  private registry?: Registry;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly transports = new Map<string, CodexTransport>();
  private readonly opening = new Map<string, Promise<CodexTransport>>();
  private readonly snapshots = new Map<string, CodexProfileSnapshot>();
  private readonly logins = new Map<string, PendingLogin>();
  private readonly threadOwners = new Map<string, string>();
  private readonly profileOperations = new Map<string, number>();
  private readonly removingProfiles = new Set<string>();

  constructor(private readonly options: CodexProfilesOptions) {
    if (!isAbsolute(options.codexBinary) || !["codex", "codex.exe"].includes(basename(options.codexBinary).toLowerCase())) throw new Error("codexBinary must be an absolute path to the trusted Codex binary");
    if (!isAbsolute(options.configDir)) throw new Error("configDir must be absolute");
    this.configDir = resolve(options.configDir);
    this.profileRoot = join(this.configDir, "codex-profiles");
    this.registryPath = join(this.configDir, CODEX_PROFILE_REGISTRY);
    this.ownershipPath = join(this.configDir, "codex-thread-owners.json");
    // Coordinate profile edits with StateStore and other gateway processes.
    this.registryLockPath = join(this.configDir, "state.lock");
    this.now = options.now ?? Date.now;
    this.rpcTimeoutMs = Math.min(30_000, Math.max(1_000, options.rpcTimeoutMs ?? CODEX_RPC_TIMEOUT_MS));
    this.maxInFlight = Math.min(CODEX_MAX_IN_FLIGHT, Math.max(1, options.maxInFlight ?? CODEX_MAX_IN_FLIGHT));
    this.transportFactory = options.transportFactory ?? ((binary, dir) => new StdioCodexTransport(binary, dir, this.maxInFlight));
  }

  private async ready(): Promise<void> {
    if (!this.binaryPath) {
      const resolved = await realpath(this.options.codexBinary);
      const info = await stat(resolved);
      if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o111) === 0)) throw new Error("configured Codex binary is not executable");
      this.binaryPath = resolved;
    }
    if (!this.registry) {
      await mkdir(this.configDir, { recursive: true, mode: 0o700 }); await chmod(this.configDir, 0o700);
      await mkdir(this.profileRoot, { recursive: true, mode: 0o700 }); await chmod(this.profileRoot, 0o700);
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(this.registryPath, "utf8")); }
      catch (error: any) { if (error?.code !== "ENOENT") throw new Error("Codex profile registry is invalid"); }
      const raw = record(parsed);
      const profiles: CodexProfile[] = [];
      if (raw?.version === 1 && Array.isArray(raw.profiles)) {
        for (const item of raw.profiles) {
          const p = record(item); if (!p || typeof p.id !== "string" || !PROFILE_ID.test(p.id) || typeof p.label !== "string" || p.label.length > 80 || typeof p.createdAt !== "number" || typeof p.updatedAt !== "number") continue;
          profiles.push({ id: p.id, label: p.label, profileDir: join(this.profileRoot, p.id), createdAt: p.createdAt, updatedAt: p.updatedAt });
        }
      }
      const audit = Array.isArray(raw?.audit) ? raw.audit.flatMap((entry) => {
        const item = record(entry);
        return item?.action === "profile_removed" && typeof item.profileId === "string" && PROFILE_ID.test(item.profileId) && Number.isSafeInteger(item.at)
          ? [{ action: "profile_removed" as const, profileId: item.profileId, at: item.at as number }] : [];
      }).slice(-MAX_PROFILE_AUDIT) : [];
      this.registry = { version: 1, profiles, audit };
      try { await chmod(this.registryPath, 0o600); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
      for (const profile of profiles) {
        await mkdir(profile.profileDir, { recursive: true, mode: 0o700 });
        await chmod(profile.profileDir, 0o700);
      }
      let owners: unknown;
      try { owners = JSON.parse(await readFile(this.ownershipPath, "utf8")); }
      catch (error: any) { if (error?.code !== "ENOENT") throw new Error("Codex thread ownership registry is invalid"); }
      try { await chmod(this.ownershipPath, 0o600); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
      const saved = record(owners);
      if (saved?.version === 1 && record(saved.owners)) {
        for (const [threadId, profileId] of Object.entries(saved.owners as Record<string, unknown>)) {
          if (/^[A-Za-z0-9_-]{1,160}$/.test(threadId) && typeof profileId === "string" && profiles.some((p) => p.id === profileId)) this.threadOwners.set(threadId, profileId);
        }
      }
    }
  }

  private persist(path: string, contents: () => string): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temp, contents(), { mode: 0o600 }); await rename(temp, path); await chmod(path, 0o600);
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  private save(): Promise<void> { return this.persist(this.registryPath, () => JSON.stringify(this.registry)); }

  private saveOwnership(): Promise<void> { return this.persist(this.ownershipPath, () => JSON.stringify({ version: 1, owners: Object.fromEntries(this.threadOwners) })); }

  private async withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt++) {
      let handle;
      try {
        handle = await open(this.registryLockPath, "wx", 0o600);
        try { return await fn(); }
        finally { await handle.close(); await unlink(this.registryLockPath).catch(() => undefined); }
      } catch (error: any) {
        if (handle) await handle.close().catch(() => undefined);
        if (error?.code !== "EEXIST") throw error;
        try {
          const info = await stat(this.registryLockPath);
          if (Date.now() - info.mtimeMs > 30_000) { await unlink(this.registryLockPath).catch(() => undefined); continue; }
        } catch { /* lock disappeared between calls */ }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 + Math.min(250, attempt * 5)));
      }
    }
    throw new Error("timed out waiting for Codex profile registry lock");
  }

  private async reloadRegistryForWrite(): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.registryPath, "utf8")); }
    catch (error: any) { if (error?.code !== "ENOENT") throw new Error("Codex profile registry is invalid"); }
    const raw = record(parsed);
    if (raw === undefined && parsed !== undefined || raw && (raw.version !== 1 || !Array.isArray(raw.profiles))) throw new Error("Codex profile registry is invalid");
    const profiles: CodexProfile[] = [];
    for (const value of raw?.profiles as unknown[] || []) {
      const item = record(value);
      if (!item || typeof item.id !== "string" || !PROFILE_ID.test(item.id) || typeof item.label !== "string" ||
          item.label.length > 80 || typeof item.createdAt !== "number" || typeof item.updatedAt !== "number") {
        throw new Error("Codex profile registry is invalid");
      }
      profiles.push({ id: item.id, label: item.label, profileDir: join(this.profileRoot, item.id), createdAt: item.createdAt, updatedAt: item.updatedAt });
    }
    if (profiles.length > CODEX_MAX_PROFILES) throw new Error("Codex profile registry is invalid");
    const audit = raw?.audit === undefined ? [] : Array.isArray(raw.audit) ? raw.audit.flatMap((entry) => {
      const item = record(entry);
      if (!item || item.action !== "profile_removed" || typeof item.profileId !== "string" || !PROFILE_ID.test(item.profileId) || !Number.isSafeInteger(item.at)) {
        throw new Error("Codex profile registry audit is invalid");
      }
      return [{ action: "profile_removed" as const, profileId: item.profileId, at: item.at as number }];
    }).slice(-MAX_PROFILE_AUDIT) : (() => { throw new Error("Codex profile registry audit is invalid"); })();
    this.registry = { version: 1, profiles, audit };
  }

  private async reloadOwnershipForWrite(): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.ownershipPath, "utf8")); }
    catch (error: any) { if (error?.code !== "ENOENT") throw new Error("Codex thread ownership registry is invalid"); }
    const raw = record(parsed);
    if (raw === undefined && parsed !== undefined || raw && (raw.version !== 1 || !record(raw.owners))) throw new Error("Codex thread ownership registry is invalid");
    this.threadOwners.clear();
    for (const [threadId, profileId] of Object.entries((raw?.owners || {}) as Record<string, unknown>)) {
      if (/^[A-Za-z0-9_-]{1,160}$/.test(threadId) && typeof profileId === "string" && this.registry!.profiles.some((p) => p.id === profileId)) {
        this.threadOwners.set(threadId, profileId);
      }
    }
  }

  private async mutateProfiles<T>(fn: (profiles: CodexProfile[]) => T | Promise<T>): Promise<T> {
    await this.ready();
    return this.withRegistryLock(async () => {
      await this.reloadRegistryForWrite();
      const result = await fn(this.registry!.profiles);
      await this.save();
      return result;
    });
  }

  async listProfiles(): Promise<CodexProfile[]> {
    await this.ready();
    return this.withRegistryLock(async () => { await this.reloadRegistryForWrite(); return this.registry!.profiles.map((p) => ({ ...p })); });
  }
  async listSnapshots(): Promise<CodexProfileSnapshot[]> { await this.ready(); return [...this.snapshots.values()].map((s) => structuredClone(s)); }

  async registerProfile(label: string): Promise<CodexProfile> {
    const clean = label.trim(); if (!clean || clean.length > 80 || /[\u0000-\u001f\u007f]/.test(clean)) throw new Error("profile label must be 1–80 printable characters");
    return this.mutateProfiles(async (profiles) => {
      if (profiles.length >= CODEX_MAX_PROFILES) throw new Error("Codex profile limit reached");
      const now = this.now(), id = randomUUID(), profileDir = join(this.profileRoot, id);
      await mkdir(profileDir, { recursive: true, mode: 0o700 }); await chmod(profileDir, 0o700);
      const profile = { id, label: clean, profileDir, createdAt: now, updatedAt: now };
      profiles.push(profile); return { ...profile };
    });
  }

  async updateProfile(profileId: string, update: { label?: string }): Promise<CodexProfile> {
    if (!PROFILE_ID.test(profileId) || !update || typeof update !== "object" || Array.isArray(update) ||
        Object.keys(update).length !== 1 || !Object.hasOwn(update, "label")) throw new TypeError("Codex profile update is invalid");
    const label = typeof update.label === "string" ? update.label.trim() : "";
    if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) throw new TypeError("profile label must be 1–80 printable characters");
    return this.mutateProfiles((profiles) => {
      const profile = profiles.find((item) => item.id === profileId);
      if (!profile) throw new Error("Codex profile not found");
      if (profiles.some((item) => item.id !== profileId && item.label.toLocaleLowerCase() === label.toLocaleLowerCase())) throw new Error("Codex profile label already exists");
      profile.label = label; profile.updatedAt = this.now();
      return { ...profile };
    });
  }

  async renameProfile(profileId: string, label: string): Promise<CodexProfile> { return this.updateProfile(profileId, { label }); }

  /** Remove only the registry entry. The isolated CODEX_HOME is deliberately retained for recovery. */
  async removeProfile(profileId: string): Promise<void> {
    if (!PROFILE_ID.test(profileId)) throw new TypeError("Codex profile ID is invalid");
    if (this.removingProfiles.has(profileId)) throw new Error("Codex profile removal is already in progress");
    this.removingProfiles.add(profileId);
    try {
      await this.ready();
      await this.withRegistryLock(async () => {
        await this.reloadRegistryForWrite();
        await this.reloadOwnershipForWrite();
        const index = this.registry!.profiles.findIndex((profile) => profile.id === profileId);
        if (index < 0) throw new Error("Codex profile not found");
        if (this.profileOperations.get(profileId)) throw new Error("Codex profile has an in-flight operation");
        if (this.logins.get(profileId)?.state === "pending") throw new Error("Codex profile has a pending device login");
        if ([...this.threadOwners.values()].includes(profileId)) throw new Error("Codex profile still owns Codex threads");
        const transport = this.transports.get(profileId);
        if (transport) {
          await transport.close();
          this.transports.delete(profileId);
        }
        this.opening.delete(profileId);
        this.snapshots.delete(profileId);
        this.logins.delete(profileId);
        this.registry!.profiles.splice(index, 1);
        this.registry!.audit = [...(this.registry!.audit || []), { action: "profile_removed" as const, profileId, at: this.now() }].slice(-MAX_PROFILE_AUDIT);
        await this.save();
      });
    } finally { this.removingProfiles.delete(profileId); }
  }

  private async withProfileOperation<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    if (this.removingProfiles.has(profileId)) throw new Error("Codex profile is being removed");
    this.profileOperations.set(profileId, (this.profileOperations.get(profileId) || 0) + 1);
    try { return await operation(); }
    finally {
      const remaining = (this.profileOperations.get(profileId) || 1) - 1;
      if (remaining) this.profileOperations.set(profileId, remaining); else this.profileOperations.delete(profileId);
    }
  }

  private profile(id: string): CodexProfile {
    const profile = this.registry?.profiles.find((entry) => entry.id === id);
    if (!profile) throw new Error("Codex profile not found"); return profile;
  }

  private async transport(id: string): Promise<CodexTransport> {
    await this.ready(); this.profile(id);
    const existing = this.transports.get(id); if (existing) return existing;
    const opening = this.opening.get(id); if (opening) return opening;
    if (this.transports.size + this.opening.size >= CODEX_MAX_ACTIVE_PROCESSES) throw new Error("Codex App Server process limit reached");
    const operation = (async () => {
      const profile = this.profile(id); await mkdir(profile.profileDir, { recursive: true, mode: 0o700 }); await chmod(profile.profileDir, 0o700);
      const t = this.transportFactory(this.binaryPath!, profile.profileDir);
      try {
        await t.request("initialize", { clientInfo: { name: "token2oauth", title: "Token2OAuth local Codex profiles", version: "0.2.0" } }, this.rpcTimeoutMs);
        t.notify("initialized", {});
        t.onNotification((method, params) => {
          if (method !== "account/login/completed") return;
          const loginId = safeString(params.loginId, 128); if (!loginId) return;
          const login = this.logins.get(id); if (login?.loginId === loginId) login.state = params.success === true ? "complete" : "failed";
        });
        this.transports.set(id, t); return t;
      } catch { await t.close(); throw new Error("Codex App Server initialization failed"); }
    })();
    this.opening.set(id, operation);
    try { return await operation; } finally { this.opening.delete(id); }
  }

  private request(t: CodexTransport, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return t.request(method, params, this.rpcTimeoutMs);
  }

  async startDeviceLogin(profileId: string): Promise<DeviceLoginPrompt> {
    return this.withProfileOperation(profileId, async () => {
      if (this.logins.get(profileId)?.state === "pending") throw new Error("Codex device login is already pending for this profile");
      const t = await this.transport(profileId);
      let result: Record<string, unknown>;
      try { result = await this.request(t, "account/login/start", { type: "chatgptDeviceCode" }); }
      catch { throw new Error("Codex device login could not be started"); }
      const url = safeString(result.verificationUrl, 256), userCode = safeString(result.userCode, 32), loginId = safeString(result.loginId, 128);
      if (url !== "https://auth.openai.com/codex/device" || !userCode || !/^[A-Z0-9-]{4,16}$/.test(userCode) || !loginId) throw new Error("Codex returned an unsupported device login response");
      this.logins.set(profileId, { loginId, state: "pending" });
      return { verificationUrl: "https://auth.openai.com/codex/device", userCode };
    });
  }

  getDeviceLoginState(profileId: string): DeviceLoginState | "not_started" { return this.logins.get(profileId)?.state ?? "not_started"; }

  async cancelDeviceLogin(profileId: string): Promise<void> {
    return this.withProfileOperation(profileId, async () => {
      const login = this.logins.get(profileId); if (!login || login.state !== "pending") return;
      const t = await this.transport(profileId);
      try { await this.request(t, "account/login/cancel", { loginId: login.loginId }); login.state = "cancelled"; }
      catch { throw new Error("Codex device login could not be cancelled"); }
    });
  }

  async refreshProfile(profileId: string): Promise<CodexProfileSnapshot> {
    return this.withProfileOperation(profileId, async () => {
    const t = await this.transport(profileId);
    let account: Record<string, unknown>, modelsResult: Record<string, unknown>, limitsResult: Record<string, unknown>;
    try {
      account = await this.request(t, "account/read");
      modelsResult = await this.request(t, "model/list", { includeHidden: false });
      limitsResult = await this.request(t, "account/rateLimits/read");
    }
    catch { throw new Error("Codex account, model, or rate-limit information is unavailable"); }
    const accountInfo = record(account.account) || account;
    const rawModels = Array.isArray(modelsResult.data) ? modelsResult.data : [];
    const models = rawModels.flatMap((item) => {
      const m = record(item); const id = safeString(m?.id, 160); if (!m || !id || m.hidden === true) return [];
      const effort = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map(v => typeof v === "string" ? v : record(v)?.reasoningEffort).filter((v): v is string => typeof v === "string" && v.length < 80) : undefined;
      return [{ id, ...(safeString(m.displayName ?? m.name, 160) ? { name: (m.displayName ?? m.name) as string } : {}), ...(effort?.length ? { reasoningEfforts: effort } : {}) }];
    });
    const root = record(limitsResult.rateLimitsByLimitId) || (record(limitsResult.rateLimits) ? { codex: limitsResult.rateLimits } : {});
    const windows: CodexRateWindow[] = [];
    for (const [limitId, raw] of Object.entries(root)) {
      const bucket = record(raw); if (!bucket) continue;
      for (const slot of ["primary", "secondary"]) {
        const w = record(bucket[slot]); if (!w) continue;
        const duration = typeof w.windowDurationMins === "number" && Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins : undefined;
        const used = typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 ? w.usedPercent : undefined;
        const resets = typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt : undefined;
        windows.push({ limitId: safeString(bucket.limitId, 120) || limitId.slice(0, 120), slot, ...(duration ? { windowDurationMins: duration } : {}), ...(used !== undefined ? { usedPercent: used } : {}), ...(resets ? { resetsAt: resets } : {}), exhausted: bucket.rateLimitReachedType != null || used !== undefined && used >= 100 });
      }
    }
    const reportedMode = accountInfo.type ?? accountInfo.authMode;
    const authMode = reportedMode === "chatgpt" ? "chatgpt" : reportedMode == null ? undefined : "other";
    const snapshot: CodexProfileSnapshot = { profileId, capturedAt: this.now(), ...(authMode ? { authMode } : {}), ...(safeString(accountInfo.planType, 40) ? { planType: accountInfo.planType as string } : {}), models, rateWindows: windows };
    this.snapshots.set(profileId, snapshot);
    await this.mutateProfiles((profiles) => {
      const profile = profiles.find((item) => item.id === profileId);
      if (!profile) throw new Error("Codex profile not found");
      profile.updatedAt = snapshot.capturedAt;
    });
    return structuredClone(snapshot);
    });
  }

  /** Ranks candidates by their most-used quota window. This neither reserves capacity nor dispatches a turn. */
  async eligibleProfiles(modelId: string, maxAgeMs = 5 * 60_000): Promise<string[]> {
    await this.ready(); const now = this.now();
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return [];
    return [...this.snapshots.values()]
      .filter((s) => !this.removingProfiles.has(s.profileId) && s.authMode === "chatgpt" && s.capturedAt <= now && now - s.capturedAt <= maxAgeMs && s.models.some((m) => m.id === modelId) && s.rateWindows.length > 0 && s.rateWindows.every((w) => w.usedPercent !== undefined) && !s.rateWindows.some((w) => w.exhausted))
      .sort((a, b) => Math.max(...a.rateWindows.map(w => w.usedPercent!)) - Math.max(...b.rateWindows.map(w => w.usedPercent!)) || (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0))
      .map((s) => s.profileId);
  }

  async bindThread(threadId: string, profileId: string): Promise<void> {
    await this.ready();
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(threadId)) throw new Error("invalid Codex thread ID");
    await this.withRegistryLock(async () => {
      await this.reloadRegistryForWrite(); await this.reloadOwnershipForWrite();
      this.profile(profileId);
      const owner = this.threadOwners.get(threadId); if (owner && owner !== profileId) throw new Error("Codex thread belongs to another profile");
      this.threadOwners.set(threadId, profileId); await this.saveOwnership();
    });
  }

  async profileForThread(threadId: string): Promise<string | undefined> { await this.ready(); return this.threadOwners.get(threadId); }

  async close(): Promise<void> {
    const transports = [...this.transports.values()]; this.transports.clear(); this.snapshots.clear(); this.logins.clear();
    await Promise.allSettled(transports.map((t) => t.close()));
  }
}

export function renderCodexProfilesPage(profiles: CodexProfile[], snapshots: CodexProfileSnapshot[] = [], base = ""): string {
  const action = `${base.replace(/\/$/, "")}/admin/codex/action`;
  const byId = new Map(snapshots.map((s) => [s.profileId, s]));
  const rows = profiles.map((p) => {
    const snapshot = byId.get(p.id);
    const status = !snapshot ? "Not checked" : snapshot.authMode === "chatgpt" ? `ChatGPT sign-in reported · plan ${snapshot.planType ? htmlEscape(snapshot.planType) : "unknown"}` : snapshot.authMode === "other" ? "Other sign-in mode reported" : "Sign-in mode unknown";
    const models = !snapshot ? "Not refreshed" : snapshot.models.map((m) => htmlEscape(m.id)).join(", ") || "No models reported";
    return `<tr><th scope="row">${htmlEscape(p.label)}</th><td>${status}</td><td>${models}</td><td><form method="post" action="${htmlEscape(action)}"><input type="hidden" name="id" value="${htmlEscape(p.id)}"><label>Rename profile<input name="label" value="${htmlEscape(p.label)}" required maxlength="80"></label><button name="action" value="rename">Save name</button> <button class="secondary" name="action" value="remove">Remove profile</button></form></td></tr>`;
  }).join("");
  return `<section class="card"><h2>Local Codex profiles</h2><p>Each profile uses a separate CODEX_HOME. Sign-in status, plan type, models, and quota are shown only when reported by the local Codex App Server and are not a live balance. Removing a profile removes its registry entry and leaves its private CODEX_HOME on disk.</p><table><thead><tr><th>Profile</th><th>Sign-in &amp; reported plan</th><th>Reported models</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No profiles yet. Create a profile below to start sign-in.</td></tr>'}</tbody></table></section>`;
}
