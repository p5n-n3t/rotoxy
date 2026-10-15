import { OracleTools, OracleToolError, ORACLE_TOOL_DEFINITIONS, isOracleToolName, oracleToolRequiredScope } from "./oracle-tools.js";
import { Readable, Transform, pipeline } from "node:stream";
import type { Request, Response } from "express";
import type { AccessClaims, GatewayConfig, UpstreamAccount } from "./types.js";
import { CredentialPool } from "./pool.js";
import { StateStore } from "./store.js";
import { isReplaySafeRequest, mergeIncomingQuery, taskIdFromResponse } from "./routing-safety.js";
import {
  compileToolPolicy,
  filterServerMessage,
  gateClientMessage,
  POLICY_ERROR_CODE,
  type CompiledToolPolicy,
  type JsonRpcMessage,
} from "./tool-policy.js";
import { parseClientPayload, readBodyLimited, rewriteServerBody, serverMessages, type ParsedClientPayload } from "./jsonrpc-wire.js";
import type { TelemetryRecorder } from "./telemetry.js";
import { JOB_TOOL_DEFINITIONS, isJobToolName, requiredJobScope, type JobToolName } from "./job-submit.js";
import { JobInputError } from "./job-submit.js";
import { SupervisorApi, SupervisorUnavailable } from "./supervisor-api.js";
import { WebToolError } from "./web-tools.js";
import type { ConfiguredWebTools } from "./web-tools-config.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "authorization",
  "cookie",
  "content-length",
]);

/** Largest response buffered to filter a tools/list result. */
const MAX_FILTERED_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Largest prefix of a streamed response scanned for task handles. */
const MAX_OBSERVED_BYTES = 1024 * 1024;

/** Connection errors where the request provably never reached the upstream. */
const UNSENT_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

function copyRequestHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const item of raw) headers.append(key, item);
    } else {
      headers.set(key, String(raw));
    }
  }
  return headers;
}

function copyResponseHeaders(source: Headers, res: Response, omit: string[] = []): void {
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    // fetch() already decoded the body, so a forwarded content-encoding (and
    // the matching length) would describe bytes the client never receives.
    if (HOP_BY_HOP.has(lower) || lower === "set-cookie" || lower === "content-encoding" || omit.includes(lower)) return;
    res.setHeader(key, value);
  });
}

async function responseTextCapped(response: globalThis.Response, max = 1024 * 1024): Promise<string> {
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > max) return buf.subarray(0, max).toString("utf8") + "\n[truncated]";
  return buf.toString("utf8");
}

function requestBody(req: Request): Buffer | undefined {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  if (Buffer.isBuffer(req.body)) return req.body.length ? req.body : undefined;
  if (req.body === undefined) return undefined;
  return Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body));
}

/** Methods that are safe to re-send to another credential after an ambiguous failure. */
function replaySafe(req: Request, rpc: ParsedClientPayload | undefined, readOnlyTools: string[]): boolean {
  if (!rpc) return isReplaySafeRequest({ httpMethod: req.method });
  return rpc.messages.every((message) => {
    // Responses to server requests and notifications carry no tool side effect.
    if (typeof message.method !== "string") return true;
    if (message.method === "initialize" || message.method.startsWith("notifications/")) return true;
    return isReplaySafeRequest({ rpcMethod: message.method, params: message.params }, readOnlyTools);
  });
}

function describeRequest(req: Request, rpc: ParsedClientPayload | undefined): { method: string; tool?: string } {
  const first = rpc?.messages.find((m) => typeof m.method === "string");
  if (!first) return { method: req.method };
  const tool = first.method === "tools/call" && typeof first.params?.name === "string" ? first.params.name : undefined;
  return { method: rpc!.batch ? "batch:" + first.method : String(first.method), tool };
}

function rpcError(id: JsonRpcMessage["id"], code: number, message: string, data?: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } };
}

