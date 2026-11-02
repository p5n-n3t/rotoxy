import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { JobOperation, InferenceExecutor, InferenceRequest, InferenceResult } from "../job-worker.js";
import { CloudflareAIError, type CloudflareAIAdapter } from "../cloudflare-ai.js";

const ORACLE_ORIGIN = "http://100.114.191.111:8877";
const ORACLE_BODY_LIMIT = 128 * 1024;
const ORACLE_TOKEN = /^[A-Za-z0-9_-]{16,200}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function usage(value: unknown): Record<string, number> | undefined {
  if (!object(value)) return undefined;
  const out: Record<string, number> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "neurons"]) {
    const count = value[key];
    if (nonnegativeNumber(count) && (key === "neurons" || Number.isSafeInteger(count))) out[key] = count;
  }
  return Object.keys(out).length ? out : undefined;
}
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error("inference_response_missing_body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => undefined); throw new Error("inference_response_too_large"); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

/** Input committed by JobRegistry's run_inference outbox. */
export function inferenceRequest(operation: JobOperation): InferenceRequest | undefined {
  if (operation.kind !== "run_inference" || !/^[A-Za-z0-9_-]{16,128}$/.test(operation.operationId)) return undefined;
  const input = operation.input;
  if (Object.keys(input).sort().join(",") !== "dispatchAt,expectedMarker,maxOutputTokens,model,prompt,provider") return undefined;
  if ((input.provider !== "oracle" && input.provider !== "cloudflare") || typeof input.model !== "string" ||
      !input.model.trim() || input.model.length > 160 || typeof input.prompt !== "string" || !input.prompt.trim() ||
      Buffer.byteLength(input.prompt, "utf8") > 16_384 || typeof input.expectedMarker !== "string" ||
      !input.expectedMarker || /[\r\n\0]/.test(input.expectedMarker) ||
      typeof input.maxOutputTokens !== "number" || !Number.isSafeInteger(input.maxOutputTokens) ||
      input.maxOutputTokens < 1 || input.maxOutputTokens > 4096 ||
      typeof input.dispatchAt !== "number" || !Number.isFinite(input.dispatchAt)) return undefined;
  if (input.provider === "oracle" && !/^oracle\/[A-Za-z0-9._:-]{1,160}$/.test(input.model)) return undefined;
  if (input.provider === "cloudflare" && !/^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(input.model)) return undefined;
  return { operationId: operation.operationId, accountId: operation.selectedAccountId,
    provider: input.provider, model: input.model, prompt: input.prompt,
    maxOutputTokens: input.maxOutputTokens, expectedMarker: input.expectedMarker };
}

export class InferenceJobsAdapter implements InferenceExecutor {
  constructor(private readonly options: {
    cloudflare?: Pick<CloudflareAIAdapter, "runForAccountWithReceipt">;
    oracleTokenFile?: string;
    oracleAllowedHosts?: (accountId: string) => Promise<string[]>;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    now?: () => number;
  }) {
    const timeout = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 130_000) throw new RangeError("inference timeout is out of bounds");
    if (options.oracleTokenFile !== undefined && (!isAbsolute(options.oracleTokenFile) || options.oracleTokenFile.includes("\0"))) {
      throw new TypeError("Oracle token file path must be absolute");
    }
  }

  async invoke(request: InferenceRequest, signal?: AbortSignal): Promise<InferenceResult> {
    if (request.provider === "cloudflare") return this.cloudflare(request, signal);
    return this.oracle(request, signal);
  }

  private async cloudflare(request: InferenceRequest, signal?: AbortSignal): Promise<InferenceResult> {
    if (!this.options.cloudflare) return { classification: "rejected", accountId: request.accountId, reason: "cloudflare_executor_unavailable" };
    try {
      // This brackets the client request and response validation; it is not
      // provider-side scheduling or GPU execution time.
      const requestStartedAt = (this.options.now ?? Date.now)() / 1000;
      const receipt = await this.options.cloudflare.runForAccountWithReceipt(request.accountId, {
        model: request.model,
        input: { messages: [{ role: "user", content: `${request.prompt}\n\nFinish with this exact marker as the final nonempty line: ${request.expectedMarker}` }],
          max_tokens: request.maxOutputTokens, temperature: 0 },
      }, signal);
      const outer = object(receipt.result) ? receipt.result : undefined;
      const result = object(outer?.result) ? outer!.result as Record<string, unknown> : outer;
      const assistantText = result?.response;
      if (typeof assistantText !== "string" || !assistantText || Buffer.byteLength(assistantText, "utf8") > 32_768) {
        return { classification: "rejected", accountId: request.accountId, reason: "cloudflare_response_invalid" };
      }
      const rawFinish = result?.finish_reason ?? result?.finishReason;
      const finishReason = typeof rawFinish === "string" && rawFinish.length <= 64 ? rawFinish : undefined;
      const normalizedFinish = finishReason?.toLowerCase().replace(/[\s-]+/g, "_");
      if (["length", "max_tokens", "max_output_tokens", "token_limit", "max_token_limit", "truncated", "incomplete"].includes(normalizedFinish ?? "")) {
        return { classification: "ambiguous", accountId: request.accountId, reason: "cloudflare_response_truncated" };
      }
      const finalNonemptyLine = assistantText.split(/\r?\n/).filter((line) => line.trim().length > 0).at(-1);
      if (finalNonemptyLine !== request.expectedMarker) {
        return { classification: "ambiguous", accountId: request.accountId, reason: "cloudflare_completion_marker_missing" };
      }
      return { classification: "accepted", accountId: request.accountId,
        value: { assistantText, reportedModel: null, modelEvidence: "pinned_endpoint",
          terminationEvidence: "expected_marker", ...(finishReason ? { finishReason } : {}),
          requestStartedAt,
          assistantAt: (this.options.now ?? Date.now)() / 1000,
          providerAccountId: receipt.providerAccountId,
          ...(usage(result?.usage) ? { providerUsage: usage(result?.usage) } : {}) } };
    } catch (error) {
      return { classification: "ambiguous", accountId: request.accountId,
        reason: error instanceof CloudflareAIError ? error.code : "cloudflare_inference_ambiguous" };
    }
  }

  private async oracle(request: InferenceRequest, parentSignal?: AbortSignal): Promise<InferenceResult> {
    if (!this.options.oracleAllowedHosts) return { classification: "rejected", accountId: request.accountId, reason: "oracle_host_policy_unavailable" };
    let allowedHosts: string[];
    try { allowedHosts = await this.options.oracleAllowedHosts(request.accountId); }
    catch { allowedHosts = []; }
    if (!Array.isArray(allowedHosts) || allowedHosts.length < 1 || allowedHosts.length > 6 ||
        new Set(allowedHosts).size !== allowedHosts.length || allowedHosts.some(host => !/^ora(?:1|3|5|6|7|8)$/.test(host))) {
      return { classification: "rejected", accountId: request.accountId, reason: "oracle_host_policy_unavailable" };
    }
    const tokenFile = this.options.oracleTokenFile ?? process.env.ROTOXY_ORACLE_API_TOKEN_FILE;
    if (!tokenFile || !isAbsolute(tokenFile)) return { classification: "rejected", accountId: request.accountId, reason: "oracle_api_not_configured" };
    let token: string;
    try {
      const info = await lstat(tokenFile);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 4096) throw new Error();
      token = (await readFile(tokenFile, "utf8")).trim();
      if (!ORACLE_TOKEN.test(token)) throw new Error();
    } catch { return { classification: "rejected", accountId: request.accountId, reason: "oracle_credential_unavailable" }; }

    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    let dispatched = false;
    try {
      dispatched = true;
      const requestStartedAt = (this.options.now ?? Date.now)() / 1000;
      const response = await (this.options.fetch ?? globalThis.fetch)(ORACLE_ORIGIN + "/v1/chat/completions", {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model: request.model.slice("oracle/".length), stream: false,
          max_tokens: request.maxOutputTokens, allowed_hosts: allowedHosts, messages: [{ role: "user", content:
            `${request.prompt}\n\nFinish with this exact marker as the final nonempty line: ${request.expectedMarker}` }] }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // The API's 408/5xx responses can arrive after it dispatched to Ollama.
        // Keep that outcome ambiguous so the durable job is not marked as a
        // definite rejection and never replay this inference automatically.
        const preflightRejections = new Set([400, 401, 403, 404, 422, 429]);
        const classification = preflightRejections.has(response.status) ? "rejected" : "ambiguous";
        return { classification, accountId: request.accountId, reason: `oracle_http_${response.status}` };
      }
      const bytes = await boundedBody(response, ORACLE_BODY_LIMIT);
      let body: unknown;
      try { body = JSON.parse(bytes.toString("utf8")); } catch { return { classification: "ambiguous", accountId: request.accountId, reason: "oracle_response_invalid" }; }
      if (!object(body) || body.model !== request.model.slice("oracle/".length) || !Array.isArray(body.choices) || !object(body.choices[0])) {
        return { classification: "ambiguous", accountId: request.accountId, reason: "oracle_response_invalid" };
      }
      const choice = body.choices[0] as Record<string, unknown>;
      const message = object(choice.message) ? choice.message.content : undefined;
      if (typeof message !== "string" || !message || Buffer.byteLength(message, "utf8") > 32_768 ||
          typeof choice.finish_reason !== "string" || choice.finish_reason.length > 64) {
        return { classification: "ambiguous", accountId: request.accountId, reason: "oracle_response_incomplete" };
      }
      const providerHost = response.headers.get("x-oracle-host");
      if (!providerHost || !allowedHosts.includes(providerHost)) return { classification: "ambiguous", accountId: request.accountId, reason: "oracle_worker_attribution_invalid" };
      return { classification: "accepted", accountId: request.accountId,
        value: { assistantText: message, reportedModel: request.model, modelEvidence: "provider_reported",
          finishReason: choice.finish_reason, terminationEvidence: "provider_finish",
          requestStartedAt,
          assistantAt: (this.options.now ?? Date.now)() / 1000,
          providerHost,
          ...(usage(body.usage) ? { providerUsage: usage(body.usage) } : {}) } };
    } catch {
      return { classification: dispatched ? "ambiguous" : "rejected", accountId: request.accountId,
        reason: controller.signal.aborted ? "oracle_timeout_ambiguous" : "oracle_request_ambiguous" };
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    }
  }
}

export type { InferenceRequest, InferenceResult } from "../job-worker.js";
