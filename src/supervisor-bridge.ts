import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { request as nodeRequest } from "node:http";
import { createConnection } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const STDERR_DIAGNOSTIC_LIMIT = 4096;
const SOCKET_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export type SupervisorBridgeState = "stopped" | "starting" | "running" | "failed" | "closing";
export type BridgeMethod = "GET" | "POST";

export interface SupervisorBridgeStatus {
  state: SupervisorBridgeState;
  childRunning: boolean;
  failureCode?: string;
  diagnostics: {
    stderrBytesSeen: number;
    stderrLimit: number;
    stderrTruncated: boolean;
    stderrContent: "redacted";
  };
}

export interface SupervisorBridgeHttpRequest {
  socketPath: string;
  method: BridgeMethod;
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
  signal: AbortSignal;
  maxResponseBytes: number;
}

export interface SupervisorBridgeHttpResponse {
  statusCode: number;
  body: Buffer;
}

export type SupervisorBridgeHttpClient = (
  request: SupervisorBridgeHttpRequest,
) => Promise<SupervisorBridgeHttpResponse>;

export interface SupervisorBridgeOptions {
  /** Must be explicitly true at the call site before the child can be started. */
  enabled: boolean;
  configDir: string;
  supervisorCwd: string;
  pythonExecutable?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  spawnChild?: typeof nodeSpawn;
  httpClient?: SupervisorBridgeHttpClient;
}

export class SupervisorBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message = "Supervisor bridge operation failed") {
    super(message);
    this.name = "SupervisorBridgeError";
    this.code = code;
  }
}

interface SocketIdentity {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function validateLimit(value: number, max: number, code: string): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new SupervisorBridgeError(code);
  }
  return value;
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

/** Only the private supervisor contract is reachable through this client. */
export function isAllowedSupervisorRoute(method: string, route: string): boolean {
  if ((method !== "GET" && method !== "POST") || !route.startsWith("/") || route.startsWith("//")) return false;
  if (route.includes("\\") || route.includes("#") || /%(?:2f|5c)/i.test(route)) return false;

  const queryIndex = route.indexOf("?");
  const rawPath = queryIndex < 0 ? route : route.slice(0, queryIndex);
  if (rawPath.split("/").some((part) => {
    try {
      const decoded = decodeURIComponent(part);
      return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
    } catch {
      return true;
    }
  })) return false;

  let parsed: URL;
  try {
    parsed = new URL(route, "http://supervisor.invalid");
  } catch {
    return false;
  }
  if (parsed.origin !== "http://supervisor.invalid" || parsed.hash || parsed.username || parsed.password) return false;
  const path = parsed.pathname;
  let allowedQuery: string[] = [];

  if (path === "/admin/api/v1/credit-admission" && method === "GET") return parsed.search === "";
  if (path === "/admin/api/v1/assignments" && method === "POST") return parsed.search === "";
  // MCP job submissions are already authorized by Token2OAuth before reaching
  // this private, bearer-authenticated Unix-socket boundary.
  if (path === "/v1/assignments" && method === "POST") return parsed.search === "";
  if (path === "/v1/accounts" && method === "POST") return parsed.search === "";
  if (path === "/admin/api/v1/assignments" && method === "GET") {
    allowedQuery = ["projectId", "offset", "limit"];
  } else if (path === "/admin/api/v1/events" && method === "GET") {
    allowedQuery = ["after", "limit"];
  } else if (path === "/v1/inbox" && method === "GET") {
    allowedQuery = ["projectId", "after", "limit"];
  } else if (path === "/admin/api/v1/control" && method === "POST") {
    return parsed.search === "";
  } else if (path === "/v1/operations/claim" && method === "POST") {
    return parsed.search === "";
  } else {
    const approval = path.match(/^\/admin\/api\/v1\/assignments\/([A-Za-z0-9._:-]{1,128})\/approve$/);
    const assignment = path.match(/^\/admin\/api\/v1\/assignments\/([A-Za-z0-9._:-]{1,128})$/);
    const result = path.match(/^\/v1\/operations\/([A-Za-z0-9._:-]{1,128})\/result$/);
    const ownedResult = path.match(/^\/v1\/assignments\/([A-Za-z0-9._:-]{1,128})\/results$/);
    const cancel = path.match(/^\/v1\/assignments\/([A-Za-z0-9._:-]{1,128})\/cancel$/);
    const inboxAck = path.match(/^\/v1\/inbox\/((?:repo|job):[1-9][0-9]{0,18})\/ack$/);
    if (approval && isSafeId(approval[1]) && method === "POST") return parsed.search === "";
    if (assignment && isSafeId(assignment[1]) && method === "GET") return parsed.search === "";
    if (result && isSafeId(result[1]) && method === "POST") return parsed.search === "";
    if (ownedResult && isSafeId(ownedResult[1]) && method === "GET") return parsed.search === "";
    if (cancel && isSafeId(cancel[1]) && method === "POST") return parsed.search === "";
    if (inboxAck && method === "POST") return parsed.search === "";
    return false;
  }

  const seen = new Set<string>();
  for (const [key, value] of parsed.searchParams) {
    if (!allowedQuery.includes(key) || seen.has(key)) return false;
    seen.add(key);
    if (key === "projectId" && !isSafeId(value)) return false;
    if (key === "offset" && (!/^\d{1,9}$/.test(value) || Number(value) > 1_000_000)) return false;
    const maxLimit = path.endsWith("/events") ? 200 : path === "/v1/inbox" ? 100 : 50;
    if (key === "limit" && (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > maxLimit)) return false;
    if (key === "after" && path === "/admin/api/v1/events" && !/^\d{1,16}$/.test(value)) return false;
    if (key === "after" && path === "/v1/inbox" && (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value))) return false;
    if (path === "/v1/inbox" && key === "limit" && Number(value) > 100) return false;
  }
  return true;
}

