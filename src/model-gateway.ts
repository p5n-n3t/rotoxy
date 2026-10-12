import express, { type NextFunction, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StateStore } from "./store.js";
import { ModelCredentialStore, type ModelScope } from "./model-credentials.js";

const OLLAMA_ORIGIN = "https://ollama.com";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_RESPONSE_BYTES = 2 * 1024 * 1024;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "ollama-version", "x-request-id", "request-id"];

export interface ModelGatewayOptions {
  fetch?: typeof globalThis.fetch;
  maxInflightPerAccount?: number;
  requestTimeoutMs?: number;
  quotaCooldownMs?: number;
  now?: () => number;
}
interface RouteTarget { path: "/v1/models" | "/v1/chat/completions"; method: "GET" | "POST"; scope: ModelScope }

function routeTarget(method: string, path: string): RouteTarget | undefined {
  const normalized = path.replace(/^\/(?:p\/ollama|pool\/ollama)/, "");
  if (normalized === "/v1/models" && method === "GET") return { path: normalized, method, scope: "model:read" };
  if (normalized === "/v1/chat/completions" && method === "POST") return { path: normalized, method, scope: "model:invoke" };
  return undefined;
}
function bearer(req: Request): string | undefined {
  const value = req.header("authorization");
  const match = value && /^Bearer ([^\s]{1,128})$/i.exec(value);
  return match?.[1];
}
function sendError(res: Response, status: number, message: string): void {
  res.status(status).type("application/json").json({ error: { message, type: "model_gateway_error" } });
}
function safeHeaders(upstream: globalThis.Response, res: Response): void {
  for (const header of SAFE_RESPONSE_HEADERS) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

async function readBounded(response: globalThis.Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MODEL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("provider response exceeds limit");
      }
      parts.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts, size);
}