interface ProtocolErrorObservation {
  isError: boolean;
  recognizedStatus?: number;
}

/** Only statuses explicitly identified inside a JSON-RPC/MCP error are actionable. */
function protocolErrorObservation(messages: JsonRpcMessage[], config: GatewayConfig): ProtocolErrorObservation {
  let isError = false;
  let recognizedStatus: number | undefined;
  const acceptedStatuses = new Set([...config.authFailureStatuses, ...config.quotaStatuses]);
  for (const message of messages) {
    if (!message || message.jsonrpc !== "2.0") continue;
    const texts: string[] = [];
    if (message.error && typeof message.error === "object") {
      isError = true;
      if (typeof message.error.message === "string") texts.push(message.error.message);
    }
    const result = message.result as { isError?: unknown; content?: unknown } | undefined;
    if (result?.isError === true) {
      isError = true;
      if (Array.isArray(result.content)) {
        for (const item of result.content) {
          if (
            item &&
            typeof item === "object" &&
            (item as { type?: unknown }).type === "text" &&
            typeof (item as { text?: unknown }).text === "string"
          ) {
            texts.push((item as { text: string }).text);
          }
        }
      }
    }
    for (const text of texts) {
      const match = /\bHTTP\s+(\d{3})\s*:/i.exec(text);
      const status = match ? Number(match[1]) : undefined;
      if (status !== undefined && acceptedStatuses.has(status)) {
        if (config.authFailureStatuses.includes(status)) {
          recognizedStatus = status;
          break;
        }
        recognizedStatus ??= status;
      }
    }
  }
  return { isError, recognizedStatus };
}

function protocolErrorClass(status: number | undefined, config: GatewayConfig): string | undefined {
  if (status === undefined) return undefined;
  return config.authFailureStatuses.includes(status)
    ? "upstream-protocol-auth"
    : "upstream-protocol-quota";
}

export class McpProxy {
  constructor(
    private readonly store: StateStore,
    private readonly pool: CredentialPool,
    private readonly telemetry?: TelemetryRecorder,
    private readonly supervisor = new SupervisorApi(),
    private readonly oracle?: OracleTools,
    private readonly webTools?: ConfiguredWebTools,
  ) {}

