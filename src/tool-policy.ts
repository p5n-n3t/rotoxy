/**
 * Pure MCP tool-policy engine.
 *
 * Given a compiled policy it (a) filters the tools a client sees in a
 * tools/list result and (b) decides whether a tools/call may be forwarded.
 * For LightSprint-style "single API tool" servers it additionally enforces a
 * method + path allowlist on the tool's arguments, with strict path
 * normalization so encoded traversal cannot reach endpoints outside the list.
 *
 * Backwards compatibility: an `undefined` policy is a passthrough — every
 * helper returns its input unchanged and every call is allowed.
 *
 * No I/O, no globals; safe to call per request.
 */

import type { McpTool } from "./provider-capabilities.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface EndpointRule {
  /** Methods this rule permits. */
  methods: HttpMethod[];
  /**
   * Path pattern beginning with the policy prefix (default "/api/").
   * Segments: literal text, `*` (exactly one segment), or `{name}` (one
   * segment, constrained by `bindings[name]` when bound). No multi-segment
   * wildcards exist, so a rule can never become an open proxy.
   */
  path: string;
  /** Query keys allowed for this rule. Omitted or empty means no query string. */
  query?: string[];
  /** Whether a request body is permitted. Default: true except for GET/DELETE. */
  allowBody?: boolean;
  /** Free-form label surfaced in decisions, for audit logs. */
  id?: string;
}

export interface EndpointPolicy {
  /** Name of the single API tool. Default "lightsprint_api". */
  tool?: string;
  /** Required path prefix. Default "/api/". */
  prefix?: string;
  /** Values `{name}` placeholders must equal, e.g. { workspaceId: "ws_123" }. */
  bindings?: Record<string, string>;
  /** Allowlist. An empty list denies every call to the tool. */
  rules: EndpointRule[];
  /** Max path length accepted before parsing. Default 2048. */
  maxPathLength?: number;
}

export interface ToolPolicy {
  /** If set, only these tools are visible and callable. */
  allowTools?: string[];
  /** Always hidden and rejected, even when also allowlisted. */
  denyTools?: string[];
  /** Endpoint allowlists for single-API tools, keyed by nothing: one entry per tool. */
  endpoints?: EndpointPolicy[];
  /**
   * Hide tools from tools/list that the policy would reject outright.
   * Default true. Calls are rejected either way.
   */
  hideDenied?: boolean;
}

interface CompiledRule {
  id?: string;
  methods: Set<string>;
  segments: Array<{ kind: "literal"; value: string } | { kind: "any" } | { kind: "param"; name: string }>;
  query: Set<string>;
  allowBody?: boolean;
}

interface CompiledEndpointPolicy {
  tool: string;
  prefix: string;
  prefixSegments: string[];
  bindings: Record<string, string>;
  rules: CompiledRule[];
  maxPathLength: number;
}

export interface CompiledToolPolicy {
  readonly kind: "compiled-tool-policy";
  allow?: Set<string>;
  deny: Set<string>;
  endpoints: Map<string, CompiledEndpointPolicy>;
  hideDenied: boolean;
}

export type PolicyDenialCode =
  | "tool-not-allowed"
  | "tool-denied"
  | "invalid-arguments"
  | "method-not-allowed"
  | "invalid-path"
  | "endpoint-not-allowed"
  | "query-not-allowed"
  | "body-not-allowed";

export type PolicyDecision =
  | { allowed: true; rule?: string; normalizedPath?: string }
  | { allowed: false; code: PolicyDenialCode; reason: string };

export class PolicyConfigError extends Error {}

// Deliberately narrower than RFC 3986 pchar: no `;` (matrix params some
// servers strip), no non-ASCII (lookalike/normalization tricks), no `%`.
const SEGMENT_SAFE = /^[A-Za-z0-9._~\-:@]+$/;
const DOTS_ONLY = /^\.+$/;
// Any non-empty name an upstream can advertise, minus control characters.
const TOOL_NAME = /^[^\u0000-\u001f\u007f]{1,128}$/;

