import { createHash } from "node:crypto";
import { evaluateToolCall } from "../tool-policy.js";
import { PROVIDER_PROFILES } from "../provider-capabilities.js";
import { readBodyLimited, serverMessages } from "../jsonrpc-wire.js";
import type { StateStore } from "../store.js";
import type { UpstreamAccount } from "../types.js";
import { LightSprintWorkspaceContract } from "./lightsprint-workspace-contract.js";

export type JobProvider = "claude" | "codex" | "auto" | "pi";
export type JobClassification = "accepted" | "rejected" | "ambiguous";
export type JobReason = "auth" | "quota" | "rate_limit" | "not_found" | "account_unavailable" | "provider_mismatch" | "endpoint_mismatch" | "tool_error" | "protocol_error" | "transport_ambiguous" | "identity_mismatch" | "instructions_mismatch" | "response_too_large" | "policy_denied";

export interface JobResult<T = unknown> {
  classification: JobClassification;
  accountId: string;
  value?: T;
  reason?: JobReason;
  httpStatus?: number;
  /** A reported field only. LightSprint cannot be asked to use an exact model or branch. */
  reportedModel?: string;
  reportedBranchName?: string;
  instructionsVerified?: boolean;
}

export interface LightSprintMcpClient {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Optional local disposal; implementations must not send another request. */
  close?(): void | Promise<void>;
}

export interface LightSprintMcpClientOptions {
  endpoint: URL;
  token: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}

export type LightSprintMcpClientFactory = (options: LightSprintMcpClientOptions) => LightSprintMcpClient | Promise<LightSprintMcpClient>;

export interface LightSprintJobsOptions {
  fetch?: typeof globalThis.fetch;
  clientFactory?: LightSprintMcpClientFactory;
  timeoutMs?: number;
  /** Single-use authorization for one exact claimed chat POST when the global policy denies it. Never used by other adapter methods. */
  trustedChatMutationPermit?: (request: Readonly<{ method: "POST"; path: string; body: Readonly<{ message: string; clientMessageId: string }> }>) => boolean;
  /**
   * Single-use authorization for one internal fresh-provisioning mutation.
   * It is deliberately narrower than the raw tool policy: only the task
   * create, instruction patch, or documented launch request constructed from
   * a durably claimed operation can present this permit.
   */
  trustedFreshMutationPermit?: (request: Readonly<{ method: "POST" | "PATCH"; path: string; body: Readonly<Record<string, unknown>> }>) => boolean;
  /** Explicit internal authorization. Catalog discovery alone never grants policy bypass. */
  trustedWorkspacePermit?: (request: Readonly<{ accountId: string; workspaceId: string; method: string; path: string; body?: Readonly<Record<string, unknown>> }>) => boolean;
}

export type ProvisioningContractFamily = "legacy-task" | "workspace-task" | "unknown";
export interface ProvisioningContractDiscovery {
  accountId: string;
  family: ProvisioningContractFamily;
  descriptionSha256: string | null;
  launchRouteAvailable: boolean;
  listRouteAvailable: boolean;
  /** Generic model/effort wording does not establish exact-pin semantics. */
  modelPin: "unknown" | "unsupported";
  effortPin: "unknown" | "unsupported";
  status: "documented" | "unknown" | "unavailable";
  /** Account-scoped workspace declared by this credential's own MCP catalog. */
  workspaceId?: string;
  reason?: "catalog_missing" | "catalog_malformed" | "contract_unrecognized" | "auth_failed" | "transport_failed" | "account_unavailable" | "catalog_unavailable";
}

const MAX_MCP_RESPONSE_BYTES = 1_048_576;
const MAX_TRANSCRIPT_PROJECTION_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_PREVIEW_BYTES = 8 * 1024;
const MAX_PROJECTED_MESSAGE_BYTES = 64 * 1024;
const MAX_MESSAGE_CONTENT_BYTES = 48 * 1024;
const MAX_RECENT_TRANSCRIPT_MESSAGES = 100;
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 500;
const MAX_INSTRUCTIONS_LENGTH = 20_000;
const MAX_MESSAGE_LENGTH = 50_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// Provider-generated session IDs may begin with '_' or '-'; neither is a path separator.
const SESSION_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_-]{0,127}$/;
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDERS = new Set<JobProvider>(["claude", "codex", "auto", "pi"]);
const MAX_DISCOVERY_PAGES = 8;
const MAX_DISCOVERY_TOOLS = 256;
const MAX_DISCOVERY_DESCRIPTION_BYTES = 128 * 1024;
const MAX_DISCOVERY_CURSOR_LENGTH = 512;

function catalogWorkspaceId(description: string): string | undefined {
  const matches = [...description.matchAll(/(?:^|\n)\s*workspaceId\s*=\s*([A-Za-z0-9_-]{1,128})\s*(?=\n|$)/g)]
    .map((match) => match[1]!);
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : undefined;
}

const LEGACY_LAUNCH_ROUTE = "/api/tasks/{taskId}/lightsprint-agents/{claude|codex|auto|pi}";
const LEGACY_LIST_ROUTE = "/api/tasks/{taskId}/lightsprint-agents";
const WORKSPACE_LAUNCH_ROUTE = "/api/agent-sessions";
const WORKSPACE_LIST_ROUTE = "/api/agent-sessions";

