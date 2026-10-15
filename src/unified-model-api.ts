import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { StateStore } from "./store.js";
import { ResourceRoutingRulesStore } from "./resource-routing.js";
import { CloudflareAIAdapter, CloudflareAIError, CloudflareCredentialStore } from "./cloudflare-ai.js";
import { ModelCredentialStore, type ModelCredentialView } from "./model-credentials.js";

const OLLAMA_ORIGIN = "https://ollama.com";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CATALOG_ACCOUNTS = 100;
const MAX_CATALOG_MODELS = 1000;
const CATALOG_CACHE_MS = 60_000;

interface CatalogBody { object: "list"; data: Array<{ id: string; object: "model"; owned_by: "cloudflare" | "ollama" }> }
interface CatalogVersion { digest: string; cloudflareModels: string[]; ollamaConfigured: boolean; ollamaAccounts: ModelCredentialView[] }
interface CatalogResult { body: CatalogBody; ollamaSource: "live" | "unavailable" | "not-configured" | "not-eligible" }

export interface UnifiedModelApiOptions {
  cloudflareAdapter?: Pick<CloudflareAIAdapter, "run">;
  ollamaFetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
}

function error(res: Response, status: number, code: string): void {
  res.status(status).type("application/json").json({ error: { message: code, type: "model_api_error", code } });
}

function bearer(req: Request): string | undefined {
  const match = /^Bearer ([^\s]{1,128})$/i.exec(req.header("authorization") ?? "");
  return match?.[1];
}

async function readJsonBounded(response: globalThis.Response, maxBytes: number): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("response_too_large");
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size).toString("utf8"));
}

function validMessages(value: unknown): Array<{ role: string; content: string }> | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return undefined;
  const messages: Array<{ role: string; content: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const message = item as Record<string, unknown>;
    if (!(["system", "user", "assistant"] as unknown[]).includes(message.role) || typeof message.content !== "string" || Buffer.byteLength(message.content, "utf8") > 32_000) return undefined;
    messages.push({ role: message.role as string, content: message.content });
  }
  return messages;
}

function hasUnsupportedMessages(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const message = item as Record<string, unknown>;
    return Object.keys(message).some(key => key !== "role" && key !== "content") ||
      message.content !== undefined && typeof message.content !== "string" ||
      ["tool", "function", "developer"].includes(String(message.role));
  });
}

function numericUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const usage = raw as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const [source, target] of [["prompt_tokens", "prompt_tokens"], ["completion_tokens", "completion_tokens"], ["total_tokens", "total_tokens"]]) {
    const value = usage[source];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[target] = value;
  }
  if (result.total_tokens === undefined && result.prompt_tokens !== undefined && result.completion_tokens !== undefined) {
    result.total_tokens = result.prompt_tokens + result.completion_tokens;
  }
  return Object.keys(result).length ? result : undefined;
}

function fileVersion(path: string): Promise<string> {
  return stat(path, { bigint: true }).then(info => `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`).catch((caught: any) => {
    if (caught?.code === "ENOENT") return "missing";
    throw caught;
  });
}

function writeSse(res: Response, data: unknown, clientClosed: () => boolean): boolean {
  if (clientClosed() || res.destroyed || res.writableEnded) return false;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return !clientClosed() && !res.destroyed && !res.writableEnded;
}

function sendSseCompletion(res: Response, completion: {
  id: string; created: number; model: string; content: string; usage?: Record<string, number>;
}, includeUsage: boolean, clientClosed: () => boolean): void {
  if (clientClosed() || res.destroyed || res.writableEnded) return;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const base = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model };
  if (!writeSse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }, clientClosed)) return;
  if (!writeSse(res, { ...base, choices: [{ index: 0, delta: { content: completion.content }, finish_reason: null }] }, clientClosed)) return;
  if (!writeSse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, clientClosed)) return;
  if (includeUsage && !writeSse(res, { ...base, choices: [], usage: completion.usage ?? null }, clientClosed)) return;
  if (clientClosed() || res.destroyed || res.writableEnded) return;
  res.end("data: [DONE]\n\n");
}