function compileRule(rule: EndpointRule, prefixSegments: string[], index: number): CompiledRule {
  if (!rule || typeof rule.path !== "string") throw new PolicyConfigError(`rule ${index}: path is required`);
  if (!Array.isArray(rule.methods) || rule.methods.length === 0) {
    throw new PolicyConfigError(`rule ${index}: at least one method is required`);
  }
  const methods = new Set<string>();
  for (const method of rule.methods) {
    const upper = String(method).toUpperCase();
    if (!HTTP_METHODS.has(upper)) throw new PolicyConfigError(`rule ${index}: unsupported method ${method}`);
    methods.add(upper);
  }
  if (rule.path.includes("?") || rule.path.includes("#") || rule.path.includes("%") || rule.path.includes("\\")) {
    throw new PolicyConfigError(`rule ${index}: path pattern must be a plain decoded path`);
  }
  const parts = rule.path.split("/");
  if (parts[0] !== "") throw new PolicyConfigError(`rule ${index}: path must start with /`);
  const segments = parts.slice(1);
  if (segments[segments.length - 1] === "") segments.pop();
  for (let i = 0; i < prefixSegments.length; i++) {
    if (segments[i] !== prefixSegments[i]) {
      throw new PolicyConfigError(`rule ${index}: path must start with /${prefixSegments.join("/")}/`);
    }
  }
  if (segments.length <= prefixSegments.length) {
    throw new PolicyConfigError(`rule ${index}: path must name an endpoint below the prefix`);
  }
  const compiled: CompiledRule["segments"] = [];
  for (const segment of segments) {
    if (segment === "**") throw new PolicyConfigError(`rule ${index}: multi-segment wildcards are not supported`);
    if (segment === "" || segment === "." || segment === "..") {
      throw new PolicyConfigError(`rule ${index}: empty or dot segments are not allowed`);
    }
    if (segment === "*") compiled.push({ kind: "any" });
    else if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment)) compiled.push({ kind: "param", name: segment.slice(1, -1) });
    else if (SEGMENT_SAFE.test(segment) && !DOTS_ONLY.test(segment)) compiled.push({ kind: "literal", value: segment });
    else throw new PolicyConfigError(`rule ${index}: invalid segment ${JSON.stringify(segment)}`);
  }
  const query = new Set<string>();
  for (const key of rule.query ?? []) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_.\-]+$/.test(key)) {
      throw new PolicyConfigError(`rule ${index}: invalid query key ${JSON.stringify(key)}`);
    }
    query.add(key);
  }
  return { id: rule.id, methods, segments: compiled, query, allowBody: rule.allowBody };
}

function compileEndpointPolicy(policy: EndpointPolicy): CompiledEndpointPolicy {
  const tool = policy.tool ?? "lightsprint_api";
  if (!TOOL_NAME.test(tool)) throw new PolicyConfigError(`invalid endpoint tool name ${JSON.stringify(tool)}`);
  const prefix = policy.prefix ?? "/api/";
  if (!/^\/(?:[A-Za-z0-9._~\-]+\/)*$/.test(prefix) || prefix.split("/").some((s) => s === "." || s === "..")) {
    throw new PolicyConfigError(`invalid prefix ${JSON.stringify(prefix)}; it must start and end with /`);
  }
  if (!Array.isArray(policy.rules)) throw new PolicyConfigError(`endpoint policy for ${tool}: rules must be an array`);
  const prefixSegments = prefix.split("/").filter(Boolean);
  const bindings: Record<string, string> = {};
  for (const [key, value] of Object.entries(policy.bindings ?? {})) {
    if (typeof value !== "string" || !SEGMENT_SAFE.test(value) || DOTS_ONLY.test(value)) {
      throw new PolicyConfigError(`binding ${key} must be a single safe path segment`);
    }
    bindings[key] = value;
  }
  return {
    tool,
    prefix,
    prefixSegments,
    bindings,
    rules: policy.rules.map((rule, index) => compileRule(rule, prefixSegments, index)),
    maxPathLength: policy.maxPathLength ?? 2048,
  };
}

