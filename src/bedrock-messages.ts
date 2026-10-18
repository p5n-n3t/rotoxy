import express, { type Request, type Response, type Router } from "express";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import type { StateStore } from "./store.js";
import { ModelCredentialStore } from "./model-credentials.js";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const HARD_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const HARD_MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const HARD_MAX_CONCURRENCY = 32;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const HARD_MAX_OUTPUT_TOKENS = 65_536;
const AWS_BEARER_ENV = "AWS_BEARER_TOKEN_BEDROCK";

type MessageClient = {
  messages: {
    create(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> | AsyncIterable<unknown>;
  };
};

export interface BedrockMessagesOptions {
  /** Trusted operator configuration. Defaults to ROTOXY_BEDROCK_REGION. */
  region?: string;
  /** Trusted comma-separated or array allowlist. Defaults to ROTOXY_BEDROCK_MODELS. */
  models?: string | string[];
  /** Tests may inject an SDK-compatible client. Production uses AnthropicBedrockMantle. */
  clientFactory?: (config: { region: string; baseURL: string; timeoutMs: number; maxRetries: 0 }) => MessageClient;
  maxBodyBytes?: number;
  maxConcurrency?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  now?: () => number;
}

export type BedrockMessagesConfiguration = {
  region: string;
  models: string[];
  baseURL: string;
};

export class BedrockMessagesError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "BedrockMessagesError";
  }
}

function validRegion(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(value);
}

function normalizeModels(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const models = [...new Set(values.map(model => model.trim()).filter(Boolean))];
  if (models.length > 100 || models.some(model => model.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model))) return [];
  return models;
}

export function resolveBedrockMessagesConfiguration(options: BedrockMessagesOptions = {}): BedrockMessagesConfiguration | undefined {
  const region = options.region ?? process.env.ROTOXY_BEDROCK_REGION;
  const models = normalizeModels(options.models ?? process.env.ROTOXY_BEDROCK_MODELS);
  if (!validRegion(region) || !models.length) return undefined;
  // Never honor an environment URL override or caller-supplied host. SDK client
  // receives this fixed AWS host and operator-validated region only.
  return { region, models, baseURL: `https://bedrock-mantle.${region}.api.aws/anthropic` };
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}

function requestCredential(req: Request): { token?: string; conflict: boolean } {
  const apiKey = req.header("x-api-key");
  const authorization = req.header("authorization");
  if (apiKey !== undefined && authorization !== undefined) return { conflict: true };
  if (apiKey !== undefined) return { token: apiKey, conflict: false };
  const match = authorization === undefined ? undefined : /^Bearer ([^\s]{1,160})$/i.exec(authorization);
  return { token: match?.[1], conflict: authorization !== undefined && !match };
}

