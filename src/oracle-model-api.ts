import express from "express";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ModelCredentialStore } from "./model-credentials.js";
import type { StateStore } from "./store.js";

const ORIGIN = "http://100.114.191.111:8877";
const LIMIT = 128 * 1024;
type Options = { tokenFile?: string; fetch?: typeof fetch };

/** Fixed private Oracle origin. No caller-controlled URL, upstream key or retry. */
export function createOracleModelApi(store: StateStore, options: Options = {}) {
  const router = express.Router();
  const credentials = new ModelCredentialStore(store);
  const tokenFile = options.tokenFile ?? process.env.ROTOXY_ORACLE_API_TOKEN_FILE;
  const fetchImpl = options.fetch ?? fetch;
  let inflight = 0;
  router.all(["/providers/oracle/v1/models", "/providers/oracle/v1/chat/completions"], async (req, res) => {
    const catalog = req.path.endsWith("/models");
    const fail = (status: number, code: string) => res.status(status).json({ error: { type: "oracle_gateway_error", message: code } });
    res.setHeader("Cache-Control", "no-store");
    if ((catalog && req.method !== "GET") || (!catalog && req.method !== "POST")) return fail(405, "method_not_allowed");
    const bearer = /^Bearer ([^\s]{1,128})$/i.exec(req.header("authorization") ?? "")?.[1];
    if (!bearer || !await credentials.authorizeToken(bearer, catalog ? "model:read" : "model:invoke")) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return fail(401, "scoped_model_token_required");
    }
    if (!tokenFile || !isAbsolute(tokenFile)) return fail(503, "oracle_api_not_configured");
    let upstreamToken: string;
    try {
      const stat = await lstat(tokenFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 4096) throw Error();
      upstreamToken = (await readFile(tokenFile, "utf8")).trim();
      if (!/^[A-Za-z0-9_-]{16,200}$/.test(upstreamToken)) throw Error();
    } catch { return fail(503, "oracle_credential_unavailable"); }
    if (inflight >= 5) return fail(429, "oracle_gateway_busy");
    inflight++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 130_000);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", disconnected);
    try {
      let body: string | undefined;
      if (!catalog) {
        const parsed = await new Promise<unknown>((resolve, reject) => {
          express.json({ limit: "48kb" })(req, res, error => error ? reject(error) : resolve(req.body));
        });
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "invalid_request");
        const data = parsed as Record<string, unknown>;
        if (typeof data.model !== "string" || !/^oracle\/[A-Za-z0-9._:-]{1,160}$/.test(data.model)) return fail(400, "oracle_model_prefix_required");
        if (data.stream === true) return fail(400, "streaming_not_supported");
        body = JSON.stringify({ ...data, model: data.model.slice(7) });
      }
      const response = await fetchImpl(ORIGIN + (catalog ? "/v1/models" : "/v1/chat/completions"), {
        method: catalog ? "GET" : "POST", redirect: "error", signal: controller.signal,
        headers: { authorization: "Bearer " + upstreamToken, "content-type": "application/json" }, body,
      });
      if (!response.ok) { await response.body?.cancel(); return fail([400,401,403,404,422,429,503].includes(response.status) ? response.status : 502, "oracle_upstream_rejected"); }
      const reader = response.body?.getReader();
      if (!reader) return fail(502, "oracle_response_invalid");
      const chunks: Uint8Array[] = []; let bytes = 0;
      try { while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.length;
        if (bytes > LIMIT) { await reader.cancel(); return fail(502, "oracle_response_too_large"); }
        chunks.push(part.value);
      } } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (catalog) {
        if (!Array.isArray(data?.data)) return fail(502, "oracle_catalog_invalid");
        data.data = data.data.slice(0, 100).filter((m: any) => typeof m?.id === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(m.id)).map((m: any) => ({ id: "oracle/" + m.id, object: "model", owned_by: "oracle" }));
      } else {
        if (typeof data?.model !== "string" || !Array.isArray(data.choices)) return fail(502, "oracle_response_invalid");
        data.model = "oracle/" + data.model;
      }
      return res.json(data);
    } catch (error: any) {
      if (res.destroyed || res.writableEnded) return;
      return fail(error?.type === "entity.too.large" ? 413 : controller.signal.aborted ? 504 : 502, controller.signal.aborted ? "oracle_timeout_reconcile_before_retry" : "oracle_request_failed");
    } finally { clearTimeout(timeout); res.off("close", disconnected); inflight--; }
  });
  return router;
}