/** Validates and compiles a policy. Throws PolicyConfigError on bad config. */
export function compileToolPolicy(policy: ToolPolicy): CompiledToolPolicy {
  const names = (list: unknown, field: string): Set<string> => {
    if (list === undefined) return new Set();
    if (!Array.isArray(list)) throw new PolicyConfigError(`${field} must be an array`);
    for (const name of list) {
      if (typeof name !== "string" || !TOOL_NAME.test(name)) {
        throw new PolicyConfigError(`${field}: invalid tool name ${JSON.stringify(name)}`);
      }
    }
    return new Set(list as string[]);
  };
  const endpoints = new Map<string, CompiledEndpointPolicy>();
  for (const endpoint of policy.endpoints ?? []) {
    const compiled = compileEndpointPolicy(endpoint);
    if (endpoints.has(compiled.tool)) throw new PolicyConfigError(`duplicate endpoint policy for ${compiled.tool}`);
    endpoints.set(compiled.tool, compiled);
  }
  return {
    kind: "compiled-tool-policy",
    allow: policy.allowTools === undefined ? undefined : names(policy.allowTools, "allowTools"),
    deny: names(policy.denyTools, "denyTools"),
    endpoints,
    hideDenied: policy.hideDenied ?? true,
  };
}

type PolicyInput = ToolPolicy | CompiledToolPolicy | undefined;

function asCompiled(policy: PolicyInput): CompiledToolPolicy | undefined {
  if (policy === undefined) return undefined;
  if ((policy as CompiledToolPolicy).kind === "compiled-tool-policy") return policy as CompiledToolPolicy;
  return compileToolPolicy(policy as ToolPolicy);
}

/** Tool-level decision only (allow/deny lists). */
export function isToolAllowed(policy: PolicyInput, name: string): PolicyDecision {
  const compiled = asCompiled(policy);
  if (!compiled) return { allowed: true };
  if (typeof name !== "string" || name.length === 0) {
    return { allowed: false, code: "invalid-arguments", reason: "tool name is required" };
  }
  if (compiled.deny.has(name)) return { allowed: false, code: "tool-denied", reason: `tool ${name} is denied by policy` };
  if (compiled.allow && !compiled.allow.has(name)) {
    return { allowed: false, code: "tool-not-allowed", reason: `tool ${name} is not in the allowlist` };
  }
  return { allowed: true };
}

/** Returns the visible subset of a tools/list result. */
export function filterTools<T extends Pick<McpTool, "name">>(policy: PolicyInput, tools: T[]): T[] {
  const compiled = asCompiled(policy);
  if (!compiled || !compiled.hideDenied) return tools;
  return tools.filter((tool) => {
    if (!isToolAllowed(compiled, tool?.name).allowed) return false;
    const endpoint = compiled.endpoints.get(tool.name);
    // An endpoint tool with an empty allowlist can never succeed; hide it.
    return !endpoint || endpoint.rules.length > 0;
  });
}

export interface NormalizedApiPath {
  /** Canonical decoded path, e.g. "/api/tasks/abc". */
  path: string;
  segments: string[];
  query: Map<string, string[]>;
}

export type PathResult = { ok: true; value: NormalizedApiPath } | { ok: false; reason: string };

// C0 controls, DEL and C1 controls, plus Unicode line/paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function decodeSegmentOnce(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Normalizes an API path supplied as a tool argument. Rejects instead of
 * repairing: absolute or protocol-relative URLs, backslashes, control
 * characters, fragments, empty segments, `.`/`..` segments (raw or encoded),
 * encoded separators (`%2f`, `%5c`), and any `%` that survives one decode
 * (double encoding). Query values are decoded once and returned for key checks.
 */