function jsonError(res: Response, status: number, code: string): void {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  res.status(status).type("application/json").json({
    type: "error",
    error: { type: status === 401 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error", message: code },
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

function safeStatus(error: unknown): { status: number; code: string } {
  if (error instanceof BedrockMessagesError) return { status: error.status, code: error.code };
  if (error && typeof error === "object" && "name" in error && error.name === "AbortError") return { status: 504, code: "upstream_timeout" };
  // Do not echo SDK/AWS exception messages, headers, URLs, or request payloads.
  return { status: 502, code: "upstream_failure" };
}

function isClientGone(req: Request, res: Response): boolean {
  return req.aborted || res.destroyed || res.writableEnded;
}

async function waitForDrain(res: Response, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || res.destroyed || res.writableEnded) return false;
  return new Promise(resolve => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (value: boolean) => { cleanup(); resolve(value); };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onAbort = () => finish(false);
    res.once("drain", onDrain);
    res.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function writeEvent(res: Response, event: unknown, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || res.destroyed || res.writableEnded) return false;
  const type = event && typeof event === "object" && "type" in event && typeof event.type === "string" && /^[a-z_]{1,64}$/.test(event.type)
    ? event.type
    : "message";
  if (!res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)) return waitForDrain(res, signal);
  return !signal.aborted && !res.destroyed && !res.writableEnded;
}

function createClient(config: BedrockMessagesConfiguration, timeoutMs: number): MessageClient {
  return new AnthropicBedrockMantle({
    awsRegion: config.region,
    baseURL: config.baseURL,
    timeout: timeoutMs,
    maxRetries: 0,
  }) as unknown as MessageClient;
}

/** Native Anthropic Messages endpoint backed by Bedrock Mantle, gated by a ROTOXY model:invoke token. */
export function createBedrockMessagesRouter(store: StateStore, options: BedrockMessagesOptions = {}): Router {
  const router = express.Router();
  const credentials = new ModelCredentialStore(store);
  const maxBodyBytes = boundedInteger(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1024, HARD_MAX_BODY_BYTES);
  const maxConcurrency = boundedInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY, 1, HARD_MAX_CONCURRENCY);
  const maxOutputTokens = boundedInteger(options.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 1, HARD_MAX_OUTPUT_TOKENS);
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, HARD_MAX_TIMEOUT_MS);
  const now = options.now ?? Date.now;
  let inFlight = 0;
  const configuration = resolveBedrockMessagesConfiguration(options);
  const client = configuration && !process.env[AWS_BEARER_ENV] ? (options.clientFactory ?? ((config) => createClient(configuration, config.timeoutMs)))({
    region: configuration.region, baseURL: configuration.baseURL, timeoutMs, maxRetries: 0,
  }) : undefined;
  // AnthropicBedrockMantle itself prefers AWS_BEARER_TOKEN_BEDROCK ahead of
  // role credentials. Do not allow that alternate mode to silently activate.
  const unsafeCredentialMode = Boolean(process.env[AWS_BEARER_ENV]);

  router.post("/providers/claude/v1/messages", async (req, res) => {
    const auth = requestCredential(req);
    if (auth.conflict || !auth.token || !await credentials.authorizeToken(auth.token, "model:invoke", now())) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="rotoxy", scope="model:invoke"');
      return jsonError(res, 401, "unauthorized");
    }
    if (!configuration || !client || unsafeCredentialMode) return jsonError(res, 503, "bedrock_not_configured");
    if (inFlight >= maxConcurrency) return jsonError(res, 503, "bedrock_capacity_exhausted");
    // Reserve synchronously before body parsing so simultaneous requests cannot
    // all pass the capacity check while their bodies are being read.
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    let serving = false;
    let timedOut = false;
    const controller = new AbortController();
    const cleanup = () => {
      clearTimeout(timeout);
      req.off("aborted", disconnect);
      res.off("close", disconnect);
      release();
    };
    const disconnect = () => {
      if (!controller.signal.aborted) controller.abort();
      if (!serving) cleanup();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (!serving) {
        cleanup();
        jsonError(res, 504, "upstream_timeout");
        // Drain any remaining body bytes after rejecting a slow client body.
        req.resume();
      }
    }, timeoutMs);
    req.once("aborted", disconnect);
    res.once("close", disconnect);

    const parse = express.raw({ type: "application/json", limit: maxBodyBytes });
    parse(req, res, parseError => {
      if (parseError) {
        cleanup();
        return jsonError(res, parseError && typeof parseError === "object" && "type" in parseError && parseError.type === "entity.too.large" ? 413 : 400,
          parseError && typeof parseError === "object" && "type" in parseError && parseError.type === "entity.too.large" ? "request_too_large" : "invalid_request");
      }
      if (timedOut || isClientGone(req, res)) { cleanup(); return; }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) { cleanup(); return jsonError(res, 400, "invalid_request"); }
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(req.body.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { cleanup(); return jsonError(res, 400, "invalid_request"); }
        body = parsed as Record<string, unknown>;
      } catch { cleanup(); return jsonError(res, 400, "invalid_request"); }
      if (typeof body.model !== "string" || !configuration.models.includes(body.model)) { cleanup(); return jsonError(res, 400, "model_not_allowed"); }
      if (!Number.isSafeInteger(body.max_tokens) || (body.max_tokens as number) < 1 || (body.max_tokens as number) > maxOutputTokens || !Array.isArray(body.messages) || !body.messages.length) {
        cleanup(); return jsonError(res, 400, "invalid_request");
      }
      if (body.stream !== undefined && typeof body.stream !== "boolean") { cleanup(); return jsonError(res, 400, "invalid_request"); }
      serving = true;
      void serve(req, res, client!, body, controller, () => timedOut, cleanup);
    });
  });

  return router;
}

async function serve(
  req: Request, res: Response, client: MessageClient, body: Record<string, unknown>,
  controller: AbortController, timedOut: () => boolean, cleanup: () => void,
): Promise<void> {
  const throwIfAborted = () => {
    if (controller.signal.aborted) {
      const error = new Error("request_aborted");
      error.name = "AbortError";
      throw error;
    }
  };
  try {
    const result = await client.messages.create(body, { signal: controller.signal });
    throwIfAborted();
    if (body.stream === true) {
      if (!isAsyncIterable(result)) throw new Error("invalid_stream_response");
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      for await (const event of result) {
        if (!await writeEvent(res, event, controller.signal)) {
          if (controller.signal.aborted) throwIfAborted();
          return;
        }
      }
      throwIfAborted();
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }
    if (isAsyncIterable(result)) throw new Error("unexpected_stream_response");
    throwIfAborted();
    if (!res.destroyed && !res.writableEnded) res.status(200).type("application/json").json(result);
  } catch (caught) {
    if (isClientGone(req, res)) return;
    const { status, code } = timedOut() ? { status: 504, code: "upstream_timeout" } : safeStatus(caught);
    if (res.headersSent) {
      if (!res.destroyed && !res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: code } })}\n\n`);
        res.end();
      }
      return;
    }
    jsonError(res, status, code);
  } finally {
    cleanup();
  }
}
