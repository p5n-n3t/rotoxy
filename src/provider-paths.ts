import express, { type Request, type RequestHandler, type Response } from "express";

const MAX_BODY_BYTES = 64 * 1024;
const PATHS = Object.freeze({
  ollama: { modelPrefix: "ollama/", protocol: "OpenAI-compatible", availability: "implemented" },
  cloudflare: { modelPrefix: "cloudflare/", protocol: "OpenAI-compatible", availability: "implemented" },
  openai: { modelPrefix: "openai/", protocol: "OpenAI-compatible", availability: "implemented" },
  openrouter: { modelPrefix: "openrouter/", protocol: "OpenAI-compatible", availability: "implemented" },
} as const);

const PENDING = Object.freeze([
  { id: "claude", protocol: "Anthropic Messages", availability: "separate-opt-in-adapter", path: "/providers/claude/v1/messages", reason: "Requires the Bedrock Messages adapter and its operator-configured credentials. Claude Code itself is a CLI agent, not an inference HTTP endpoint." },
  { id: "anthropic", protocol: "Anthropic Messages", availability: "unavailable", reason: "No direct Anthropic API adapter is configured here." },
  { id: "codex", protocol: "Codex App Server", availability: "unavailable", reason: "Saved Codex profiles do not yet have direct provider-path dispatch." },
  { id: "oracle", protocol: "Ollama / OpenAI-compatible (per-node routing pending)", availability: "unavailable", reason: "Oracle worker pool inference is not exposed through the unified model API." },
  { id: "lightsprint", protocol: "Workspace jobs", availability: "unavailable", reason: "LightSprint is a workspace provider, not a model-inference adapter." },
]);

function error(res: Response, status: number, code: string): void {
  res.status(status).type("application/json").json({ error: { message: code, type: "provider_path_error", code } });
}

/**
 * Provider-pinned aliases for clients that need a conventional model API.
 * Mount at the gateway root before the unified model router. It rewrites only
 * exact provider paths and delegates to the very same router, preserving its
 * scoped bearer authorization, credentials and adapters. `next` continues in
 * the application stack when Ollama hands the request to the legacy gateway.
 */
export function createProviderPathApi(unifiedRouter: RequestHandler) {
  const router = express.Router();
  router.get("/providers", (_req, res) => res.json({
    object: "provider_path_directory",
    providers: [
      ...Object.entries(PATHS).map(([id, value]) => ({ id, path: `/providers/${id}/v1`, protocol: value.protocol, modelPrefix: value.modelPrefix, availability: value.availability })),
      { id: "custom-openai-compatible", path: "/providers/custom-<24-char-id>/v1", protocol: "OpenAI-compatible", modelPrefix: "<custom-id>/", availability: "configured-providers" },
      ...PENDING.map(provider => ({ ...provider, path: "path" in provider ? provider.path : `/providers/${provider.id}` })),
    ],
  }));

  router.use((req, res, next) => {
    const match = /^\/providers\/([A-Za-z0-9_-]+)\/v1\/(models|chat\/completions)$/.exec(req.path);
    if (!match) return next();
    const routeId = match[1]!;
    const builtInId = routeId.toLowerCase();
    const customProvider = /^custom-([A-Za-z0-9_-]{24})$/.exec(routeId);
    const id = customProvider ? routeId : builtInId;
    const config = customProvider
      ? { modelPrefix: `${routeId}/`, protocol: "OpenAI-compatible", availability: "implemented" }
      : PATHS[builtInId as keyof typeof PATHS];
    if (!config) {
      // The Anthropic Messages adapter owns this namespace and is mounted
      // before this middleware. Leave it untouched if that adapter is absent.
      if (id === "claude") return next();
      const pending = PENDING.find(provider => provider.id === id);
      return error(res, pending ? 501 : 404, pending ? "provider_path_unavailable" : "provider_not_found");
    }

    const endpoint = match[2]!;
    const downstreamPath = endpoint === "models" ? "/v1/models" : "/v1/chat/completions";
    if (req.method === "GET" && endpoint === "models") {
      const originalJson = res.json.bind(res);
      res.setHeader("X-Rotoxy-Provider-Path", id);
      res.json = ((body: unknown) => {
        if (body && typeof body === "object" && !Array.isArray(body)) {
          const record = body as Record<string, unknown>;
          if (Array.isArray(record.data)) {
            return originalJson({ ...record, data: record.data.filter(item => {
              if (!item || typeof item !== "object" || Array.isArray(item)) return false;
              const modelId = (item as Record<string, unknown>).id;
              return typeof modelId === "string" && modelId.startsWith(config.modelPrefix);
            }) });
          }
        }
        return originalJson(body);
      }) as typeof res.json;
      req.url = downstreamPath;
      return unifiedRouter(req, res, next);
    }
    if (req.method !== "POST" || endpoint !== "chat/completions") return error(res, 404, "provider_path_endpoint_not_found");

    express.raw({ type: "application/json", limit: MAX_BODY_BYTES })(req, res, parseError => {
      if (parseError) return error(res, 413, "request_too_large");
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return error(res, 400, "invalid_request");
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(req.body.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return error(res, 400, "invalid_request");
        body = parsed as Record<string, unknown>;
      } catch { return error(res, 400, "invalid_request"); }
      if (typeof body.model !== "string" || !body.model.startsWith(config.modelPrefix) || body.model.length <= config.modelPrefix.length) {
        return error(res, 400, "provider_model_mismatch");
      }
      // Keep the raw request body intact. The unified API performs authorization
      // and validates the actual provider payload before dispatch.
      res.setHeader("X-Rotoxy-Provider-Path", id);
      req.url = downstreamPath;
      return unifiedRouter(req, res, next);
    });
  });

  return router;
}