export function normalizeApiPath(raw: unknown, options: { prefix?: string; maxLength?: number } = {}): PathResult {
  const prefix = options.prefix ?? "/api/";
  const maxLength = options.maxLength ?? 2048;
  if (typeof raw !== "string") return { ok: false, reason: "path must be a string" };
  if (raw.length === 0 || raw.length > maxLength) return { ok: false, reason: "path length out of range" };
  if (CONTROL.test(raw)) return { ok: false, reason: "path contains control characters" };
  if (raw.includes("\\")) return { ok: false, reason: "path contains a backslash" };
  if (raw.includes("#")) return { ok: false, reason: "path contains a fragment" };
  if (!raw.startsWith("/") || raw.startsWith("//")) return { ok: false, reason: "path must be origin-relative (start with a single /)" };
  if (/^[A-Za-z][A-Za-z0-9+.\-]*:/.test(raw)) return { ok: false, reason: "absolute URLs are not allowed" };

  const qIndex = raw.indexOf("?");
  const rawPath = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const rawQuery = qIndex === -1 ? "" : raw.slice(qIndex + 1);

  const parts = rawPath.split("/").slice(1);
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop(); // tolerate one trailing slash
  const segments: string[] = [];
  for (const part of parts) {
    if (part === "") return { ok: false, reason: "path contains an empty segment" };
    const decoded = decodeSegmentOnce(part);
    if (decoded === undefined) return { ok: false, reason: "path contains malformed percent-encoding" };
    if (decoded.includes("%")) return { ok: false, reason: "path contains double-encoded characters" };
    if (decoded.includes("/") || decoded.includes("\\")) return { ok: false, reason: "path contains an encoded separator" };
    if (CONTROL.test(decoded)) return { ok: false, reason: "path contains encoded control characters" };
    if (DOTS_ONLY.test(decoded)) return { ok: false, reason: "path contains a dot segment" };
    if (!SEGMENT_SAFE.test(decoded)) return { ok: false, reason: "path segment contains disallowed characters" };
    segments.push(decoded);
  }

  const prefixSegments = prefix.split("/").filter(Boolean);
  for (let i = 0; i < prefixSegments.length; i++) {
    if (segments[i] !== prefixSegments[i]) return { ok: false, reason: `path must start with ${prefix}` };
  }

  const query = new Map<string, string[]>();
  if (rawQuery.length > 0) {
    for (const pair of rawQuery.split("&")) {
      if (pair === "") continue;
      const eq = pair.indexOf("=");
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
      let key: string;
      let value: string;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, " "));
        value = decodeURIComponent(rawValue.replace(/\+/g, " "));
      } catch {
        return { ok: false, reason: "query contains malformed percent-encoding" };
      }
      if (CONTROL.test(key) || CONTROL.test(value)) return { ok: false, reason: "query contains control characters" };
      const list = query.get(key) ?? [];
      list.push(value);
      query.set(key, list);
    }
  }

  return { ok: true, value: { path: `/${segments.join("/")}`, segments, query } };
}

function matchRule(rule: CompiledRule, segments: string[], bindings: Record<string, string>): boolean {
  if (rule.segments.length !== segments.length) return false;
  for (let i = 0; i < segments.length; i++) {
    const pattern = rule.segments[i];
    const actual = segments[i];
    if (pattern.kind === "literal") {
      if (pattern.value !== actual) return false;
    } else if (pattern.kind === "param" && Object.prototype.hasOwnProperty.call(bindings, pattern.name)) {
      if (bindings[pattern.name] !== actual) return false;
    }
  }
  return true;
}

function evaluateEndpointCall(endpoint: CompiledEndpointPolicy, args: unknown): PolicyDecision {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { allowed: false, code: "invalid-arguments", reason: `${endpoint.tool} arguments must be an object` };
  }
  const record = args as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "method" && key !== "path" && key !== "body") {
      return { allowed: false, code: "invalid-arguments", reason: `unexpected argument ${key}` };
    }
  }
  if (typeof record.method !== "string") {
    return { allowed: false, code: "invalid-arguments", reason: "method must be a string" };
  }
  // Exact-case match only: "get" or "GeT" may be treated differently upstream.
  const method = record.method;
  if (!HTTP_METHODS.has(method)) {
    return { allowed: false, code: "method-not-allowed", reason: `method ${method} is not supported` };
  }
  const normalized = normalizeApiPath(record.path, { prefix: endpoint.prefix, maxLength: endpoint.maxPathLength });
  if (!normalized.ok) return { allowed: false, code: "invalid-path", reason: normalized.reason };
  const { segments, query, path } = normalized.value;
  const hasBody = record.body !== undefined && record.body !== null;
  if (hasBody && (typeof record.body !== "object" || Array.isArray(record.body))) {
    return { allowed: false, code: "invalid-arguments", reason: "body must be an object" };
  }

  let methodMismatch = false;
  for (const rule of endpoint.rules) {
    if (!matchRule(rule, segments, endpoint.bindings)) continue;
    if (!rule.methods.has(method)) {
      methodMismatch = true;
      continue;
    }
    for (const key of query.keys()) {
      if (!rule.query.has(key)) {
        return { allowed: false, code: "query-not-allowed", reason: `query parameter ${key} is not allowed for ${path}` };
      }
    }
    const bodyAllowed = rule.allowBody ?? !(method === "GET" || method === "DELETE");
    if (hasBody && !bodyAllowed) {
      return { allowed: false, code: "body-not-allowed", reason: `${method} ${path} does not accept a body` };
    }
    return { allowed: true, rule: rule.id, normalizedPath: path };
  }
  if (methodMismatch) {
    return { allowed: false, code: "method-not-allowed", reason: `${method} is not allowed for ${path}` };
  }
  return { allowed: false, code: "endpoint-not-allowed", reason: `${method} ${path} is not in the endpoint allowlist` };
}