  handler = async (req: Request, res: Response) => {
    const startedAt = Date.now();
    let state = await this.store.load();
    const body = requestBody(req);
    const rpc = req.method === "POST" ? parseClientPayload(body) : undefined;
    const claims = (res.locals as any).oauthClaims as AccessClaims | undefined;
    const described = describeRequest(req, rpc);
    const record = (input: { accountId?: string; status?: number; attempts: number; errorClass?: string; message?: string }) => {
      this.telemetry?.recordGateway({
        kind: "request",
        method: described.method,
        tool: described.tool,
        clientId: claims?.client_id,
        accountId: input.accountId,
        status: input.status,
        latencyMs: Date.now() - startedAt,
        retries: Math.max(0, input.attempts - 1),
        errorClass: input.errorClass,
        message: input.message,
      });
    };

    // Gateway-local jobs are intercepted after OAuth authentication and before
    // policy/pool selection. Exact names never fall through to an upstream.
    if (await this.interceptJobCalls(req, res, rpc, claims, startedAt, record)) return;
    const localJobTools = await this.availableJobTools(claims);
    if (!state.config.upstreamUrl && (localJobTools.length > 0 || this.webTools && (!this.webTools.configured || await this.webTools.configured())) && (this.supervisor.enabled || this.oracle || this.webTools) &&
        await this.serveLocalJobDiscovery(req, res, rpc, localJobTools, record)) return;
    if (!state.config.upstreamUrl) {
      record({ status: 503, attempts: 0, errorClass: "upstream-not-configured" });
      return res.status(503).json({ error: "upstream_not_configured", message: "Set the upstream MCP URL in the ROTOXY admin page or CLI." });
    }

    // ---- Tool policy: enforced here, server-side, before any upstream I/O.
    let policy: CompiledToolPolicy | undefined;
    if (state.config.toolPolicy) {
      try {
        policy = compileToolPolicy(state.config.toolPolicy);
      } catch (error: any) {
        record({ status: 503, attempts: 0, errorClass: "policy-invalid" });
        return res.status(503).json({
          error: "tool_policy_invalid",
          message: "The configured tool policy is invalid, so requests are refused until it is fixed: " + String(error?.message || error),
        });
      }
      // Only POST carries JSON-RPC in Streamable HTTP. Refuse other methods
      // and bodies on non-POST requests so nothing bypasses the gate.
      if (!["GET", "POST", "DELETE", "HEAD", "OPTIONS"].includes(req.method)) {
        record({ status: 405, attempts: 0, errorClass: "policy-unparseable" });
        return res.status(405).setHeader("Allow", "GET, POST, DELETE").json({
          error: "method_not_allowed",
          message: "A tool policy is active; only GET, POST and DELETE are proxied.",
        });
      }
      if (req.method !== "POST" && body) {
        record({ status: 400, attempts: 0, errorClass: "policy-unparseable" });
        return res.status(400).json({
          error: "invalid_request",
          message: "A tool policy is active, so only POST requests may carry a body.",
        });
      }
      if (req.method === "POST" && body && !rpc) {
        record({ status: 400, attempts: 0, errorClass: "policy-unparseable" });
        return res.status(400).json({
          error: "invalid_request",
          message: "A tool policy is active, so request bodies must be JSON-RPC.",
        });
      }
      if (rpc) {
        const gate = gateClientMessage(policy, rpc.payload);
        const forwarded = gate.forward === null ? 0 : Array.isArray(gate.forward) ? gate.forward.length : 1;
        if (gate.rejections.length || forwarded < rpc.messages.length) {
          // Never forward a partially gated body. A batch is rejected as a
          // whole: forwarding part of it would split the response stream
          // between the gateway and the upstream.
          const reason = String(gate.rejections[0]?.error?.message || "Blocked by ROTOXY tool policy");
          const responses = rpc.batch
            ? rpc.messages
                .filter((m) => m.id !== undefined && typeof m.method === "string")
                .map((m) => gate.rejections.find((r) => r.id === m.id) ||
                  rpcError(m.id, POLICY_ERROR_CODE, "Batch rejected because it contains a tool call blocked by ROTOXY tool policy"))
            : gate.rejections;
          if (!responses.length) {
            // Only id-less (notification-style) tool calls: nothing to answer.
            record({ status: 202, attempts: 0, errorClass: "policy-denied", message: reason });
            return res.status(202).end();
          }
          record({ status: 200, attempts: 0, errorClass: "policy-denied", message: reason });
          return res.status(200).json(rpc.batch ? responses : responses[0]);
        }
      }
    }

    // ---- Ownership: existing sessions and task follow-ups go to their owner.
    const incomingSession = req.header("mcp-session-id") || undefined;
    const resolution = this.pool.ownership.resolve({
      sessionId: incomingSession,
      request: rpc?.messages.find((m) => typeof m.method === "string"),
    });
    let pinned: UpstreamAccount | undefined;
    if (resolution.kind === "owner" || resolution.kind === "conflict") {
      const ownerId = resolution.kind === "owner" ? resolution.accountId : resolution.taskOwner;
      pinned = state.accounts.find((a) => a.id === ownerId && a.enabled);
      if (!pinned) {
        // The owning credential was removed or disabled. Per MCP, 404 for a
        // session tells the client to initialize a new session elsewhere.
        if (incomingSession) this.pool.ownership.forgetSession(incomingSession);
        record({ status: 404, attempts: 0, errorClass: "owner-unavailable" });
        return res.status(404).json(rpcError(rpc?.messages[0]?.id, -32001,
          "The upstream credential that owns this MCP session is no longer available. Start a new session."));
      }
    }
    // A session id we have never seen (e.g. after a gateway restart): find
    // the credential that recognises it. An upstream 404 for an unknown
    // session is a pre-execution rejection, so trying the next credential
    // cannot repeat a side effect.
    const discoveringSession = Boolean(incomingSession) && resolution.kind === "unknown-session";

    const readOnlyTools = state.config.readOnlyTools || [];
    const safeToReplay = replaySafe(req, rpc, readOnlyTools);
    const stateful = Boolean(incomingSession);
    const accountCount = Math.max(1, state.accounts.length);
    const maxAttempts = pinned
      ? 1
      : discoveringSession
        ? accountCount
        : stateful && !state.config.failoverStateful
          ? 1
          : Math.max(1, Math.min(state.config.maxFailoverAttempts, accountCount));

    const affinityKey = claims?.sub;
    const attempted = new Set<string>();
    let attempts = 0;
    let lastStatus = 503;
    let lastBody = "";
    let lastHeaders: Headers | undefined;
    let lastAccountId: string | undefined;
    let lastErrorClass: string | undefined;
    let observedProtocolErrorClass: string | undefined;
    const isToolsListRequest = Boolean(rpc?.messages.some((m) => m.method === "tools/list"));
    const wantsToolsList = (Boolean(policy?.hideDenied) || localJobTools.length > 0) && isToolsListRequest;
    const observeTasks = Boolean(rpc?.messages.some((m) => m.method === "tools/call"));

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      state = await this.store.load();
      const account = pinned
        ? state.accounts.find((a) => a.id === pinned!.id)
        : this.pool.pick(state, { sessionId: affinityKey, exclude: attempted });
      if (!account) break;
      attempted.add(account.id);
      attempts += 1;
      lastAccountId = account.id;
      const attemptStarted = Date.now();
      this.pool.start(account.id);
      // The timeout bounds the wait for upstream headers (and for bodies the
      // gateway buffers); a long-lived stream is ended by the client instead.
      // A client disconnect always cancels the upstream request.
      const abort = new AbortController();
      const timer = setTimeout(
        () => abort.abort(new DOMException("Upstream request timed out.", "TimeoutError")),
        state.config.requestTimeoutMs,
      );
      const onClientClose = () => {
        if (!res.writableFinished) abort.abort(new DOMException("Client disconnected.", "AbortError"));
      };
      res.once("close", onClientClose);
      let streaming = false;

      try {
        const token = await this.store.revealToken(account);
        const target = mergeIncomingQuery(state.config.upstreamUrl, req.originalUrl);
        const headers = copyRequestHeaders(req);
        const scheme = state.config.upstreamAuthScheme.trim();
        headers.set(state.config.upstreamAuthHeader, scheme ? scheme + " " + token : token);
        headers.set("x-token2oauth-gateway", "1");

        const upstream = await fetch(target, {
          method: req.method,
          headers,
          body: body ? new Uint8Array(body) : undefined,
          redirect: "manual",
          signal: abort.signal,
        });

        const observeProtocolResponse = Boolean(
          upstream.ok && observeTasks && upstream.body && req.method !== "HEAD" &&
          !(wantsToolsList && req.method !== "HEAD"),
        );
        if (!observeProtocolResponse) this.recordAttempt(account.id, described, upstream.status, attemptStarted, undefined, claims?.client_id);
        const upstreamSession = upstream.headers.get("mcp-session-id") || undefined;

        if (upstream.ok) {
          this.pool.ownership.bindSession(upstreamSession, account.id);
          if (discoveringSession) this.pool.ownership.bindSession(incomingSession, account.id);
          if (req.method === "DELETE" && incomingSession) this.pool.ownership.forgetSession(incomingSession);
          if (observeProtocolResponse) this.pool.bindSession(affinityKey, account.id);
          else await this.pool.success(account.id, upstream.status, affinityKey);
          const contentType = upstream.headers.get("content-type");

          if (wantsToolsList && req.method !== "HEAD") {
            await this.sendFiltered(res, upstream, policy, rpc!, localJobTools);
            record({ accountId: account.id, status: upstream.status, attempts });
            return;
          }

          copyResponseHeaders(upstream.headers, res);
          res.status(upstream.status);
          if (!upstream.body || req.method === "HEAD") {
            record({ accountId: account.id, status: upstream.status, attempts });
            return res.end();
          }
          clearTimeout(timer);
          streaming = true;
          const source = Readable.fromWeb(upstream.body as any);
          let recorded = false;
          let healthObserved = false;
          const finished = (error?: unknown) => {
            if (recorded) return;
            recorded = true;
            record({
              accountId: account.id,
              status: upstream.status,
              attempts,
              errorClass: error ? "stream-interrupted" : observedProtocolErrorClass,
            });
          };
          const stages: NodeJS.ReadWriteStream[] = observeProtocolResponse ? [this.taskObserver(
            account.id,
            contentType,
            async (messages) => {
              const observation = protocolErrorObservation(messages, state.config);
              let errorClass = observation.isError ? "upstream-protocol-error" : undefined;
              try {
                if (observation.recognizedStatus !== undefined) {
                  await this.pool.failure(account.id, { status: observation.recognizedStatus }, state.config);
                  errorClass = protocolErrorClass(observation.recognizedStatus, state.config);
                } else {
                  await this.pool.success(account.id, upstream.status, affinityKey);
                }
              } catch {
                // Health observation must never interrupt the streamed response.
              }
              healthObserved = true;
              observedProtocolErrorClass = errorClass;
              this.recordAttempt(account.id, described, upstream.status, attemptStarted, errorClass, claims?.client_id);
            },
          )] : [];
          // pipeline() destroys every stage on error, so an upstream reset or
          // client disconnect can never surface as an uncaught stream error.
          pipeline([source, ...stages, res] as any, (error: NodeJS.ErrnoException | null) => {
            res.off("close", onClientClose);
            if (error && observeProtocolResponse && !healthObserved) {
              // A complete protocol result was unavailable; retain the prior
              // HTTP-success health accounting for an interrupted stream.
              healthObserved = true;
              void this.pool.success(account.id, upstream.status, affinityKey).catch(() => undefined);
              this.recordAttempt(account.id, described, upstream.status, attemptStarted, "stream-interrupted", claims?.client_id);
            }
            finished(error && error.code !== "ERR_STREAM_PREMATURE_CLOSE" ? error : undefined);
          });
          return;
        }

        const text = await responseTextCapped(upstream);
        lastStatus = upstream.status;
        lastBody = text;
        lastHeaders = upstream.headers;

        if (discoveringSession && upstream.status === 404) {
          // This credential does not own the session; it is not unhealthy.
          lastErrorClass = "session-not-found";
          continue;
        }

        const result = await this.pool.failure(
          account.id,
          { status: upstream.status, body: text, retryAfter: upstream.headers.get("retry-after") },
          state.config,
        );
        lastErrorClass = result.preExecution ? "upstream-rejected" : "upstream-http";
        if (!result.retryable) break;
        if (!result.preExecution && !safeToReplay) {
          lastErrorClass = "not-replayed";
          break;
        }
        if (stateful && !discoveringSession && !state.config.failoverStateful) break;
      } catch (error: any) {
        if (abort.signal.reason?.name === "AbortError") {
          // The client went away; the credential did nothing wrong.
          record({ accountId: account.id, attempts, errorClass: "client-closed" });
          return;
        }
        const timedOut = error?.name === "TimeoutError";
        const code = error?.cause?.code || error?.code;
        this.recordAttempt(account.id, described, undefined, attemptStarted, timedOut ? "timeout" : "transport", claims?.client_id);
        lastStatus = timedOut ? 504 : 502;
        lastHeaders = undefined;
        lastBody = JSON.stringify({
          error: "upstream_unavailable",
          message: timedOut ? "Upstream request timed out." : String(error?.message || error),
        });
        lastErrorClass = timedOut ? "timeout" : "transport";
        const result = await this.pool.failure(account.id, { error: String(error?.message || error) }, state.config);
        if (!result.retryable) break;
        // A timeout or reset is ambiguous: the upstream may have executed the
        // call. Only replay requests that are known to be read-only, or where
        // the connection provably never reached the upstream.
        if (!safeToReplay && !UNSENT_ERROR_CODES.has(code)) {
          lastErrorClass = "not-replayed";
          break;
        }
        if (stateful && !discoveringSession && !state.config.failoverStateful) break;
      } finally {
        if (!streaming) {
          clearTimeout(timer);
          res.off("close", onClientClose);
        }
        this.pool.finish(account.id);
      }
    }

