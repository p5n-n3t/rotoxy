import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { StateStore } from "./store.js";
import { CloudflareAIAdapter, CloudflareAIError, CloudflareCredentialStore } from "./cloudflare-ai.js";
import { ModelCredentialStore } from "./model-credentials.js";

const OLLAMA_ORIGIN = "https://ollama.com";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CATALOG_ACCOUNTS = 100;
const MAX_CATALOG_MODELS = 1000;

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
  const cloudflare = options.cloudflareAdapter ?? new CloudflareAIAdapter(cloudflareCredentials);
  const ollamaFetch = options.ollamaFetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new RangeError("unified model API timeout is invalid");

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

      const cloudflareModels = (await cloudflareCredentials.listCredentials())
        .filter(account => account.enabled)
        .flatMap(account => account.allowedModels.map(model => `cloudflare/${model}`));
      const ollamaAccounts = (await modelCredentials.listCredentials())
        .filter(account => account.enabled && (account.cooldownUntil ?? 0) <= now());
      if (ollamaAccounts.length > MAX_CATALOG_ACCOUNTS) return error(res, 503, "ollama_catalog_account_limit");

      const ollamaModels = new Set<string>();
      let successfulCatalogs = 0;
      const catalogController = new AbortController();
      const catalogTimer = setTimeout(() => catalogController.abort(), timeoutMs);
      try {
        for (const account of ollamaAccounts) {
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
              ollamaModels.add(id); // Preserve the legacy raw model alias.
            }
          } catch { /* A failed account catalog is omitted; secrets and provider bodies stay private. */ }
          if (catalogController.signal.aborted) break;
        }
      } finally { clearTimeout(catalogTimer); }
      if (ollamaAccounts.length > 0 && successfulCatalogs === 0 && cloudflareModels.length === 0) return error(res, 503, "ollama_catalog_unavailable");
      const names = [...new Set([...cloudflareModels, ...ollamaModels])].slice(0, MAX_CATALOG_MODELS * 2);
      return res.json({ object: "list", data: names.map(id => ({ id, object: "model", owned_by: id.startsWith("cloudflare/") ? "cloudflare" : "ollama" })) });
    } catch { return error(res, 503, "model_catalog_unavailable"); }
  });

  const parseBody = express.raw({ type: "application/json", limit: MAX_REQUEST_BYTES });
  router.post("/v1/chat/completions", (req, res, next) => {
    parseBody(req, res, (parseError?: unknown) => {
      if (parseError) return error(res, 413, "request_too_large");
      void (async () => {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) return next();
        let body: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(req.body.toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return next();
          body = parsed as Record<string, unknown>;
        } catch { return next(); }
        if (typeof body.model !== "string" || body.model.length > 240) return next();
        if (body.model.startsWith("ollama/")) {
          const model = body.model.slice("ollama/".length);
          if (!model || /[\r\n\0]/.test(model)) return error(res, 400, "invalid_model");
          body.model = model;
          req.body = Buffer.from(JSON.stringify(body));
          return next();
        }
        if (!body.model.startsWith("cloudflare/")) return next();

        const token = bearer(req);
        if (!token || !await modelCredentials.authorizeToken(token, "model:invoke", now())) {
          res.setHeader("WWW-Authenticate", 'Bearer scope="model:invoke"');
          return error(res, 401, "unauthorized");
        }
        if (Object.keys(body).some(key => !["model", "messages", "max_tokens", "temperature", "stream"].includes(key))) return error(res, 400, "unsupported_parameter");
        if (body.stream === true) return error(res, 400, "streaming_not_supported");
        const model = body.model.slice("cloudflare/".length);
        const messages = validMessages(body.messages);
        if (!model || !messages || body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) < 1) ||
            body.temperature !== undefined && (typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) {
          return error(res, 400, "invalid_request");
        }
        const input: Record<string, unknown> = { messages };
        if (body.max_tokens !== undefined) input.max_tokens = Math.min(Number(body.max_tokens), 32_768);
        if (body.temperature !== undefined) input.temperature = body.temperature;
        try {
          const raw = await cloudflare.run({ model, input }) as { result?: unknown };
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
          return res.json(completion);
        } catch (caught) {
          if (caught instanceof CloudflareAIError) {
            const status = caught.code === "invalid_request" ? 400 : caught.code === "model_not_allowed" ? 403 : caught.code === "upstream_rejected" ? 502 : 503;
            return error(res, status, caught.code);
          }
          return error(res, 503, "cloudflare_inference_unavailable");
        }
      })().catch((caught: unknown) => next(caught));
    });
  });

  return { router, modelCredentials, cloudflareCredentials, cloudflareAdapter: cloudflare };
}