const defaultHttpClient: SupervisorBridgeHttpClient = (input) => new Promise((resolvePromise, rejectPromise) => {
  const request = nodeRequest({
    socketPath: input.socketPath,
    // The private Python bridge closes every response connection. Do not reuse
    // a socket whose peer may be closing while another operation is dispatched.
    agent: false,
    method: input.method,
    path: input.path,
    headers: input.headers,
    signal: input.signal,
  }, (response) => {
    // Authentication failure is terminal even when an untrusted peer sends an
    // oversized body. There is no useful response payload to retain here.
    if (response.statusCode === 401) {
      response.resume();
      resolvePromise({ statusCode: 401, body: Buffer.alloc(0) });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > input.maxResponseBytes) {
        request.destroy(new SupervisorBridgeError("response_too_large"));
        return;
      }
      chunks.push(bytes);
    });
    response.on("end", () => resolvePromise({
      statusCode: response.statusCode ?? 0,
      body: Buffer.concat(chunks, size),
    }));
    response.on("error", () => rejectPromise(new SupervisorBridgeError("transport_error")));
  });
  request.on("error", (error: unknown) => {
    if (error instanceof SupervisorBridgeError) rejectPromise(error);
    else if (input.signal.aborted) rejectPromise(input.signal.reason instanceof Error
      ? input.signal.reason
      : new SupervisorBridgeError("request_cancelled"));
    else {
      const code = (error as NodeJS.ErrnoException)?.code;
      const failure = new SupervisorBridgeError("transport_error");
      if (typeof code === "string" && /^E[A-Z0-9_]{1,39}$/.test(code)) Object.assign(failure, { transportCode: code });
      rejectPromise(failure);
    }
  });
  if (input.body) request.write(input.body);
  request.end();
});

export class SupervisorBridge {
  readonly socketPath: string;
  readonly stateDir: string;
  readonly #configDir: string;
  readonly #supervisorCwd: string;
  readonly #pythonExecutable: string;
  readonly #enabled: boolean;
  readonly #startupTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #spawnChild: typeof nodeSpawn;
  readonly #httpClient: SupervisorBridgeHttpClient;

  #state: SupervisorBridgeState = "stopped";
  #child?: ChildProcess;
  #bearer?: string;
  #socketIdentity?: SocketIdentity;
  #childExited = false;
  #intentionalExit = false;
  #failureCode?: string;
  #stderrBytesSeen = 0;