    record({ accountId: lastAccountId, status: lastBody ? lastStatus : 503, attempts, errorClass: lastErrorClass || "no-credential" });
    if (lastHeaders) copyResponseHeaders(lastHeaders, res);
    res.status(lastStatus);
    if (!res.getHeader("content-type")) res.type("application/json");
    if (lastBody) return res.send(lastBody);
    return res.status(503).json({
      error: "no_healthy_upstream_credentials",
      message: "Every enabled upstream credential is unavailable, cooling down, exhausted, or authentication-failed.",
    });
  };

  private recordAttempt(
    accountId: string,
    described: { method: string; tool?: string },
    status: number | undefined,
    startedAt: number,
    errorClass?: string,
    clientId?: string,
  ): void {
    this.telemetry?.recordGateway({
      kind: "attempt",
      method: described.method,
      tool: described.tool,
      clientId,
      accountId,
      status,
      latencyMs: Date.now() - startedAt,
      errorClass: errorClass ?? (status !== undefined && status >= 400 ? "upstream-http" : undefined),
    });
  }

  /** Buffer tools/list when applying policy and/or adding OAuth-scoped local tools. */
  private async sendFiltered(
    res: Response,
    upstream: globalThis.Response,
    policy: CompiledToolPolicy | undefined,
    rpc: ParsedClientPayload,
    localTools: readonly Record<string, unknown>[],
  ): Promise<void> {
    const contentType = upstream.headers.get("content-type");
    const buffered = await readBodyLimited(upstream, MAX_FILTERED_RESPONSE_BYTES);
    const methods = new Map<string | number, string>();
    for (const message of rpc.messages) {
      if (message.id !== undefined && message.id !== null && typeof message.method === "string") methods.set(message.id, message.method);
    }
    const rewritten = buffered === undefined ? undefined : rewriteServerBody(contentType, buffered.toString("utf8"), (payload) => {
      const filtered = policy ? filterServerMessage(policy, payload, methods) : payload;
      const augment = (message: JsonRpcMessage): JsonRpcMessage => {
        if (message.id === undefined || message.id === null || methods.get(message.id) !== "tools/list" || !localTools.length || !message.result || typeof message.result !== "object") return message;
        const result = message.result as Record<string, unknown>;
        const tools = Array.isArray(result.tools) ? result.tools : [];
        const existingNames = new Set(tools.flatMap((tool) => tool && typeof tool === "object" && typeof (tool as any).name === "string" ? [(tool as any).name] : []));
        if (localTools.some((tool) => existingNames.has(tool.name))) return rpcError(message.id, -32603, "The upstream MCP server uses a reserved ROTOXY local tool name.");
        return { ...message, result: { ...result, tools: [...tools, ...localTools] } };
      };
      return Array.isArray(filtered) ? filtered.map(augment) : augment(filtered);
    });
    if (rewritten === undefined) {
      res.status(502).json(rpcError(rpc.messages[0]?.id, -32603, "ROTOXY could not safely apply the tools/list update."));
      return;
    }
    copyResponseHeaders(upstream.headers, res);
    res.status(upstream.status);
    res.send(rewritten);
  }

  private async availableJobTools(claims: AccessClaims | undefined): Promise<Record<string, unknown>[]> {
    if ((!this.supervisor.enabled && !this.oracle && !this.webTools) || !claims) return [];
    const scopes = new Set(claims.scope.split(/\s+/));
    return [...(this.supervisor.enabled ? JOB_TOOL_DEFINITIONS.filter((d) => scopes.has(requiredJobScope(d.name))) : []), ...(this.oracle ? ORACLE_TOOL_DEFINITIONS.filter((d) => scopes.has(oracleToolRequiredScope(d.name))) : []), ...(this.webTools ? await this.webTools.definitionsFor(claims.client_id, scopes) : [])].map((definition) => ({ ...definition }));
  }

  /** Serve only OAuth-authorized local job tools when no general upstream exists. */
  private async serveLocalJobDiscovery(
    req: Request,
    res: Response,
    rpc: ParsedClientPayload | undefined,
    tools: readonly Record<string, unknown>[],
    record: (input: { status?: number; attempts: number; errorClass?: string }) => void,
  ): Promise<boolean> {
    if (req.method !== "POST" || !rpc || rpc.batch || rpc.messages.length !== 1) return false;
    const message = rpc.messages[0]!;
    if (message.method === "notifications/initialized" && message.id === undefined) {
      record({ status: 204, attempts: 0 });
      res.status(204).end();
      return true;
    }
    if (message.id === undefined || message.id === null) return false;
    if (message.method === "initialize") {
      const requested = message.params?.protocolVersion;
      const supported = ["2025-06-18", "2025-03-26"];
      const protocolVersion = typeof requested === "string" && supported.includes(requested) ? requested : supported[0]!;
      record({ status: 200, attempts: 0 });
      res.status(200).json({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ROTOXY", version: "0.2.0" },
      } });
      return true;
    }
    if (message.method === "tools/list") {
      record({ status: 200, attempts: 0 });
      res.status(200).json({ jsonrpc: "2.0", id: message.id, result: { tools } });
      return true;
    }
    return false;
  }

  private async interceptJobCalls(
    req: Request,
    res: Response,
    rpc: ParsedClientPayload | undefined,
    claims: AccessClaims | undefined,
    _startedAt: number,
    record: (input: { status?: number; attempts: number; errorClass?: string; message?: string }) => void,
  ): Promise<boolean> {
    if (req.method !== "POST" || !rpc) return false;
    const local = rpc.messages.filter((message) => message.method === "tools/call" && (isJobToolName(message.params?.name) || isOracleToolName(message.params?.name) || message.params?.name === "web_search" || message.params?.name === "web_extract"));
    if (!local.length) return false;
    const mixed = rpc.messages.some((message) => !local.includes(message));
    if (mixed) {
      record({ status: 400, attempts: 0, errorClass: "mixed-local-batch" });
      res.status(400).json({ error: "mixed_local_tool_batch_unsupported" });
      return true;
    }
    const scopeSet = new Set(claims?.scope.split(/\s+/) || []);
    const scopeFor = (name: string) => name === "web_search" ? "web:search" : name === "web_extract" ? "web:extract" : isOracleToolName(name) ? oracleToolRequiredScope(name) : requiredJobScope(name as JobToolName);
    const missing = local.find((message) => !scopeSet.has(scopeFor(String(message.params!.name))));
    if (missing || !claims) {
      const responses = local.filter((message) => message.id !== undefined).map((message) => rpcError(message.id, -32003, "insufficient_scope", { requiredScope: scopeFor(String(message.params!.name)) }));
      record({ status: 403, attempts: 0, errorClass: "insufficient-scope" });
      if (!responses.length) return res.status(403).json({ error: "insufficient_scope" }), true;
      res.status(403).json(rpc.batch ? responses : responses[0]);
      return true;
    }
    const unavailable = local.filter((message) => isOracleToolName(message.params?.name) ? !this.oracle : isJobToolName(message.params?.name) ? !this.supervisor.enabled : !this.webTools);
    if (unavailable.length) {
      const responses = unavailable.filter((message) => message.id !== undefined).map((message) => rpcError(message.id, -32000, message.params?.name === "web_search" || message.params?.name === "web_extract" ? "web tools are not configured" : "durable supervisor is not configured"));
      record({ status: 503, attempts: 0, errorClass: "supervisor-unavailable" });
      if (!responses.length) return res.status(202).end(), true;
      res.status(503).json(rpc.batch ? responses : responses[0]);
      return true;
    }
    const responses: JsonRpcMessage[] = [];
    let status = 200;
    for (const message of local) {
      try {
        const name = String(message.params!.name);
        const value = isOracleToolName(name)
          ? await this.oracle!.call(name, message.params?.arguments ?? {}, claims.client_id)
          : name === "web_search" || name === "web_extract"
            ? await this.webTools!.call(name, message.params?.arguments ?? {}, claims.client_id)
            : await this.supervisor.callTool(name as JobToolName, message.params?.arguments ?? {}, claims.client_id);
        const text = JSON.stringify(value ?? null);
        if (Buffer.byteLength(text) > 1_048_576) throw new Error("result too large");
        if (message.id !== undefined) responses.push({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } });
      } catch (error) {
        if (error instanceof OracleToolError) {
          if (message.id !== undefined) responses.push(rpcError(message.id, -32000, error.code));
        } else if (error instanceof WebToolError) {
          status = error.code === "tool_not_allowed" ? 403 : 502;
          if (message.id !== undefined) responses.push(rpcError(message.id, error.code === "tool_not_allowed" ? -32003 : -32000, error.code));
        } else if (error instanceof JobInputError) {
          if (message.id !== undefined) responses.push(rpcError(message.id, -32602, error.message));
        } else if (error instanceof SupervisorUnavailable) {
          status = 503;
          if (message.id !== undefined) responses.push(rpcError(message.id, -32000, "durable supervisor is not configured"));
        } else {
          status = 502;
          if (message.id !== undefined) responses.push(rpcError(message.id, -32000, "supervisor operation failed"));
        }
      }
    }
    record({ status, attempts: 0, errorClass: status === 200 ? undefined : "supervisor-operation" });
    if (!responses.length) return res.status(202).end(), true;
    res.status(status).json(rpc.batch ? responses : responses[0]);
    return true;
  }

  /** Pass a streamed response through unchanged while learning task ownership. */
  private taskObserver(
    accountId: string,
    contentType: string | null,
    onObserved: (messages: JsonRpcMessage[]) => Promise<void>,
  ): Transform {
    const chunks: Buffer[] = [];
    let size = 0;
    const ownership = this.pool.ownership;
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (size < MAX_OBSERVED_BYTES) {
          const observed = chunk.subarray(0, MAX_OBSERVED_BYTES - size);
          chunks.push(Buffer.from(observed));
          size += observed.length;
        }
        callback(null, chunk);
      },
      flush(callback) {
        void (async () => {
          let messages: JsonRpcMessage[] = [];
          const text = Buffer.concat(chunks).subarray(0, MAX_OBSERVED_BYTES).toString("utf8");
          try {
            messages = serverMessages(contentType, text);
          } catch {
            // Parsing is best-effort; the response itself already passed through.
          }
          for (const message of messages) {
            ownership.bindTask(taskIdFromResponse(message), accountId);
          }
          await onObserved(messages).catch(() => undefined);
        })().finally(callback);
      },
    });
  }
}