/**
 * OpenAI-compatible model API. Mount before the legacy model gateway: this
 * router owns the merged catalog and Cloudflare-prefixed inference only.
 * Non-Cloudflare chat requests continue through `next()` to the existing
 * gateway after an optional `ollama/` model prefix is removed.
 */
export function createUnifiedModelApi(store: StateStore, options: UnifiedModelApiOptions = {}) {
  const router = express.Router();
  const modelCredentials = new ModelCredentialStore(store);
  const cloudflareCredentials = new CloudflareCredentialStore(store);
  const routingRules = new ResourceRoutingRulesStore(store);
  const cloudflare = options.cloudflareAdapter ?? new CloudflareAIAdapter(cloudflareCredentials);
  const ollamaFetch = options.ollamaFetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new RangeError("unified model API timeout is invalid");
  let catalogCache: { digest: string; expiresAt: number; result: CatalogResult } | undefined;
  const catalogFlights = new Map<string, Promise<CatalogResult>>();

  const getCatalogVersion = async (): Promise<CatalogVersion> => {
    const [modelAccounts, cloudflareAccounts, modelFileVersion, cloudflareFileVersion, rules, rulesFileVersion] = await Promise.all([
      modelCredentials.listCredentials(), cloudflareCredentials.listCredentials(),
      fileVersion(join(store.dir, "model-credentials.json")), fileVersion(join(store.dir, "cloudflare-ai-credentials.json")),
      routingRules.read(), fileVersion(routingRules.path),
    ]);
    // Use public account metadata and file inode/timestamps only. Never read or hash credential contents.
    const metadata = {
      modelAccounts: modelAccounts.map(({ id, enabled, createdAt, cooldownUntil }) => ({ id, enabled, createdAt, cooldownUntil })).sort((a, b) => a.id.localeCompare(b.id)),
      cloudflareAccounts: cloudflareAccounts.map(({ id, enabled, createdAt, cooldownUntil, allowedModels }) => ({ id, enabled, createdAt, cooldownUntil, allowedModels: [...allowedModels].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
      files: [modelFileVersion, cloudflareFileVersion, rulesFileVersion],
      routing: rules.resources,
    };
    const digest = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
    return {
      digest,
      cloudflareModels: cloudflareAccounts.filter(account => account.enabled && rules.resources[account.id]?.enabled !== false && (account.cooldownUntil ?? 0) <= now()).flatMap(account => account.allowedModels.map(model => `cloudflare/${model}`)),
      ollamaConfigured: modelAccounts.length > 0,
      ollamaAccounts: modelAccounts.filter(account => account.enabled && rules.resources[account.id]?.enabled !== false && (account.cooldownUntil ?? 0) <= now()),
    };
  };

  const buildCatalog = async (version: CatalogVersion): Promise<CatalogResult> => {
    if (version.ollamaAccounts.length > MAX_CATALOG_ACCOUNTS) throw new Error("ollama_catalog_account_limit");
    const ollamaModels = new Set<string>();
    let successfulCatalogs = 0;
    const catalogController = new AbortController();
    const catalogTimer = setTimeout(() => catalogController.abort(), timeoutMs);
    try {
      for (const account of version.ollamaAccounts) {
        const credential = await modelCredentials.credentialForRequest(account.id);
        if (!credential || !credential.view.enabled || (credential.view.cooldownUntil ?? 0) > now()) continue;
        try {
          const response = await ollamaFetch(`${OLLAMA_ORIGIN}/v1/models`, {
            method: "GET", redirect: "error", signal: catalogController.signal,
            headers: { authorization: `Bearer ${credential.apiKey}`, accept: "application/json" },
          });
          if (!response.ok) { await response.body?.cancel().catch(() => undefined); continue; }
          const payload = await readJsonBounded(response, MAX_RESPONSE_BYTES) as { data?: unknown };
          if (!Array.isArray(payload?.data)) continue;
          successfulCatalogs++;
          for (const entry of payload.data.slice(0, MAX_CATALOG_MODELS)) {
            const id = entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : undefined;
            if (typeof id !== "string" || !id.length || id.length > 200 || /[\r\n\0]/.test(id)) continue;
            ollamaModels.add(`ollama/${id}`);
            ollamaModels.add(id);
          }
        } catch { /* Keep provider errors and credential material out of the public catalog. */ }
        if (catalogController.signal.aborted) break;
      }
    } finally { clearTimeout(catalogTimer); }
    if (version.ollamaAccounts.length > 0 && successfulCatalogs === 0 && version.cloudflareModels.length === 0) throw new Error("ollama_catalog_unavailable");
    const names = [...new Set([...version.cloudflareModels, ...ollamaModels])].slice(0, MAX_CATALOG_MODELS * 2);
    return {
      body: { object: "list", data: names.map(id => ({ id, object: "model", owned_by: id.startsWith("cloudflare/") ? "cloudflare" : "ollama" })) },
      ollamaSource: version.ollamaAccounts.length === 0 ? version.ollamaConfigured ? "not-eligible" : "not-configured" : successfulCatalogs ? "live" : "unavailable",
    };
  };

  router.use((req, res, next) => {
    if (req.path !== "/v1/models" && req.path !== "/v1/chat/completions") return next();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  router.get("/v1/models", async (req, res) => {
    try {
      const token = bearer(req);
      if (!token || !await modelCredentials.authorizeToken(token, "model:read", now())) {
        res.setHeader("WWW-Authenticate", 'Bearer scope="model:read"');
        return error(res, 401, "unauthorized");
      }
      const version = await getCatalogVersion();
      let result: CatalogResult;
      let cacheState: "hit" | "shared" | "miss";
      if (catalogCache?.digest === version.digest && catalogCache.expiresAt > now()) {
        result = catalogCache.result;
        cacheState = "hit";
      } else {
        let flight = catalogFlights.get(version.digest);
        cacheState = flight ? "shared" : "miss";
        if (!flight && catalogCache?.digest === version.digest && catalogCache.expiresAt > now()) {
          result = catalogCache.result;
          cacheState = "hit";
          res.setHeader("X-Model-Catalog-Provenance", `cloudflare-allowlist; ollama-${result.ollamaSource}; cache-${cacheState}`);
          return res.json(result.body);
        }
        if (!flight) {
          flight = buildCatalog(version).then(async built => {
            try {
              const latest = await getCatalogVersion();
              if (latest.digest === version.digest) catalogCache = { digest: version.digest, expiresAt: now() + CATALOG_CACHE_MS, result: built };
            } catch { /* Serve this response but leave the cache empty if metadata changed during the query. */ }
            return built;
          }).finally(() => { if (catalogFlights.get(version.digest) === flight) catalogFlights.delete(version.digest); });
          catalogFlights.set(version.digest, flight);
        }
        result = await flight;
      }
      if (res.destroyed || res.writableEnded) return;
      res.setHeader("X-Model-Catalog-Provenance", `cloudflare-allowlist; ollama-${result.ollamaSource}; cache-${cacheState}`);
      return res.json(result.body);
    } catch (caught) {
      const code = caught instanceof Error && ["ollama_catalog_account_limit", "ollama_catalog_unavailable"].includes(caught.message) ? caught.message : "model_catalog_unavailable";
      return error(res, 503, code);
    }
  });

  const parseBody = express.raw({ type: "application/json", limit: MAX_REQUEST_BYTES });
  router.post("/v1/chat/completions", (req, res, next) => {
    parseBody(req, res, (parseError?: unknown) => {
      if (parseError) return error(res, 413, "request_too_large");
      void (async () => {
        const token = bearer(req);
        if (!token || !await modelCredentials.authorizeToken(token, "model:invoke", now())) {
          res.setHeader("WWW-Authenticate", 'Bearer scope="model:invoke"');
          return error(res, 401, "unauthorized");
        }

        if (!Buffer.isBuffer(req.body) || req.body.length === 0) return error(res, 400, "invalid_request");
        let body: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(req.body.toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return error(res, 400, "invalid_request");
          body = parsed as Record<string, unknown>;
        } catch { return error(res, 400, "invalid_request"); }
        if (typeof body.model !== "string" || !body.model || body.model.length > 240) return error(res, 400, "invalid_model");
        if (body.model.startsWith("ollama/")) {
          const model = body.model.slice("ollama/".length);
          if (!model || /[\r\n\0]/.test(model)) return error(res, 400, "invalid_model");
          body.model = model;
          req.body = Buffer.from(JSON.stringify(body));
          return next();
        }
        if (!body.model.startsWith("cloudflare/")) return next();

        if (Object.keys(body).some(key => !["model", "messages", "max_tokens", "temperature", "stream", "stream_options"].includes(key))) return error(res, 400, "unsupported_parameter");
        if (body.stream !== undefined && typeof body.stream !== "boolean") return error(res, 400, "invalid_request");
        const streaming = body.stream === true;
        let includeUsage = false;
        if (body.stream_options !== undefined) {
          if (!streaming || !body.stream_options || typeof body.stream_options !== "object" || Array.isArray(body.stream_options)) return error(res, 400, "invalid_request");
          const streamOptions = body.stream_options as Record<string, unknown>;
          if (Object.keys(streamOptions).some(key => key !== "include_usage") || streamOptions.include_usage !== undefined && typeof streamOptions.include_usage !== "boolean") return error(res, 400, "invalid_request");
          includeUsage = streamOptions.include_usage === true;
        }
        const model = body.model.slice("cloudflare/".length);
        if (hasUnsupportedMessages(body.messages)) return error(res, 400, "unsupported_parameter");
        const messages = validMessages(body.messages);
        if (!model || !messages || body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) < 1) ||
            body.temperature !== undefined && (typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) {
          return error(res, 400, "invalid_request");
        }
        const input: Record<string, unknown> = { messages };
        if (body.max_tokens !== undefined) input.max_tokens = Math.min(Number(body.max_tokens), 32_768);
        if (body.temperature !== undefined) input.temperature = body.temperature;
        let clientClosed = false;
        const onClientClose = () => { if (!res.writableEnded) clientClosed = true; };
        res.once("close", onClientClose);
        try {
          const raw = await cloudflare.run({ model, input }) as { result?: unknown };
          if (clientClosed || res.destroyed || res.writableEnded) return;
          const result = raw && typeof raw === "object" ? raw.result : undefined;
          const content = result && typeof result === "object" && !Array.isArray(result)
            ? (result as Record<string, unknown>).response : undefined;
          if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_RESPONSE_BYTES / 2) return error(res, 502, "invalid_provider_response");
          const usage = numericUsage(result && typeof result === "object" ? (result as Record<string, unknown>).usage : undefined);
          const completion = {
            id: `chatcmpl-${randomUUID()}`, object: "chat.completion", created: Math.floor(now() / 1000), model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            ...(usage ? { usage } : {}),
          };
          if (Buffer.byteLength(JSON.stringify(completion), "utf8") > MAX_RESPONSE_BYTES) return error(res, 502, "response_too_large");
          if (streaming) {
            sendSseCompletion(res, { id: completion.id, created: completion.created, model: completion.model, content, ...(usage ? { usage } : {}) }, includeUsage, () => clientClosed);
            return;
          }
          return res.json(completion);
        } catch (caught) {
          if (clientClosed || res.destroyed || res.writableEnded) return;
          if (caught instanceof CloudflareAIError) {
            const status = caught.code === "invalid_request" ? 400 : caught.code === "model_not_allowed" ? 403 : caught.code === "upstream_rejected" ? 502 : 503;
            return error(res, status, caught.code);
          }
          return error(res, 503, "cloudflare_inference_unavailable");
        } finally { res.off("close", onClientClose); }
      })().catch((caught: unknown) => next(caught));
    });
  });

  return { router, modelCredentials, cloudflareCredentials, cloudflareAdapter: cloudflare };
}