  constructor(options: SupervisorBridgeOptions) {
    if (!options.configDir || !options.supervisorCwd) throw new SupervisorBridgeError("invalid_paths");
    this.#configDir = resolve(options.configDir);
    this.stateDir = resolve(options.configDir, "supervisor-state");
    const stateRelative = relative(this.#configDir, this.stateDir);
    if (!stateRelative || stateRelative === ".." || stateRelative.startsWith(`..${sep}`) || isAbsolute(stateRelative)) {
      throw new SupervisorBridgeError("unsafe_state_path");
    }
    this.socketPath = join(this.#configDir, "supervisor.sock");
    this.#supervisorCwd = resolve(options.supervisorCwd);
    this.#pythonExecutable = options.pythonExecutable ?? "python3";
    this.#enabled = options.enabled;
    this.#startupTimeoutMs = validateLimit(options.startupTimeoutMs ?? 5_000, 30_000, "invalid_startup_timeout");
    this.#requestTimeoutMs = validateLimit(options.requestTimeoutMs ?? 15_000, MAX_TIMEOUT_MS, "invalid_request_timeout");
    this.#maxRequestBytes = validateLimit(options.maxRequestBytes ?? MAX_REQUEST_BYTES, MAX_REQUEST_BYTES, "invalid_request_limit");
    this.#maxResponseBytes = validateLimit(options.maxResponseBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, "invalid_response_limit");
    this.#spawnChild = options.spawnChild ?? nodeSpawn;
    this.#httpClient = options.httpClient ?? defaultHttpClient;
  }

  status(): SupervisorBridgeStatus {
    const childRunning = !!this.#child && !this.#childExited && this.#child.exitCode === null && this.#child.signalCode === null;
    return {
      state: this.#state,
      childRunning,
      ...(this.#failureCode ? { failureCode: this.#failureCode } : {}),
      diagnostics: {
        stderrBytesSeen: this.#stderrBytesSeen,
        stderrLimit: STDERR_DIAGNOSTIC_LIMIT,
        stderrTruncated: this.#stderrBytesSeen > STDERR_DIAGNOSTIC_LIMIT,
        stderrContent: "redacted",
      },
    };
  }

  async start(): Promise<void> {
    if (!this.#enabled) throw new SupervisorBridgeError("disabled");
    if (this.#state === "running") return;
    if (this.#state !== "stopped") throw new SupervisorBridgeError("invalid_state");
    this.#state = "starting";
    this.#failureCode = undefined;
    this.#childExited = false;
    this.#intentionalExit = false;
    this.#socketIdentity = undefined;

    try {
      await this.#assertPrivateConfigDir();
      await this.#prepareStateDir();
      await this.#assertSocketAbsent();

      const bearer = randomBytes(32).toString("base64url");
      this.#bearer = bearer;
      const child = this.#spawnChild(this.#pythonExecutable, [
        "-m", "snooze.bridge", "--socket", this.socketPath,
        "--state-dir", this.stateDir, "--auth-fd", "3",
      ], {
        cwd: this.#supervisorCwd,
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          PYTHONUNBUFFERED: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        },
        stdio: ["ignore", "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.#child = child;
      child.stderr?.on("data", (chunk: Buffer | string) => {
        this.#stderrBytesSeen = Math.min(Number.MAX_SAFE_INTEGER,
          this.#stderrBytesSeen + Buffer.byteLength(chunk));
      });
      child.once("error", () => {
        if (!this.#intentionalExit) void this.#handleUnexpectedExit("child_spawn_error");
      });
      child.once("exit", () => {
        this.#childExited = true;
        if (!this.#intentionalExit) void this.#handleUnexpectedExit("child_exited");
      });

      const authPipe = child.stdio?.[3] as Writable | null | undefined;
      if (!authPipe) throw new SupervisorBridgeError("auth_channel_unavailable");
      await new Promise<void>((resolvePromise, rejectPromise) => {
        authPipe.once("error", () => rejectPromise(new SupervisorBridgeError("auth_channel_failed")));
        authPipe.end(`${bearer}\n`, () => resolvePromise());
      });
      await this.#waitForSocket();
      if (this.#childExited || this.status().state === "failed") throw new SupervisorBridgeError("child_not_ready");
      this.#state = "running";
    } catch (error) {
      const code = error instanceof SupervisorBridgeError ? error.code : "startup_failed";
      this.#failureCode = code;
      this.#state = "failed";
      this.#bearer = undefined;
      await this.#stopChildAndRemoveOwnedSocket();
      throw new SupervisorBridgeError(code);
    }
  }

  async request<T = unknown>(
    method: BridgeMethod,
    route: string,
    body?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal; ownerPrincipalId?: string; clientId?: string } = {},
  ): Promise<T | undefined> {
    if (this.#state !== "running" || !this.#bearer || !this.#child || this.#childExited) {
      throw new SupervisorBridgeError("not_running");
    }
    if (!isAllowedSupervisorRoute(method, route)) throw new SupervisorBridgeError("route_not_allowed");
    const timeoutMs = validateLimit(options.timeoutMs ?? this.#requestTimeoutMs, MAX_TIMEOUT_MS, "invalid_request_timeout");
    if ((options.ownerPrincipalId === undefined) !== (options.clientId === undefined) ||
        (options.ownerPrincipalId !== undefined && !isSafeId(options.ownerPrincipalId)) ||
        (options.clientId !== undefined && !isSafeId(options.clientId))) {
      throw new SupervisorBridgeError("invalid_owner_context");
    }
    if (options.signal?.aborted) throw new SupervisorBridgeError("request_cancelled");

    let requestBody: Buffer | undefined;
    if (body !== undefined) {
      let serialized: string;
      try { serialized = JSON.stringify(body); }
      catch { throw new SupervisorBridgeError("invalid_request_body"); }
      if (typeof serialized !== "string") throw new SupervisorBridgeError("invalid_request_body");
      requestBody = Buffer.from(serialized, "utf8");
      if (requestBody.length > this.#maxRequestBytes) throw new SupervisorBridgeError("request_too_large");
    }

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let rejectTimeout!: (error: Error) => void;
    let rejectCancelled!: (error: Error) => void;
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const onAbort = () => {
      controller.abort();
      rejectCancelled(new SupervisorBridgeError("request_cancelled"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      rejectTimeout(new SupervisorBridgeError("request_timeout"));
    }, timeoutMs);

    try {
      const response = await Promise.race([
        this.#httpClient({
          socketPath: this.socketPath,
          method,
          path: route,
          headers: {
            authorization: `Bearer ${this.#bearer}`,
            accept: "application/json",
            ...(options.ownerPrincipalId && options.clientId ? {
              "x-owner-principal": options.ownerPrincipalId,
              "x-client-id": options.clientId,
            } : {}),
            ...(requestBody ? { "content-type": "application/json", "content-length": String(requestBody.length) } : {}),
          },
          ...(requestBody ? { body: requestBody } : {}),
          signal: controller.signal,
          maxResponseBytes: this.#maxResponseBytes,
        }),
        timeout,
        cancelled,
      ]);
      if (response.body.length > this.#maxResponseBytes) throw new SupervisorBridgeError("response_too_large");
      if (response.statusCode === 401) {
        await this.#failClosed("authentication_failed");
        throw new SupervisorBridgeError("authentication_failed");
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new SupervisorBridgeError(`http_${response.statusCode}`);
      }
      if (response.statusCode === 204 || response.body.length === 0) return undefined;
      try { return JSON.parse(response.body.toString("utf8")) as T; }
      catch { throw new SupervisorBridgeError("invalid_response"); }
    } catch (error) {
      if (error instanceof SupervisorBridgeError) throw error;
      if (controller.signal.aborted) throw new SupervisorBridgeError(options.signal?.aborted ? "request_cancelled" : "request_timeout");
      throw new SupervisorBridgeError("transport_error");
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async close(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "closing";
    this.#intentionalExit = true;
    this.#bearer = undefined;
    await this.#stopChildAndRemoveOwnedSocket();
    this.#child = undefined;
    this.#state = "stopped";
    this.#failureCode = undefined;
  }

  async #assertPrivateConfigDir(): Promise<void> {
    const info = await lstat(this.#configDir).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new SupervisorBridgeError("unsafe_config_dir");
    const uid = currentUid();
    if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
      throw new SupervisorBridgeError("unsafe_config_dir_permissions");
    }
    const canonical = await realpath(this.#configDir);
    if (canonical !== this.#configDir) throw new SupervisorBridgeError("unsafe_config_dir");
  }

  async #prepareStateDir(): Promise<void> {
    try { await mkdir(this.stateDir, { mode: PRIVATE_DIR_MODE }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new SupervisorBridgeError("state_dir_create_failed"); }
    const info = await lstat(this.stateDir).catch(() => undefined);
    const uid = currentUid();
    if (!info || info.isSymbolicLink() || !info.isDirectory()
      || (uid !== undefined && info.uid !== uid) || (info.mode & 0o777) !== PRIVATE_DIR_MODE) {
      throw new SupervisorBridgeError("unsafe_state_dir");
    }
  }

  async #assertSocketAbsent(): Promise<void> {
    try {
      await lstat(this.socketPath);
      throw new SupervisorBridgeError("socket_path_exists");
    } catch (error) {
      if (error instanceof SupervisorBridgeError) throw error;
      if (!isMissing(error)) throw new SupervisorBridgeError("socket_path_unavailable");
    }
  }

  async #waitForSocket(): Promise<void> {
    const deadline = Date.now() + this.#startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.#childExited || !this.#child || this.#child.exitCode !== null || this.#child.signalCode !== null) {
        throw new SupervisorBridgeError("child_not_ready");
      }
      try {
        const info = await lstat(this.socketPath);
        if (info.isSymbolicLink() || !info.isSocket()) throw new SupervisorBridgeError("unsafe_socket");
        const uid = currentUid();
        if (uid !== undefined && info.uid !== uid) {
          throw new SupervisorBridgeError("unsafe_socket_permissions");
        }
        if ((info.mode & 0o777) !== SOCKET_MODE) throw new SupervisorBridgeError("unsafe_socket_permissions");
        this.#socketIdentity = { dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode & 0o777 };
        // bind() exposes the inode before listen() makes it usable. Probe only
        // the connection here; never retry a mutating HTTP operation for readiness.
        const listening = await new Promise<boolean>((resolveReady) => {
          const socket = createConnection({ path: this.socketPath });
          const finish = (ready: boolean) => { socket.destroy(); resolveReady(ready); };
          socket.setTimeout(Math.max(1, Math.min(200, deadline - Date.now())), () => finish(false));
          socket.once("connect", () => finish(true));
          socket.once("error", () => finish(false));
        });
        if (listening) return;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await delay(20);
    }
    throw new SupervisorBridgeError("startup_timeout");
  }

  async #handleUnexpectedExit(code: string): Promise<void> {
    if (this.#intentionalExit) return;
    this.#state = "failed";
    this.#failureCode = code;
    this.#bearer = undefined;
    if (this.#child && (this.#child.exitCode !== null || this.#child.signalCode !== null)) {
      await this.#removeOwnedSocket();
    }
  }

  async #failClosed(code: string): Promise<void> {
    this.#state = "failed";
    this.#failureCode = code;
    this.#bearer = undefined;
    await this.#stopChildAndRemoveOwnedSocket();
    this.#state = "failed";
    this.#failureCode = code;
  }

  async #stopChildAndRemoveOwnedSocket(): Promise<void> {
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      let exited = await this.#waitForChildExit(child, 500);
      if (!exited) {
        child.kill("SIGKILL");
        exited = await this.#waitForChildExit(child, 1_000);
      }
      if (!exited) throw new SupervisorBridgeError("child_shutdown_timeout");
      this.#childExited = true;
    }
    await this.#removeOwnedSocket();
  }

  async #waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null || this.#childExited) return true;
    return new Promise((resolvePromise) => {
      let done = false;
      const finish = (exited: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        child.removeListener("close", onExit);
        resolvePromise(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      child.once("close", onExit);
    });
  }

  async #removeOwnedSocket(): Promise<void> {
    const identity = this.#socketIdentity;
    if (!identity) return;
    try {
      const info = await lstat(this.socketPath);
      if (!info.isSocket() || info.isSymbolicLink()
        || info.dev !== identity.dev || info.ino !== identity.ino || info.uid !== identity.uid
        || (info.mode & 0o777) !== identity.mode) return;
      await unlink(this.socketPath);
    } catch (error) {
      if (!isMissing(error)) throw new SupervisorBridgeError("socket_cleanup_failed");
    } finally {
      this.#socketIdentity = undefined;
    }
  }
}