/** Full decision for one tools/call: tool lists, then endpoint rules if any. */
export function evaluateToolCall(policy: PolicyInput, call: { name: unknown; arguments?: unknown }): PolicyDecision {
  const compiled = asCompiled(policy);
  if (!compiled) return { allowed: true };
  if (typeof call?.name !== "string") {
    return { allowed: false, code: "invalid-arguments", reason: "tool name is required" };
  }
  const toolDecision = isToolAllowed(compiled, call.name);
  if (!toolDecision.allowed) return toolDecision;
  const endpoint = compiled.endpoints.get(call.name);
  if (!endpoint) return toolDecision;
  return evaluateEndpointCall(endpoint, call.arguments);
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers. These operate on parsed message objects so the proxy can
// apply them without this module knowing about HTTP or SSE framing.
// ---------------------------------------------------------------------------

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

/** JSON-RPC "Invalid params"; MCP uses it for unknown tools. */
export const POLICY_ERROR_CODE = -32602;

export interface GateResult {
  /** Messages to forward upstream (null when nothing remains). */
  forward: JsonRpcMessage | JsonRpcMessage[] | null;
  /** Error responses to return to the client for rejected requests. */
  rejections: JsonRpcMessage[];
}

function rejectionFor(message: JsonRpcMessage, decision: Extract<PolicyDecision, { allowed: false }>): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: message.id ?? null,
    error: { code: POLICY_ERROR_CODE, message: `Blocked by ROTOXY tool policy: ${decision.reason}`, data: { code: decision.code } },
  };
}

/**
 * Splits a client→server payload (single message or batch) into what may be
 * forwarded and the error responses for rejected tools/call requests. Rejected
 * notifications (no id) are dropped silently, per JSON-RPC.
 */
export function gateClientMessage(policy: PolicyInput, payload: JsonRpcMessage | JsonRpcMessage[]): GateResult {
  const compiled = asCompiled(policy);
  if (!compiled) return { forward: payload, rejections: [] };
  const list = Array.isArray(payload) ? payload : [payload];
  const forward: JsonRpcMessage[] = [];
  const rejections: JsonRpcMessage[] = [];
  for (const message of list) {
    if (message && typeof message === "object" && message.method === "tools/call") {
      const decision = evaluateToolCall(compiled, { name: message.params?.name, arguments: message.params?.arguments });
      if (!decision.allowed) {
        if (message.id !== undefined) rejections.push(rejectionFor(message, decision));
        continue;
      }
    }
    forward.push(message);
  }
  if (forward.length === 0) return { forward: null, rejections };
  return { forward: Array.isArray(payload) ? forward : forward[0], rejections };
}

/**
 * Filters tools/list results in a server→client payload. `requestMethods`
 * maps request ids to the method the client sent, so only responses to
 * tools/list are touched. Returns a new object; the input is not mutated.
 */
export function filterServerMessage<T extends JsonRpcMessage | JsonRpcMessage[]>(
  policy: PolicyInput,
  payload: T,
  requestMethods: ReadonlyMap<string | number, string>,
): T {
  const compiled = asCompiled(policy);
  if (!compiled) return payload;
  const apply = (message: JsonRpcMessage): JsonRpcMessage => {
    if (!message || typeof message !== "object" || message.id === undefined || message.id === null) return message;
    if (requestMethods.get(message.id) !== "tools/list") return message;
    if (!message.result || !Array.isArray(message.result.tools)) return message;
    return { ...message, result: { ...message.result, tools: filterTools(compiled, message.result.tools) } };
  };
  return (Array.isArray(payload) ? payload.map(apply) : apply(payload)) as T;
}