/** Native bounded Ollama Cloud OpenAI-compatible proxy; no external process or user-supplied URL. */
export function createModelGateway(store: StateStore, options: ModelGatewayOptions = {}) {
  const credentials = new ModelCredentialStore(store);
  const router = express.Router();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const maxInflight = options.maxInflightPerAccount ?? 2;
  const timeoutMs = options.requestTimeoutMs ?? 120_000;
  const cooldownMs = options.quotaCooldownMs ?? 15 * 60_000;
  if (!Number.isInteger(maxInflight) || maxInflight < 1 || maxInflight > 64 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000 || !Number.isInteger(cooldownMs) || cooldownMs < 1000 || cooldownMs > 3_600_000) {
    throw new RangeError("model gateway limits are invalid");
  }
  const inflight = new Map<string, number>();
  let roundRobin = 0;

  const handleRequest = async (req: Request, res: Response, next: NextFunction) => {
    const pathname = req.path;
    const isGatewayPath = pathname === "/v1/models" || pathname === "/v1/chat/completions" ||
      pathname.startsWith("/pool/ollama/v1/") || pathname.startsWith("/p/ollama/v1/");
    if (!isGatewayPath) return next();
    const target = routeTarget(req.method, pathname);
    if (!target) return sendError(res, 404, "Unsupported Ollama Cloud route");

    const token = bearer(req);
    if (!token || !(await credentials.authorizeToken(token, target.scope, now()))) {
      res.setHeader("WWW-Authenticate", `Bearer scope=\"${target.scope}\"`);
      return sendError(res, 401, "A valid scoped model gateway token is required");
    }

    const available = (await credentials.listCredentials()).filter((account) => account.enabled && (account.cooldownUntil ?? 0) <= now() && (inflight.get(account.id) ?? 0) < maxInflight);
    if (!available.length) return sendError(res, 503, "No Ollama Cloud credential is currently available");
    const offset = roundRobin++ % available.length;
    let accountView: (typeof available)[number] | undefined;
    let apiKey: string | undefined;
    for (let index = 0; index < available.length; index++) {
      const candidate = available[(offset + index) % available.length];
      const account = await credentials.credentialForRequest(candidate.id);
      // Recheck after the asynchronous decrypt; reserve synchronously so
      // concurrent arrivals cannot exceed this local software cap.
      if (!account || !account.view.enabled || (account.view.cooldownUntil ?? 0) > now() || (inflight.get(candidate.id) ?? 0) >= maxInflight) continue;
      accountView = account.view;
      apiKey = account.apiKey;
      inflight.set(candidate.id, (inflight.get(candidate.id) ?? 0) + 1);
      break;
    }
    if (!accountView || !apiKey) return sendError(res, 503, "No Ollama Cloud credential is currently available");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    const onAbort = () => controller.abort();
    req.once("aborted", onAbort);
    res.once("close", onClose);
    try {
      const body = req.method === "POST" ? req.body : undefined;
      if (req.method === "POST" && (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_REQUEST_BYTES)) {
        return sendError(res, 400, "Request body is missing or exceeds the size limit");
      }
      let upstream: globalThis.Response;
      try {
        upstream = await fetchImpl(OLLAMA_ORIGIN + target.path, {
          method: target.method,
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: req.header("accept")?.slice(0, 256) || "application/json",
            ...(body ? { "content-type": req.header("content-type")?.slice(0, 128) || "application/json" } : {}),
          },
          ...(body ? { body } : {}),
          signal: controller.signal,
          redirect: "manual",
        });
      } catch {
        // Transport/timeout outcomes are ambiguous for invocations. Never replay.
        if (!res.headersSent) sendError(res, 502, "Ollama Cloud request outcome is unknown; request was not retried");
        return;
      }

      if (upstream.status === 401 || upstream.status === 403) {
        await upstream.body?.cancel().catch(() => undefined);
        await credentials.setCredentialEnabled(accountView.id, false);
        return sendError(res, 502, "Ollama Cloud rejected a configured credential; it was disabled for review");
      }
      if (upstream.status === 402 || upstream.status === 429) {
        await upstream.body?.cancel().catch(() => undefined);
        const retryAfter = Number(upstream.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(3_600_000, retryAfter * 1000) : cooldownMs;
        await credentials.setCooldown(accountView.id, now() + waitMs);
        return sendError(res, upstream.status, "Ollama Cloud account is rate-limited or quota-limited; it was cooled down and not retried");
      }
      if (upstream.status < 200 || upstream.status >= 300) {
        await upstream.body?.cancel().catch(() => undefined);
        // Do not reflect arbitrary provider error bodies, which could echo secrets.
        return sendError(res, upstream.status >= 300 && upstream.status < 400 ? 502 : upstream.status, "Ollama Cloud request failed; response details were withheld");
      }

      safeHeaders(upstream, res);
      res.status(upstream.status);
      if (target.method === "GET") {
        try { res.end(await readBounded(upstream)); }
        catch { if (!res.headersSent) sendError(res, 502, "Ollama Cloud model catalog exceeded the response limit"); else res.destroy(); }
        return;
      }
      if (!upstream.body) return res.end();
      await pipeline(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream), res);
    } catch {
      if (!res.headersSent) sendError(res, 502, "Ollama Cloud proxy failed; request was not retried");
      else res.destroy();
    } finally {
      clearTimeout(timer);
      req.off("aborted", onAbort);
      res.off("close", onClose);
      const count = Math.max(0, (inflight.get(accountView.id) ?? 1) - 1);
      if (count) inflight.set(accountView.id, count); else inflight.delete(accountView.id);
    }
  };

  const parseModelBody = express.raw({ type: "*/*", limit: MAX_REQUEST_BYTES });
  router.use((req: Request, res: Response, next: NextFunction) => {
    const pathname = req.path;
    const isGatewayPath = pathname === "/v1/models" || pathname === "/v1/chat/completions" ||
      pathname.startsWith("/pool/ollama/v1/") || pathname.startsWith("/p/ollama/v1/");
    if (!isGatewayPath) return next();
    parseModelBody(req, res, (error?: unknown) => {
      if (error) return next(error);
      void handleRequest(req, res, next).catch(next);
    });
  });

  return { router, credentials };
}