class HttpStatusError extends Error {
  constructor(readonly status: number) { super("LightSprint HTTP response"); }
}
class ResponseTooLargeError extends Error {}
class AccountUnavailableError extends Error {
  constructor(readonly reason: "account_unavailable" | "provider_mismatch" | "endpoint_mismatch") { super("LightSprint account is not eligible"); }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasDocumentedRoute(description: string, method: "GET" | "POST", route: string): boolean {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${method}\\s+${escaped}(?=$|[\\s\\x60,;?.)])`, "i").test(description);
}

function unknownDiscovery(
  accountId: string,
  reason: ProvisioningContractDiscovery["reason"],
  descriptionSha256: string | null = null,
): ProvisioningContractDiscovery {
  return {
    accountId, family: "unknown", descriptionSha256,
    launchRouteAvailable: false, listRouteAvailable: false,
    modelPin: "unknown", effortPin: "unknown", status: "unknown", reason,
  };
}

function failedDiscovery(accountId: string, error: unknown): ProvisioningContractDiscovery {
  if (error instanceof AccountUnavailableError) return {
    ...unknownDiscovery(accountId, "account_unavailable"), status: "unavailable",
  };
  const candidate = record(error);
  const status = error instanceof HttpStatusError ? error.status
    : candidate && Object.hasOwn(candidate, "status") && typeof candidate.status === "number" ? candidate.status
      : candidate && Object.hasOwn(candidate, "statusCode") && typeof candidate.statusCode === "number" ? candidate.statusCode
        : undefined;
  if (status === 401 || status === 403) return {
    ...unknownDiscovery(accountId, "auth_failed"), status: "unavailable",
  };
  if (error instanceof JsonRpcFailure || error instanceof ResponseTooLargeError) return {
    ...unknownDiscovery(accountId, "catalog_unavailable"), status: "unavailable",
  };
  return { ...unknownDiscovery(accountId, "transport_failed"), status: "unavailable" };
}

function validateId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || !ID_RE.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}
function validateSessionId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || !SESSION_ID_RE.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}
function validateText(value: unknown, label: string, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${label} is invalid`);
  }
}
function validateEndpoint(endpoint: URL): URL {
  const expected = new URL(PROVIDER_PROFILES.lightsprint.defaultServerUrl);
  if (endpoint.protocol !== "https:" || endpoint.origin !== expected.origin || endpoint.pathname !== "/mcp" ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("unsafe LightSprint MCP endpoint configuration");
  }
  return endpoint;
}

/** URL parser canonicalization permits equivalent spelling but no query, fragment, path, or authority variation. */
function isCanonicalNativeLightSprintUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const actual = new URL(value);
    const expected = new URL(PROVIDER_PROFILES.lightsprint.defaultServerUrl);
    return actual.protocol === "https:" && actual.hostname === expected.hostname && actual.port === "" &&
      actual.pathname === "/mcp" && !actual.username && !actual.password && !actual.search && !actual.hash &&
      actual.href === expected.href;
  } catch {
    return false;
  }
}

/** Streamable-HTTP client following this repository's JSON/SSE parser and session header conventions. */
export function createLightSprintMcpClient(options: LightSprintMcpClientOptions): LightSprintMcpClient {
  const endpoint = validateEndpoint(options.endpoint);
  let token = options.token;
  let nextId = 0;
  let sessionId: string | undefined;
  let initializePromise: Promise<void> | undefined;

  const post = async (message: Record<string, unknown>, notification = false): Promise<unknown> => {
    const headers = new Headers({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    });
    if (sessionId) headers.set("mcp-session-id", sessionId);
    const response = await options.fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: "error",
    });
    if (!response.ok) throw new HttpStatusError(response.status);
    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession) sessionId = returnedSession;
    if (notification && (response.status === 202 || response.status === 204)) return undefined;
    const body = await readBodyLimited(response, MAX_MCP_RESPONSE_BYTES);
    if (body === undefined) throw new ResponseTooLargeError();
    const messages = serverMessages(response.headers.get("content-type"), body.toString("utf8"));
    const id = message.id;
    const matched = messages.find((item) => item.id === id);
    if (!matched) throw new Error("missing matching JSON-RPC response");
    if (matched.error) throw new JsonRpcFailure();
    return matched.result;
  };

  const ensureInitialized = (): Promise<void> => {
    if (!initializePromise) {
      initializePromise = (async () => {
        await post({
          jsonrpc: "2.0",
          id: ++nextId,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "token2oauth-lightsprint-jobs", version: "0.1.0" },
          },
        });
        await post({ jsonrpc: "2.0", method: "notifications/initialized" }, true);
      })();
    }
    return initializePromise;
  };

  return {
    async request(method, params = {}) {
      await ensureInitialized();
      return post({ jsonrpc: "2.0", id: ++nextId, method, params });
    },
    close() {
      // Drop local session and credential references; disposal performs no I/O.
      sessionId = undefined;
      token = "";
      initializePromise = undefined;
    },
  };
}

class JsonRpcFailure extends Error {}

function extractStatus(value: unknown, depth = 0): number | undefined {
  if (depth > 5) return undefined;
  const obj = record(value);
  if (!obj) return undefined;
  for (const key of ["httpStatus", "statusCode", "status"]) {
    const status = obj[key];
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  for (const child of Object.values(obj)) {
    const found = extractStatus(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}
function parseToolValue(raw: unknown): { value: unknown; isError: boolean; status?: number } {
  const obj = record(raw);
  const content = Array.isArray(obj?.content) ? obj.content : [];
  let parsedText: unknown;
  for (const part of content) {
    const text = record(part)?.text;
    if (typeof text !== "string") continue;
    try { parsedText = JSON.parse(text); break; } catch { /* retain only below */ }
  }
  const value = obj?.structuredContent ?? parsedText ?? raw;
  const status = extractStatus(value) ?? (parsedText === undefined ? undefined : extractStatus(parsedText));
  const payload = record(value);
  const isError = obj?.isError === true || Boolean(status) || Boolean(payload && ("error" in payload) && !("id" in payload));
  return { value, isError, status };
}
function reasonForStatus(status: number): JobReason {
  if (status === 401) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limit";
  if (status === 404) return "not_found";
  return "tool_error";
}
function findField(value: unknown, names: string[], depth = 0): unknown {
  if (depth > 6) return undefined;
  const obj = record(value);
  if (!obj) return undefined;
  for (const name of names) if (Object.hasOwn(obj, name)) return obj[name];
  for (const child of Object.values(obj)) {
    const found = findField(child, names, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}
function taskIdentityMatches(value: unknown, expected: string): boolean {
  const root = record(value);
  const task = record(root?.task) ?? root;
  if (!task) return false;
  const canonicalKeys = ["id", "taskId", "providerTaskId"].filter(key => Object.hasOwn(task, key));
  if (canonicalKeys.length) return canonicalKeys.every(key => typeof task[key] === "string" && task[key] === expected);
  return ["taskRef", "ref"].some(key => task[key] === expected);
}
function taskIdentity(value: unknown): string | undefined {
  const root = record(value);
  const task = record(root?.task) ?? root;
  if (!task) return undefined;
  const canonicalKeys = ["id", "taskId", "providerTaskId"].filter(key => Object.hasOwn(task, key));
  if (canonicalKeys.length) {
    const values = canonicalKeys.map(key => task[key]);
    return values.every(item => typeof item === "string" && item === values[0]) ? values[0] as string : undefined;
  }
  const reference = ["taskRef", "ref"].find(key => typeof task[key] === "string");
  return reference ? task[reference] as string : undefined;
}
function boundedPreview(value: unknown): string {
  const chunks: string[] = [];
  const seen = new WeakSet<object>();
  let used = 0;
  let truncated = false;
  const append = (text: string) => {
    if (truncated) return;
    let prefix = "";
    for (const char of text) {
      const size = Buffer.byteLength(char, "utf8");
      if (used + size > MAX_TRANSCRIPT_PREVIEW_BYTES) { truncated = true; break; }
      prefix += char;
      used += size;
    }
    if (prefix) chunks.push(prefix);
  };
  const visit = (item: unknown, depth: number): void => {
    if (truncated) return;
    if (item === null || typeof item === "boolean" || typeof item === "number") {
      append(JSON.stringify(item));
      return;
    }
    if (typeof item === "string") {
      const sample = item.slice(0, 256);
      append(JSON.stringify(sample));
      if (sample.length < item.length) truncated = true;
      return;
    }
    if (typeof item !== "object" || depth >= 4 || seen.has(item)) { append("[omitted]"); return; }
    seen.add(item);
    if (Array.isArray(item)) {
      append("[");
      for (const entry of item.slice(0, 20)) { visit(entry, depth + 1); append(","); }
      if (item.length > 20) truncated = true;
      append("]");
      return;
    }
    append("{");
    let count = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (count >= 20) { truncated = true; break; }
      count += 1;
      append(JSON.stringify(key.slice(0, 80)) + ":");
      visit((item as Record<string, unknown>)[key], depth + 1);
      append(",");
      if (truncated) break;
    }
    append("}");
  };
  visit(value, 0);
  if (truncated) {
    const marker = "[preview truncated]";
    while (chunks.length && used + Buffer.byteLength(marker) > MAX_TRANSCRIPT_PREVIEW_BYTES) {
      const last = chunks.pop();
      if (last) used -= Buffer.byteLength(last);
    }
    chunks.push(marker);
  }
  return chunks.join("");
}

function projectMessage(source: unknown): { message: Record<string, unknown>; contentComplete: boolean; toolPayloadOmitted: boolean } {
  const input = record(source) || {};
  const message: Record<string, unknown> = {};
  let complete = true;
  const role = input.role;
  if (typeof role === "string" && role.length <= 64) message.role = role;
  else { message.role = "unknown"; complete = false; }
  for (const key of ["id", "timestamp", "createdAt", "created_at", "time", "date"]) {
    const value = input[key];
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") <= 128) message[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) message[key] = value;
    else if (value !== undefined) complete = false;
  }
  const toolPayloadOmitted = message.role === "tool" || (typeof message.role === "string" && message.role.startsWith("tool:"));
  if (toolPayloadOmitted) {
    message.contentOmitted = "tool_payload";
    complete = false;
  } else {
    const content = input.content;
    let projected: unknown;
    let canPreserve = true;
    let contentBytes = 0;
    if (typeof content === "string") {
      contentBytes = Buffer.byteLength(content, "utf8");
      if (contentBytes <= MAX_MESSAGE_CONTENT_BYTES) projected = content;
      else canPreserve = false;
    } else if (Array.isArray(content) && content.length <= 64) {
      const blocks: unknown[] = [];
      for (const block of content) {
        if (typeof block === "string") {
          contentBytes += Buffer.byteLength(block, "utf8");
          blocks.push(block);
        } else {
          const part = record(block);
          if (!part || part.type !== "text" || typeof part.text !== "string") { canPreserve = false; break; }
          contentBytes += Buffer.byteLength(part.text, "utf8");
          blocks.push({ type: "text", text: part.text });
        }
        if (contentBytes > MAX_MESSAGE_CONTENT_BYTES) { canPreserve = false; break; }
      }
      if (canPreserve) projected = blocks;
    } else {
      canPreserve = false;
    }
    if (canPreserve) {
      message.content = projected;
    } else {
      message.contentOmitted = contentBytes > MAX_MESSAGE_CONTENT_BYTES ? "oversized" : "unsupported_content_shape";
      complete = false;
    }
  }
  message.complete = complete;
  if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_PROJECTED_MESSAGE_BYTES) {
    // Do not keep a partial assistant marker if the complete message exceeds its per-message bound.
    delete message.content;
    message.contentOmitted = "oversized";
    message.complete = false;
    complete = false;
  }
  return { message, contentComplete: complete, toolPayloadOmitted };
}

/** Documented token transcript shape: newest page, ascending seq, typed items.
 * Never include user prompts, tool inputs or outputs in our completion projection.
 * A snapshot is only a candidate result when it is the last event of the newest
 * user turn on the page. Older-page pagination needs explicit policy approval. */
function projectTokenTranscript(value: Record<string, unknown>): unknown {
  const items = value.items;
  if (!Array.isArray(items)) return undefined;
  const recent = items.slice(-MAX_RECENT_TRANSCRIPT_MESSAGES);
  // Historical compaction/metadata records need not have message identifiers.
  // Only the suffix beginning at the newest user instruction can complete work.
  const boundary = recent.findLastIndex(x => record(x)?.type === "user_message");
  const bounded = boundary < 0 ? recent : recent.slice(boundary);
  const valid = bounded.every((x) => {
    const item = record(x);
    return item && Number.isSafeInteger(item.seq) && Number(item.seq) >= 0 &&
      typeof item.turnId === "string" && ID_RE.test(item.turnId) &&
      typeof item.type === "string" && typeof item.time === "string";
  });
  const more = value.hasMore === true || items.length > bounded.length;
  const cursor = (key: "nextCursor" | "prevCursor") => {
    const n = value[key];
    return Number.isSafeInteger(n) && Number(n) >= 0 ? n as number : null;
  };
  const base = {
    shape: "items", sourceItemCount: items.length, truncated: more,
    hasMore: value.hasMore === true, nextCursor: cursor("nextCursor"), prevCursor: cursor("prevCursor"),
  };
  if (!valid || bounded.some((item, index) => index > 0 && Number(record(item)?.seq) <= Number(record(bounded[index - 1])?.seq))) return { ...base, messages: [], incomplete: true, latestAssistantIndex: null,
    latestAssistantComplete: false, reason: "invalid_items" };
  // The current page must contain the most recent user turn for exact turn
  // association; a snapshot from an earlier turn cannot finish a newer job.
  const lastUserIndex = bounded.findLastIndex(x => record(x)?.type === "user_message");
  if (lastUserIndex < 0) return { ...base, messages: [], incomplete: true,
    latestAssistantIndex: null, latestAssistantComplete: false, reason: "missing_user_turn" };
  const user = record(bounded[lastUserIndex])!;
  const turn = user.turnId;
  const userContent = record(user.payload)?.content;
  const lastUserTextSha256 = typeof userContent === "string"
    ? createHash("sha256").update(userContent).digest("hex") : null;
  const later = bounded.slice(lastUserIndex + 1).map(record);
  const lastItem = later.at(-1);
  // Live token transcripts give user and assistant items different turnId values.
  // Sequence ordering and the exact newest user-text hash establish the boundary.
  const candidate = lastItem && lastItem.type === "assistant_snapshot" &&
    Number(lastItem.seq) > Number(user.seq) && Date.parse(String(lastItem.time)) >= Date.parse(String(user.time)) ? lastItem : undefined;
  if (!candidate) return { ...base, messages: [], incomplete: true,
    latestAssistantIndex: null, latestAssistantComplete: false, reason: "no_terminal_snapshot" };
  const payload = record(candidate.payload);
  const projected = projectMessage({ role: "assistant", content: payload?.content,
    timestamp: candidate.time });
  if (!projected.contentComplete) return { ...base, messages: [], incomplete: true,
    latestAssistantIndex: null, latestAssistantComplete: false, reason: "incomplete_snapshot" };
  const result = { ...base, messages: [{ ...projected.message, turnId: turn, seq: candidate.seq }],
    incomplete: false, latestAssistantIndex: 0, latestAssistantComplete: true,
    lastUserTextSha256 };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_TRANSCRIPT_PROJECTION_BYTES) {
    return { ...base, messages: [], incomplete: true, latestAssistantIndex: null,
      latestAssistantComplete: false, reason: "projection_limit_exceeded" };
  }
  return result;
}

/** Recent-message view with a stable latest-assistant pointer; never serializes the source transcript wholesale. */
function boundedTranscript(value: unknown): unknown {
  const transcript = record(value);
  if (transcript && Array.isArray(transcript.items)) return projectTokenTranscript(transcript);
  const messages = transcript?.messages;
  if (!Array.isArray(messages)) {
    return {
      shape: "unknown",
      truncated: true,
      incomplete: true,
      latestAssistantComplete: false,
      preview: "[unsupported transcript shape; contents withheld]",
    };
  }

  let latestAssistantSourceIndex = -1;
  let omittedToolContentCount = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = record(messages[index])?.role;
    if (role === "assistant" && latestAssistantSourceIndex < 0) latestAssistantSourceIndex = index;
    if (role === "tool" || (typeof role === "string" && role.startsWith("tool:"))) omittedToolContentCount += 1;
  }

  const selected: Array<{ sourceIndex: number; message: Record<string, unknown>; contentComplete: boolean; toolPayloadOmitted: boolean }> = [];
  let usedBytes = 1024; // Reserve stable projection metadata and JSON punctuation.
  const add = (sourceIndex: number) => {
    const projection = projectMessage(messages[sourceIndex]);
    const bytes = Buffer.byteLength(JSON.stringify(projection.message), "utf8");
    if (selected.length >= MAX_RECENT_TRANSCRIPT_MESSAGES || usedBytes + bytes + 2 > MAX_TRANSCRIPT_PROJECTION_BYTES) return false;
    selected.push({ sourceIndex, ...projection });
    usedBytes += bytes + 2;
    return true;
  };

  if (latestAssistantSourceIndex >= 0) add(latestAssistantSourceIndex);
  for (let index = messages.length - 1; index >= 0 && selected.length < MAX_RECENT_TRANSCRIPT_MESSAGES; index -= 1) {
    if (index === latestAssistantSourceIndex) continue;
    if (!add(index)) break;
  }
  selected.sort((a, b) => a.sourceIndex - b.sourceIndex);
  const latestAssistantIndex = selected.findIndex((entry) => entry.sourceIndex === latestAssistantSourceIndex);
  const latestAssistantComplete = latestAssistantIndex >= 0 && selected[latestAssistantIndex].contentComplete;
  const omittedMessageCount = messages.length - selected.length;
  const omittedContentCount = selected.filter((entry) => entry.message.contentOmitted !== undefined).length;
  const result = {
    shape: "messages",
    messages: selected.map((entry) => entry.message),
    sourceMessageCount: messages.length,
    omittedMessageCount,
    omittedContentCount,
    omittedToolContentCount,
    truncated: omittedMessageCount > 0 || omittedContentCount > 0,
    incomplete: omittedMessageCount > 0 || omittedContentCount > 0 || !latestAssistantComplete,
    latestAssistantIndex: latestAssistantIndex >= 0 ? latestAssistantIndex : null,
    latestAssistantComplete,
  };
  // This final serialization is over a bounded projection, never the full history.
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_TRANSCRIPT_PROJECTION_BYTES) {
    return { shape: "messages", incomplete: true, latestAssistantComplete: false, error: "projection_limit_exceeded" };
  }
  return result;
}
function accepted<T>(accountId: string, value: T): JobResult<T> {
  return { classification: "accepted", accountId, value };
}
function rejected<T = unknown>(accountId: string, reason: JobReason, httpStatus?: number): JobResult<T> {
  return { classification: "rejected", accountId, reason, ...(httpStatus ? { httpStatus } : {}) };
}

/** Account-pinned, no-failover adapter for the documented LightSprint MCP API. */
export class LightSprintJobsAdapter {
  private clientPromise?: Promise<LightSprintMcpClient>;
  private clientTokenDigest?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly factory: LightSprintMcpClientFactory;
  private readonly timeoutMs: number;
  private readonly verifiedInstructions = new Map<string, string>();

  constructor(private readonly store: StateStore, readonly accountId: string, private readonly options: LightSprintJobsOptions = {}) {
    validateId(accountId, "accountId");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.factory = options.clientFactory ?? createLightSprintMcpClient;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) throw new RangeError("timeoutMs is invalid");
  }

  /** Reads only MCP tools/list through this account's validated, credential-pinned client. */
  async discoverProvisioningContract(): Promise<ProvisioningContractDiscovery> {
    let description: string | undefined;
    let malformed = false;
    let catalogMissing = false;
    try {
      const client = await this.client();
      const seenNames = new Set<string>();
      const seenCursors = new Set<string>();
      let totalTools = 0;
      let totalDescriptionBytes = 0;
      let cursor: string | undefined;
      let foundTarget = false;

      for (let pageIndex = 0; pageIndex < MAX_DISCOVERY_PAGES; pageIndex++) {
        const page = record(await client.request("tools/list", cursor === undefined ? {} : { cursor }));
        if (!page || !Array.isArray(page.tools) || page.tools.length > MAX_DISCOVERY_TOOLS ||
            totalTools + page.tools.length > MAX_DISCOVERY_TOOLS) {
          malformed = true;
          break;
        }
        totalTools += page.tools.length;
        for (const rawTool of page.tools) {
          const tool = record(rawTool);
          if (!tool || typeof tool.name !== "string" || tool.name.trim().length === 0 || tool.name.length > 128 ||
              (tool.description !== undefined && typeof tool.description !== "string")) {
            malformed = true;
            break;
          }
          if (seenNames.has(tool.name)) { malformed = true; break; }
          seenNames.add(tool.name);
          if (typeof tool.description === "string") {
            const bytes = Buffer.byteLength(tool.description, "utf8");
            if (bytes > MAX_DISCOVERY_DESCRIPTION_BYTES || totalDescriptionBytes + bytes > 256 * 1024) {
              malformed = true;
              break;
            }
            totalDescriptionBytes += bytes;
          }
          if (tool.name === "lightsprint_api") {
            if (foundTarget || typeof tool.description !== "string" || tool.description.trim().length === 0) {
              malformed = true;
              break;
            }
            foundTarget = true;
            description = tool.description;
          }
        }
        if (malformed) break;

        if (page.nextCursor === undefined) break;
        if (typeof page.nextCursor !== "string" || page.nextCursor.length === 0 || page.nextCursor.length > MAX_DISCOVERY_CURSOR_LENGTH ||
            seenCursors.has(page.nextCursor) || pageIndex === MAX_DISCOVERY_PAGES - 1) {
          malformed = true;
          break;
        }
        cursor = page.nextCursor;
        seenCursors.add(cursor);
      }
      if (!foundTarget && !malformed) catalogMissing = true;
    } catch (error) {
      return failedDiscovery(this.accountId, error);
    }

    if (malformed) return unknownDiscovery(this.accountId, "catalog_malformed");
    if (catalogMissing || description === undefined) return unknownDiscovery(this.accountId, "catalog_missing");

    const descriptionSha256 = createHash("sha256").update(description, "utf8").digest("hex");
    // The live catalog explicitly defines its ellipsis shorthand. Do not infer a
    // workspace prefix from arbitrary prose or use this metadata to authorize I/O.
    const workspaceShorthand = description.includes("Every path starts /api/workspaces/{workspaceId}/, written `…/` below");
    const workspaceRoute = (method: "GET" | "POST", path: string): boolean =>
      hasDocumentedRoute(description, method, `/api/workspaces/{workspaceId}${path}`) ||
      workspaceShorthand && hasDocumentedRoute(description, method, `…${path}`);
    const hasTaskCreation = hasDocumentedRoute(description, "POST", "/api/tasks") || workspaceRoute("POST", "/tasks");
    const hasLegacyLaunch = hasDocumentedRoute(description, "POST", LEGACY_LAUNCH_ROUTE);
    const hasWorkspaceLaunch = hasDocumentedRoute(description, "POST", WORKSPACE_LAUNCH_ROUTE) || workspaceRoute("POST", "/agent-sessions");
    if (!hasTaskCreation || hasLegacyLaunch === hasWorkspaceLaunch) {
      return unknownDiscovery(this.accountId, "contract_unrecognized", descriptionSha256);
    }
    const family: Exclude<ProvisioningContractFamily, "unknown"> = hasLegacyLaunch ? "legacy-task" : "workspace-task";
    const listRouteAvailable = family === "legacy-task"
      ? hasDocumentedRoute(description, "GET", LEGACY_LIST_ROUTE)
      : hasDocumentedRoute(description, "GET", WORKSPACE_LIST_ROUTE) || workspaceRoute("GET", "/agent-sessions");
    return {
      accountId: this.accountId,
      family,
      descriptionSha256,
      launchRouteAvailable: true,
      listRouteAvailable,
      // The route family signatures document no enforceable exact model/effort pin guarantee.
      modelPin: "unknown",
      effortPin: "unknown",
      status: "documented",
      ...(catalogWorkspaceId(description) ? { workspaceId: catalogWorkspaceId(description) } : {}),
    };
  }

  private async client(): Promise<LightSprintMcpClient> {
    const state = await this.store.load();
    const account: UpstreamAccount | undefined = state.accounts.find((item) => item.id === this.accountId);
    if (!account || account.enabled !== true) {
      this.clientPromise = undefined;
      this.clientTokenDigest = undefined;
      throw new AccountUnavailableError("account_unavailable");
    }
    const legacyNativeTarget = account.provider === "generic-bearer-mcp" && isCanonicalNativeLightSprintUrl(state.config.upstreamUrl);
    if (account.provider !== "lightsprint" && !legacyNativeTarget) {
      this.clientPromise = undefined;
      this.clientTokenDigest = undefined;
      throw new AccountUnavailableError(account.provider === "generic-bearer-mcp" ? "endpoint_mismatch" : "provider_mismatch");
    }
    const endpoint = validateEndpoint(new URL(PROVIDER_PROFILES.lightsprint.defaultServerUrl));
    const token = await this.store.revealToken(account);
    // There is no credential revision in PersistedState; compare a one-way
    // digest on every call and discard/rebuild a cached client after rotation.
    const tokenDigest = createHash("sha256").update(token).digest("hex");
    if (!this.clientPromise || this.clientTokenDigest !== tokenDigest) {
      const prior = this.clientPromise;
      this.clientTokenDigest = tokenDigest;
      const created = Promise.resolve(this.factory({ endpoint, token, fetch: this.fetchImpl, timeoutMs: this.timeoutMs }));
      this.clientPromise = created;
      if (prior) void prior.then((client) => client.close?.()).catch(() => undefined);
      try {
        return await created;
      } catch (error) {
        if (this.clientPromise === created) {
          this.clientPromise = undefined;
          this.clientTokenDigest = undefined;
        }
        throw error;
      }
    }
    return this.clientPromise;
  }

  private async api<T = unknown>(method: string, path: string, body?: Record<string, unknown>, transcript = false,
    trustedChatMutation = false, trustedWorkspaceId?: string, trustedFreshMutation = false): Promise<JobResult<T>> {
    let raw: unknown;
    try {
      const state = await this.store.load();
      const policyResult = evaluateToolCall(state.config?.toolPolicy, { name: "lightsprint_api", arguments: { method, path, ...(body === undefined ? {} : { body }) } });
      const allowed = policyResult.allowed;
      if (trustedWorkspaceId !== undefined) {
        const discovery = await this.discoverProvisioningContract();
        if (discovery.status !== "documented") {
          // Preserve an explicit upstream auth failure so durable read-only
          // reconciliation can distinguish credential repair from a binding
          // mismatch. Other unknown discovery states remain fail-closed.
          return rejected<T>(this.accountId, discovery.reason === "auth_failed" ? "auth" : "identity_mismatch");
        }
        if (discovery.family !== "workspace-task" || discovery.workspaceId !== trustedWorkspaceId) {
          return rejected<T>(this.accountId, "identity_mismatch");
        }
      }
      const accountBoundWorkspace = !allowed && policyResult.code === "endpoint-not-allowed" && trustedWorkspaceId !== undefined &&
        this.options.trustedWorkspacePermit?.(Object.freeze({ accountId: this.accountId, workspaceId: trustedWorkspaceId,
          method, path, ...(body === undefined ? {} : { body: Object.freeze({ ...body }) }) })) === true;
      let trustedMutationGranted = false;
      if (trustedChatMutation || trustedFreshMutation) {
        const keys = body && Object.keys(body).sort();
        const exactChat = trustedChatMutation && method === "POST" &&
          /^\/api\/agent-sessions\/[A-Za-z0-9_-][A-Za-z0-9_-]{0,127}\/chat$/.test(path) &&
          !!body && keys?.length === 2 && keys[0] === "clientMessageId" && keys[1] === "message" &&
          typeof body.message === "string" && typeof body.clientMessageId === "string";
        const chatRequest = exactChat ? Object.freeze({ method: "POST" as const, path,
          body: Object.freeze({ message: body.message as string, clientMessageId: body.clientMessageId as string }) }) : undefined;
        const exactFresh = trustedFreshMutation && (method === "POST" || method === "PATCH") && !!body &&
          ((method === "POST" && path === "/api/tasks" && keys?.join(",") === "scope,stackId,title" &&
            typeof body.title === "string" && body.scope === "stack" && typeof body.stackId === "string") ||
           (method === "PATCH" && /^\/api\/tasks\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(path) && keys?.length === 1 && keys[0] === "description" &&
            typeof body.description === "string") ||
           (method === "POST" && /^\/api\/tasks\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/lightsprint-agents\/(?:claude|codex|auto|pi)$/.test(path) &&
            keys?.length === 1 && keys[0] === "autoMerge" && body.autoMerge === false));
        const freshRequest = exactFresh ? Object.freeze({ method: method as "POST" | "PATCH", path,
          body: Object.freeze({ ...body }) }) : undefined;
        trustedMutationGranted = chatRequest
          ? this.options.trustedChatMutationPermit?.(chatRequest) === true
          : freshRequest
            ? this.options.trustedFreshMutationPermit?.(freshRequest) === true
            : false;
      }
      if ((!allowed && !accountBoundWorkspace && !trustedMutationGranted) ||
          ((trustedChatMutation || trustedFreshMutation) && !trustedMutationGranted)) {
        return rejected<T>(this.accountId, "policy_denied");
      }
      const client = await this.client();
      raw = await client.request("tools/call", {
        name: "lightsprint_api",
        arguments: { method, path, ...(body === undefined ? {} : { body }) },
      });
    } catch (error) {
      if (error instanceof HttpStatusError) return rejected<T>(this.accountId, reasonForStatus(error.status), error.status);
      if (error instanceof ResponseTooLargeError) return rejected<T>(this.accountId, "response_too_large");
      if (error instanceof JsonRpcFailure) return rejected<T>(this.accountId, "protocol_error");
      if (error instanceof AccountUnavailableError) return rejected<T>(this.accountId, error.reason);
      return { classification: "ambiguous", accountId: this.accountId, reason: "transport_ambiguous" };
    }
    const parsed = parseToolValue(raw);
    if (parsed.isError) {
      const status = parsed.status;
      return rejected<T>(this.accountId, status ? reasonForStatus(status) : "tool_error", status);
    }
    const value = transcript ? boundedTranscript(parsed.value) : parsed.value;
    return accepted(this.accountId, value as T);
  }

  async createWorkspaceTask(workspaceId: string, title: string, stackId?: string): Promise<JobResult> {
    const route = new LightSprintWorkspaceContract({ accountId: this.accountId, workspaceId }).taskCreateRoute();
    validateText(title, "title", MAX_TITLE_LENGTH);
    if (stackId !== undefined) validateId(stackId, "stackId");
    return this.api("POST", route.path, { title, ...(stackId === undefined ? {} : { stackId }) }, false, false, workspaceId);
  }

  listWorkspaceStacks(workspaceId: string): Promise<JobResult> {
    const route = new LightSprintWorkspaceContract({ accountId: this.accountId, workspaceId }).stackListRoute();
    return this.api("GET", route.path, undefined, false, false, workspaceId);
  }

  readWorkspaceTask(workspaceId: string, taskRef: string): Promise<JobResult> {
    validateId(taskRef, "taskRef");
    const route = new LightSprintWorkspaceContract({ accountId: this.accountId, workspaceId }).scopedTaskReadRoute(taskRef);
    if (!route.ok) throw new TypeError("taskRef is invalid");
    return this.api("GET", route.route.path, undefined, false, false, workspaceId);
  }

  async patchWorkspaceTaskInstructions(workspaceId: string, taskRef: string, description: string): Promise<JobResult> {
    validateId(taskRef, "taskRef");
    validateText(description, "description", MAX_INSTRUCTIONS_LENGTH);
    const contract = new LightSprintWorkspaceContract({ accountId: this.accountId, workspaceId });
    const route = contract.scopedTaskPatchRoute(taskRef);
    if (!route.ok) throw new TypeError("taskRef is invalid");
    const key = `${workspaceId}\0${taskRef}`;
    this.verifiedInstructions.delete(key);
    const patch = await this.api("PATCH", route.route.path, { description }, false, false, workspaceId);
    if (patch.classification === "rejected") return patch;
    const readback = await this.readWorkspaceTask(workspaceId, taskRef);
    if (readback.classification !== "accepted") return readback;
    const task = record(record(readback.value)?.task) ?? record(readback.value);
    if (!task || taskIdentity(readback.value) !== taskRef || !taskIdentityMatches(readback.value, taskRef) || task.description !== description) return rejected(this.accountId, "instructions_mismatch");
    this.verifiedInstructions.set(key, description);
    return { ...accepted(this.accountId, readback.value), instructionsVerified: true };
  }

  async launchWorkspaceSession(workspaceId: string, taskRef: string, provider: JobProvider,
    branchName: string, expectedDescription?: string): Promise<JobResult> {
    validateId(taskRef, "taskRef");
    validateId(branchName, "branchName");
    if (!PROVIDERS.has(provider)) throw new TypeError("provider is invalid");
    const key = `${workspaceId}\0${taskRef}`;
    const expected = expectedDescription === undefined ? this.verifiedInstructions.get(key) : expectedDescription;
    if (expected === undefined) return rejected(this.accountId, "instructions_mismatch");
    validateText(expected, "description", MAX_INSTRUCTIONS_LENGTH);
    // Adapter-direct callers consume the one-shot in-memory proof. Durable
    // worker operations pass their persisted instruction packet instead; their
    // operation claim is the single-use boundary across adapter instances.
    this.verifiedInstructions.delete(key);
    const before = await this.readWorkspaceTask(workspaceId, taskRef);
    if (before.classification !== "accepted") return before;
    const task = record(record(before.value)?.task) ?? record(before.value);
    if (!task || !taskIdentityMatches(before.value, taskRef) || task.description !== expected) {
      this.verifiedInstructions.delete(key);
      return rejected(this.accountId, "instructions_mismatch");
    }
    // A second call requires a new independently verified instruction binding.
    // In particular, a lost launch response must never replay this POST.
    this.verifiedInstructions.delete(key);
    const route = new LightSprintWorkspaceContract({ accountId: this.accountId, workspaceId }).sessionCreateRoute();
    const result = await this.api("POST", route.path,
      { taskRef, branchName, provider, autoMerge: false }, false, false, workspaceId);
    if (result.classification === "accepted") {
      const reportedModel = findField(result.value, ["model", "reportedModel"]);
      const reportedBranchName = findField(result.value, ["branchName"]);
      if (typeof reportedModel === "string") result.reportedModel = reportedModel;
      if (typeof reportedBranchName === "string") result.reportedBranchName = reportedBranchName;
    }
    return result;
  }

  listWorkspaceSessions(workspaceId: string, taskRef: string): Promise<JobResult> {
    validateId(taskRef, "taskRef");
    const route = new LightSprintWorkspaceContract({ accountId: this.accountId, workspaceId }).sessionListRoute();
    return this.api("GET", `${route.path}?taskRef=${encodeURIComponent(taskRef)}`, undefined, false, false, workspaceId);
  }

  workspaceSessionStatus(workspaceId: string, sessionId: string): Promise<JobResult> {
    const route = new LightSprintWorkspaceContract({ accountId: this.accountId, workspaceId }).sessionStatusRoute(sessionId);
    if (!route.ok) throw new TypeError("sessionId is invalid");
    return this.api("GET", route.route.path, undefined, false, false, workspaceId);
  }

  workspaceSessionTranscript(workspaceId: string, sessionId: string): Promise<JobResult> {
    const route = new LightSprintWorkspaceContract({ accountId: this.accountId, workspaceId }).sessionTranscriptRoute(sessionId);
    if (!route.ok) throw new TypeError("sessionId is invalid");
    return this.api("GET", `${route.route.path}?limit=100&include=text&maxBytes=131072`, undefined, true, false, workspaceId);
  }

  sendWorkspaceMessage(workspaceId: string, sessionId: string, message: string, clientMessageId: string): Promise<JobResult> {
    validateText(message, "message", MAX_MESSAGE_LENGTH);
    if (typeof clientMessageId !== "string" || !CLIENT_MESSAGE_ID_RE.test(clientMessageId)) throw new TypeError("clientMessageId is invalid");
    const route = new LightSprintWorkspaceContract({ accountId: this.accountId, workspaceId }).sessionChatRoute(sessionId);
    if (!route.ok) throw new TypeError("sessionId is invalid");
    return this.api("POST", route.route.path, { message, clientMessageId }, false, false, workspaceId);
  }

  cancelWorkspaceTurn(workspaceId: string, sessionId: string): Promise<JobResult> {
    const route = new LightSprintWorkspaceContract({ accountId: this.accountId, workspaceId }).sessionCancelRoute(sessionId);
    if (!route.ok) throw new TypeError("sessionId is invalid");
    return this.api("POST", route.route.path, {}, false, false, workspaceId);
  }

  stopWorkspaceSession(workspaceId: string, sessionId: string): Promise<JobResult> {
    const route = new LightSprintWorkspaceContract({ accountId: this.accountId, workspaceId }).sessionStopRoute(sessionId);
    if (!route.ok) throw new TypeError("sessionId is invalid");
    return this.api("PATCH", route.route.path, { status: "stopped" }, false, false, workspaceId);
  }

  createTask(title: string, stackId: string): Promise<JobResult> {
    validateText(title, "title", MAX_TITLE_LENGTH);
    validateId(stackId, "stackId");
    return this.api("POST", "/api/tasks", { title, scope: "stack", stackId }, false, false, undefined,
      this.options.trustedFreshMutationPermit !== undefined);
  }

  readTask(taskId: string): Promise<JobResult> {
    validateId(taskId, "taskId");
    return this.api("GET", `/api/tasks/${taskId}`);
  }

  async patchTaskInstructions(taskId: string, description: string): Promise<JobResult> {
    validateId(taskId, "taskId");
    validateText(description, "description", MAX_INSTRUCTIONS_LENGTH);
    this.verifiedInstructions.delete(taskId);
    const patch = await this.api("PATCH", `/api/tasks/${taskId}`, { description }, false, false, undefined,
      this.options.trustedFreshMutationPermit !== undefined);
    if (patch.classification === "rejected") return patch;
    // Even an ambiguous PATCH can only unlock launch after an independent, exact readback.
    const readback = await this.readTask(taskId);
    if (readback.classification !== "accepted") return readback;
    const returnedId = findField(readback.value, ["id", "taskId"]);
    const returnedDescription = findField(readback.value, ["description"]);
    if (returnedId !== taskId) return rejected(this.accountId, "identity_mismatch");
    if (returnedDescription !== description) return rejected(this.accountId, "instructions_mismatch");
    this.verifiedInstructions.set(taskId, description);
    return { ...accepted(this.accountId, readback.value), instructionsVerified: true };
  }

  async launchTask(taskId: string, provider: JobProvider, autoMerge = false): Promise<JobResult> {
    validateId(taskId, "taskId");
    if (!PROVIDERS.has(provider)) throw new TypeError("provider is invalid");
    if (autoMerge !== false) throw new TypeError("autoMerge must be false");
    const expected = this.verifiedInstructions.get(taskId);
    if (expected === undefined) return rejected(this.accountId, "instructions_mismatch");
    this.verifiedInstructions.delete(taskId);
    const before = await this.readTask(taskId);
    if (before.classification !== "accepted") return before;
    if (findField(before.value, ["id", "taskId"]) !== taskId || findField(before.value, ["description"]) !== expected) {
      this.verifiedInstructions.delete(taskId);
      return rejected(this.accountId, "instructions_mismatch");
    }
    this.verifiedInstructions.delete(taskId);
    const result = await this.api("POST", `/api/tasks/${taskId}/lightsprint-agents/${provider}`, { autoMerge: false }, false, false, undefined,
      this.options.trustedFreshMutationPermit !== undefined);
    if (result.classification === "accepted") {
      const reportedModel = findField(result.value, ["model", "reportedModel"]);
      const reportedBranchName = findField(result.value, ["branchName"]);
      if (typeof reportedModel === "string") result.reportedModel = reportedModel;
      if (typeof reportedBranchName === "string") result.reportedBranchName = reportedBranchName;
    }
    return result;
  }

  listTaskAgents(taskId: string): Promise<JobResult> {
    validateId(taskId, "taskId");
    return this.api("GET", `/api/tasks/${taskId}/lightsprint-agents`);
  }

  sessionStatus(sessionId: string): Promise<JobResult> {
    validateSessionId(sessionId, "sessionId");
    return this.api("GET", `/api/agent-sessions/${sessionId}/status`);
  }

  sessionTranscript(sessionId: string): Promise<JobResult> {
    validateSessionId(sessionId, "sessionId");
    return this.api("GET", `/api/agent-sessions/${sessionId}/transcript?limit=100&include=text&maxBytes=131072`, undefined, true);
  }

  sendMessage(sessionId: string, message: string, clientMessageId: string): Promise<JobResult> {
    validateSessionId(sessionId, "sessionId");
    validateText(message, "message", MAX_MESSAGE_LENGTH);
    if (typeof clientMessageId !== "string" || !CLIENT_MESSAGE_ID_RE.test(clientMessageId)) throw new TypeError("clientMessageId is invalid");
    return this.api("POST", `/api/agent-sessions/${sessionId}/chat`, { message, clientMessageId }, false,
      this.options.trustedChatMutationPermit !== undefined);
  }

  cancelTurn(sessionId: string): Promise<JobResult> {
    validateSessionId(sessionId, "sessionId");
    return this.api("POST", `/api/agent-sessions/${sessionId}/cancel`, {});
  }

  stopSession(sessionId: string): Promise<JobResult> {
    validateSessionId(sessionId, "sessionId");
    return this.api("POST", `/api/agent-sessions/${sessionId}/stop`, {});
  }
}
