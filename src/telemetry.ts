// Bounded, dependency-free telemetry primitives for the gateway.
//
// Two record families are deliberately kept apart:
//   - Gateway events (request / attempt / probe): what Token2OAuth itself
//     observed — HTTP status, latency, retries, outcome.
//   - Provider usage (tokens / model / credits): values a provider reported
//     through a real usage signal. They are optional, always carry their
//     source, timestamp and unit, and may be explicitly "unavailable".
// Nothing in this module derives provider usage from gateway events: an HTTP
// 200 or a request count is never treated as credit consumption.
//
// Not wired into server/proxy/ui yet; see docs/TELEMETRY.md.

export type GatewayEventKind = "request" | "attempt" | "probe";
export type GatewayOutcome = "success" | "error";

export const GATEWAY_EVENT_KINDS: readonly GatewayEventKind[] = ["request", "attempt", "probe"];

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

export class RingBuffer<T> {
  private items: (T | undefined)[];
  private start = 0;
  private length = 0;
  private droppedCount = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("RingBuffer capacity must be a positive integer");
    }
    this.items = new Array(capacity);
  }

  push(item: T): void {
    if (this.length < this.capacity) {
      this.items[(this.start + this.length) % this.capacity] = item;
      this.length += 1;
      return;
    }
    this.items[this.start] = item;
    this.start = (this.start + 1) % this.capacity;
    this.droppedCount += 1;
  }

  get size(): number {
    return this.length;
  }

  /** Number of items evicted because the buffer was full. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Items ordered oldest to newest. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.length; i += 1) {
      out.push(this.items[(this.start + i) % this.capacity] as T);
    }
    return out;
  }

  clear(): void {
    this.items = new Array(this.capacity);
    this.start = 0;
    this.length = 0;
    this.droppedCount = 0;
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export const REDACTED = "[REDACTED]";

export interface RedactOptions {
  maxDepth?: number;
  maxStringLength?: number;
  maxKeys?: number;
  maxArrayItems?: number;
}

const REDACT_DEFAULTS: Required<RedactOptions> = {
  maxDepth: 6,
  maxStringLength: 512,
  maxKeys: 50,
  maxArrayItems: 50,
};

const SECRET_KEY_FRAGMENTS = [
  "authorization",
  "cookie",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "apikey",
  "privatekey",
  "accesskey",
  "credential",
  "bearer",
  "sessionid",
  "signature",
];
const SECRET_KEY_EXACT = new Set(["auth", "pwd", "pass", "jwt", "otp", "pin", "cvv"]);

/**
 * True when an object key names a secret. Keys are compared case- and
 * separator-insensitively, so `X-Api-Key`, `api_key` and `apiKey` all match.
 * Keys ending in "token" (access_token, refresh_token, id_token) match, while
 * usage counters such as `input_tokens` or `max_tokens` do not.
 */
export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return false;
  if (SECRET_KEY_EXACT.has(normalized)) return true;
  if (normalized.endsWith("token")) return true;
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

const SECRET_VALUE_PATTERNS: [RegExp, string][] = [
  // Authorization schemes.
  // Credentials contain a digit/symbol or are long, so prose like "basic usage" survives.
  [
    /\b(Bearer|Basic|Token|Digest)\s+(?:(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{24,})/gi,
    `$1 ${REDACTED}`,
  ],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Well-known provider key prefixes.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // key=value pairs in query strings, form bodies and cookie headers.
  [
    /\b((?:access_|refresh_|id_|session_|auth_)?token|api[_-]?key|apikey|key|password|passwd|secret|client_secret|code_verifier|code|sig|signature)=([^&\s;"',]+)/gi,
    `$1=${REDACTED}`,
  ],
  // "key": "value" pairs inside serialized JSON strings.
  [
    /("(?:[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|cookie|credential))"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    `$1"${REDACTED}"`,
  ],
];

// C0/C1 controls plus bidi overrides/isolates, which can disguise log lines.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;
const LINE_BREAKS = /[\t\n\r]/g;

/** Remove control characters; tabs and line breaks become single spaces. */
export function stripControlChars(value: string): string {
  return value.replace(LINE_BREAKS, " ").replace(CONTROL_CHARS, "");
}

/** Scrub secrets that appear inside free text (headers, bodies, URLs, errors). */
export function redactString(value: string, maxLength = REDACT_DEFAULTS.maxStringLength): string {
  let out = stripControlChars(value);
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return truncate(out, maxLength);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[+${value.length - maxLength} chars]`;
}

/**
 * Return a JSON-safe, bounded copy of `value` with secrets removed.
 * Handles cycles, deep nesting, huge strings/arrays/objects, binary data,
 * errors, functions and other non-JSON values. Never throws.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const opts = { ...REDACT_DEFAULTS, ...options };
  const ancestors = new WeakSet<object>();

  const visit = (input: unknown, depth: number): unknown => {
    if (input === null || input === undefined) return input ?? null;
    switch (typeof input) {
      case "string":
        return redactString(input, opts.maxStringLength);
      case "number":
        return Number.isFinite(input) ? input : String(input);
      case "boolean":
        return input;
      case "bigint":
        return input.toString();
      case "symbol":
        return "[Symbol]";
      case "function":
        return "[Function]";
    }
    const obj = input as object;
    if (obj instanceof Date) {
      return Number.isFinite(obj.getTime()) ? obj.toISOString() : "[Invalid Date]";
    }
    if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
      return `[Binary ${(obj as ArrayBuffer).byteLength} bytes]`;
    }
    if (ancestors.has(obj)) return "[Circular]";
    if (depth >= opts.maxDepth) return "[MaxDepth]";
    ancestors.add(obj);
    try {
      if (obj instanceof Error) {
        return {
          name: redactString(obj.name, 64),
          message: redactString(obj.message, opts.maxStringLength),
        };
      }
      if (Array.isArray(obj)) {
        const items = obj.slice(0, opts.maxArrayItems).map((item) => visit(item, depth + 1));
        if (obj.length > opts.maxArrayItems) items.push(`[+${obj.length - opts.maxArrayItems} more]`);
        return items;
      }
      const entries: [string, unknown][] =
        obj instanceof Map ? [...obj.entries()].map(([k, v]) => [String(k), v]) : Object.entries(obj);
      const out: Record<string, unknown> = {};
      for (const [rawKey, child] of entries.slice(0, opts.maxKeys)) {
        const key = truncate(stripControlChars(rawKey), 128);
        out[key] = isSecretKey(rawKey) ? REDACTED : visit(child, depth + 1);
      }
      if (entries.length > opts.maxKeys) out["[truncated]"] = `+${entries.length - opts.maxKeys} keys`;
      return out;
    } catch {
      return "[Unserializable]";
    } finally {
      ancestors.delete(obj);
    }
  };

  return visit(value, 0);
}

// ---------------------------------------------------------------------------
// Gateway events
// ---------------------------------------------------------------------------

export interface GatewayEventInput {
  kind: GatewayEventKind;
  /** Epoch milliseconds, Date or ISO string. Defaults to the recorder clock. */
  at?: number | Date | string;
  method?: string;
  tool?: string;
  /** Verified OAuth access-token client_id; never derived from request content. */
  clientId?: string;
  accountId?: string;
  pool?: string;
  requestId?: string;
  status?: number;
  latencyMs?: number;
  retries?: number;
  /** Defaults from status: 1xx–3xx success, otherwise error. */
  outcome?: GatewayOutcome;
  /** Short classification such as "quota", "auth-failed", "network". */
  errorClass?: string;
  message?: string;
  /** Only kept when the recorder was built with capturePayloads: true. */
  payload?: unknown;
}

export interface GatewayEvent {
  scope: "gateway";
  kind: GatewayEventKind;
  at: number;
  method?: string;
  tool?: string;
  clientId?: string;
  accountId?: string;
  pool?: string;
  requestId?: string;
  status?: number;
  latencyMs?: number;
  retries: number;
  outcome: GatewayOutcome;
  errorClass?: string;
  message?: string;
  payload?: unknown;
}

function toEpochMs(value: number | Date | string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
  return Number.isFinite(ms) ? ms : fallback;
}

function cleanDimension(value: unknown, maxLength = 128): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = truncate(stripControlChars(String(value)).trim(), maxLength);
  return text ? text : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function deriveOutcome(status: number | undefined, errorClass?: string): GatewayOutcome {
  if (errorClass) return "error";
  if (status === undefined) return "error";
  return status >= 100 && status < 400 ? "success" : "error";
}

// ---------------------------------------------------------------------------
// Provider usage
// ---------------------------------------------------------------------------

export type ProviderUsageMetric =
  | "input_tokens"
  | "output_tokens"
  | "total_tokens"
  | "credits_used"
  | "credits_remaining"
  | (string & {});

export interface ProviderUsageInput {
  metric: ProviderUsageMetric;
  /** Where the value came from, e.g. "provider-usage-api" or "response-header:x-credits-remaining". */
  source: string;
  /** When the provider observed/reported the value. Required: usage without a timestamp is not recorded. */
  observedAt: number | Date | string;
  /** Required when the value is reported, e.g. "tokens", "credits", "usd". */
  unit?: string;
  /** null/undefined means unavailable. */
  value?: number | null;
  accountId?: string;
  pool?: string;
  model?: string;
  /** Explanation when the value is unavailable. */
  reason?: string;
}

export type ProviderUsageRecord = {
  scope: "provider";
  metric: string;
  source: string;
  observedAt: number;
  recordedAt: number;
  accountId?: string;
  pool?: string;
  model?: string;
} & (
  | { availability: "reported"; value: number; unit: string }
  | { availability: "unavailable"; value: null; unit?: string; reason?: string }
);

/**
 * Validate and normalize a provider-reported usage value. Throws TypeError on
 * missing source/observedAt/metric, or a reported value without a unit.
 */
export function normalizeProviderUsage(input: ProviderUsageInput, recordedAt: number): ProviderUsageRecord {
  const metric = cleanDimension(input.metric, 64);
  const source = cleanDimension(input.source, 128);
  if (!metric) throw new TypeError("provider usage requires a metric");
  if (!source) throw new TypeError("provider usage requires a source");
  const observedAt = toEpochMs(input.observedAt, Number.NaN);
  if (!Number.isFinite(observedAt)) throw new TypeError("provider usage requires a valid observedAt");
  const common = {
    scope: "provider" as const,
    metric,
    source,
    observedAt,
    recordedAt,
    accountId: cleanDimension(input.accountId),
    pool: cleanDimension(input.pool),
    model: cleanDimension(input.model),
  };
  const unit = cleanDimension(input.unit, 32);
  if (input.value === null || input.value === undefined) {
    return {
      ...common,
      availability: "unavailable",
      value: null,
      unit,
      reason: input.reason === undefined ? undefined : redactString(input.reason, 256),
    };
  }
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    throw new TypeError("provider usage value must be a finite number or null");
  }
  if (!unit) throw new TypeError("reported provider usage requires a unit");
  return { ...common, availability: "reported", value: input.value, unit };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface LatencyStats {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
}

export interface AggregateStats {
  count: number;
  success: number;
  error: number;
  /** error / count, or 0 when empty. */
  errorRate: number;
  retries: number;
  statusClasses: Record<string, number>;
  errorClasses: Record<string, number>;
  latency: LatencyStats;
}

export type Dimension = "kind" | "method" | "tool" | "clientId" | "accountId" | "pool";
export const DIMENSIONS: readonly Dimension[] = ["kind", "method", "tool", "clientId", "accountId", "pool"];
export const OTHER_BUCKET = "(other)";
export const UNSET_BUCKET = "(none)";

export interface GatewaySummary {
  scope: "gateway";
  /** Events considered; bounded by recorder capacity. */
  window: { events: number; from: number | null; to: number | null; droppedFromRing: number };
  total: AggregateStats;
  by: Record<Dimension, Record<string, AggregateStats>>;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

function statusClass(status: number | undefined): string {
  if (status === undefined) return "none";
  return status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : "other";
}

export function aggregate(events: readonly GatewayEvent[]): AggregateStats {
  let success = 0;
  let retries = 0;
  const latencies: number[] = [];
  const statusClasses: Record<string, number> = {};
  const errorClasses: Record<string, number> = {};
  for (const event of events) {
    if (event.outcome === "success") success += 1;
    retries += event.retries;
    if (event.latencyMs !== undefined) latencies.push(event.latencyMs);
    const cls = statusClass(event.status);
    statusClasses[cls] = (statusClasses[cls] ?? 0) + 1;
    if (event.outcome === "error") {
      const key = event.errorClass ?? (event.status !== undefined ? `http-${event.status}` : "unknown");
      errorClasses[key] = (errorClasses[key] ?? 0) + 1;
    }
  }
  latencies.sort((a, b) => a - b);
  const count = events.length;
  const sum = latencies.reduce((acc, value) => acc + value, 0);
  return {
    count,
    success,
    error: count - success,
    errorRate: count === 0 ? 0 : (count - success) / count,
    retries,
    statusClasses,
    errorClasses,
    latency: {
      count: latencies.length,
      min: latencies.length ? latencies[0] : null,
      max: latencies.length ? latencies[latencies.length - 1] : null,
      mean: latencies.length ? sum / latencies.length : null,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
  };
}

/**
 * Group events by a dimension. At most `maxValues` distinct values are kept
 * (most frequent first); the remainder are folded into "(other)".
 */
export function aggregateBy(
  events: readonly GatewayEvent[],
  dimension: Dimension,
  maxValues = 50,
): Record<string, AggregateStats> {
  const groups = new Map<string, GatewayEvent[]>();
  for (const event of events) {
    const key = (event[dimension] as string | undefined) ?? UNSET_BUCKET;
    const list = groups.get(key);
    if (list) list.push(event);
    else groups.set(key, [event]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const out: Record<string, AggregateStats> = {};
  const overflow: GatewayEvent[] = [];
  ordered.forEach(([key, list], index) => {
    if (index < maxValues) out[key] = aggregate(list);
    else overflow.push(...list);
  });
  if (overflow.length) out[OTHER_BUCKET] = aggregate(overflow);
  return out;
}

// ---------------------------------------------------------------------------
// Time buckets
// ---------------------------------------------------------------------------

export interface TimeBucket {
  start: number;
  end: number;
  count: number;
  success: number;
  error: number;
  retries: number;
  latencySum: number;
  latencyCount: number;
  latencyMax: number | null;
  byKind: Record<GatewayEventKind, number>;
}

function emptyBucket(start: number, bucketMs: number): TimeBucket {
  return {
    start,
    end: start + bucketMs,
    count: 0,
    success: 0,
    error: 0,
    retries: 0,
    latencySum: 0,
    latencyCount: 0,
    latencyMax: null,
    byKind: { request: 0, attempt: 0, probe: 0 },
  };
}

/**
 * Fixed-size rolling time series. Memory is O(bucketCount) regardless of
 * traffic; events older than the window are ignored.
 */
export class TimeBuckets {
  private slots: (TimeBucket | undefined)[];

  constructor(
    readonly bucketMs: number,
    readonly bucketCount: number,
  ) {
    if (!Number.isInteger(bucketMs) || bucketMs < 1) throw new RangeError("bucketMs must be a positive integer");
    if (!Number.isInteger(bucketCount) || bucketCount < 1) {
      throw new RangeError("bucketCount must be a positive integer");
    }
    this.slots = new Array(bucketCount);
  }

  private slotFor(at: number): { index: number; start: number } {
    const n = Math.floor(at / this.bucketMs);
    return { index: ((n % this.bucketCount) + this.bucketCount) % this.bucketCount, start: n * this.bucketMs };
  }

  /** Returns false when the event is too old for the slot it maps to. */
  add(event: GatewayEvent): boolean {
    const { index, start } = this.slotFor(event.at);
    let slot = this.slots[index];
    if (!slot || slot.start < start) {
      slot = emptyBucket(start, this.bucketMs);
      this.slots[index] = slot;
    } else if (slot.start > start) {
      return false;
    }
    slot.count += 1;
    if (event.outcome === "success") slot.success += 1;
    else slot.error += 1;
    slot.retries += event.retries;
    slot.byKind[event.kind] += 1;
    if (event.latencyMs !== undefined) {
      slot.latencySum += event.latencyMs;
      slot.latencyCount += 1;
      slot.latencyMax = slot.latencyMax === null ? event.latencyMs : Math.max(slot.latencyMax, event.latencyMs);
    }
    return true;
  }

  /** The full window ending at `now`, oldest first, with empty buckets filled in. */
  snapshot(now: number): TimeBucket[] {
    const { start: newest } = this.slotFor(now);
    const out: TimeBucket[] = [];
    for (let i = this.bucketCount - 1; i >= 0; i -= 1) {
      const start = newest - i * this.bucketMs;
      const slot = this.slots[this.slotFor(start).index];
      out.push(slot && slot.start === start ? structuredClone(slot) : emptyBucket(start, this.bucketMs));
    }
    return out;
  }

  clear(): void {
    this.slots = new Array(this.bucketCount);
  }
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export interface TelemetryOptions {
  /** Max gateway events kept in memory. Default 1000. */
  capacity?: number;
  /** Max provider usage records kept in memory. Default 500. */
  providerCapacity?: number;
  /** Width of each time bucket. Default 60 000 ms. */
  bucketMs?: number;
  /** Number of time buckets. Default 60 (one hour at the default width). */
  bucketCount?: number;
  /** Keep a redacted request payload on events. Default false. */
  capturePayloads?: boolean;
  /** Redaction limits applied to captured payloads. */
  payloadLimits?: RedactOptions;
  /** Max distinct values per dimension in summaries. Default 50. */
  maxDimensionValues?: number;
  now?: () => number;
}

export class TelemetryRecorder {
  readonly capturePayloads: boolean;
  private readonly events: RingBuffer<GatewayEvent>;
  private readonly usage: RingBuffer<ProviderUsageRecord>;
  private readonly buckets: TimeBuckets;
  private readonly payloadLimits: RedactOptions;
  private readonly maxDimensionValues: number;
  private readonly now: () => number;
  private totalRecorded = 0;

  constructor(options: TelemetryOptions = {}) {
    this.capturePayloads = options.capturePayloads === true;
    this.events = new RingBuffer(options.capacity ?? 1000);
    this.usage = new RingBuffer(options.providerCapacity ?? 500);
    this.buckets = new TimeBuckets(options.bucketMs ?? 60_000, options.bucketCount ?? 60);
    this.payloadLimits = { maxDepth: 4, maxStringLength: 256, maxKeys: 30, maxArrayItems: 20, ...options.payloadLimits };
    this.maxDimensionValues = options.maxDimensionValues ?? 50;
    this.now = options.now ?? Date.now;
  }

  recordGateway(input: GatewayEventInput): GatewayEvent {
    if (!GATEWAY_EVENT_KINDS.includes(input.kind)) {
      throw new TypeError(`unknown gateway event kind: ${String(input.kind)}`);
    }
    const status =
      typeof input.status === "number" && Number.isInteger(input.status) ? input.status : undefined;
    const errorClass = cleanDimension(input.errorClass, 64);
    const event: GatewayEvent = {
      scope: "gateway",
      kind: input.kind,
      at: toEpochMs(input.at, this.now()),
      method: cleanDimension(input.method),
      tool: cleanDimension(input.tool),
      clientId: cleanDimension(input.clientId, 128)?.slice(0, 128),
      accountId: cleanDimension(input.accountId),
      pool: cleanDimension(input.pool),
      requestId: cleanDimension(input.requestId, 64),
      status,
      latencyMs: nonNegative(input.latencyMs),
      retries: Math.floor(nonNegative(input.retries) ?? 0),
      outcome:
        input.outcome === "success" || input.outcome === "error"
          ? input.outcome
          : deriveOutcome(status, errorClass),
      errorClass,
      message: input.message === undefined ? undefined : redactString(String(input.message), 256),
    };
    if (this.capturePayloads && input.payload !== undefined) {
      event.payload = redact(input.payload, this.payloadLimits);
    }
    for (const key of Object.keys(event) as (keyof GatewayEvent)[]) {
      if (event[key] === undefined) delete event[key];
    }
    this.events.push(event);
    this.buckets.add(event);
    this.totalRecorded += 1;
    return event;
  }

  /** Record a provider-reported usage value. Never called implicitly from gateway events. */
  recordProviderUsage(input: ProviderUsageInput): ProviderUsageRecord {
    const record = normalizeProviderUsage(input, this.now());
    for (const key of Object.keys(record) as (keyof ProviderUsageRecord)[]) {
      if (record[key] === undefined) delete record[key];
    }
    this.usage.push(record);
    return record;
  }

  /** Most recent gateway events, newest first. */
  recent(options: { limit?: number; kind?: GatewayEventKind } = {}): GatewayEvent[] {
    const limit = Math.max(0, options.limit ?? 50);
    const out: GatewayEvent[] = [];
    const all = this.events.toArray();
    for (let i = all.length - 1; i >= 0 && out.length < limit; i -= 1) {
      if (!options.kind || all[i].kind === options.kind) out.push(all[i]);
    }
    return out;
  }

  summary(options: { since?: number } = {}): GatewaySummary {
    const events = this.events.toArray().filter((event) => options.since === undefined || event.at >= options.since);
    const by = {} as Record<Dimension, Record<string, AggregateStats>>;
    for (const dimension of DIMENSIONS) by[dimension] = aggregateBy(events, dimension, this.maxDimensionValues);
    return {
      scope: "gateway",
      window: {
        events: events.length,
        from: events.length ? Math.min(...events.map((e) => e.at)) : null,
        to: events.length ? Math.max(...events.map((e) => e.at)) : null,
        droppedFromRing: this.events.dropped,
      },
      total: aggregate(events),
      by,
    };
  }

  timeSeries(): TimeBucket[] {
    return this.buckets.snapshot(this.now());
  }

  /** Provider usage records, oldest first. */
  providerUsage(): ProviderUsageRecord[] {
    return this.usage.toArray();
  }

  /** Latest record per account/pool/model/metric, by observedAt. */
  latestProviderUsage(): ProviderUsageRecord[] {
    const latest = new Map<string, ProviderUsageRecord>();
    for (const record of this.usage.toArray()) {
      const key = JSON.stringify([record.accountId, record.pool, record.model, record.metric]);
      const prev = latest.get(key);
      if (!prev || record.observedAt >= prev.observedAt) latest.set(key, record);
    }
    return [...latest.values()];
  }

  stats(): { recorded: number; retained: number; dropped: number; providerRetained: number } {
    return {
      recorded: this.totalRecorded,
      retained: this.events.size,
      dropped: this.events.dropped,
      providerRetained: this.usage.size,
    };
  }

  clear(): void {
    this.events.clear();
    this.usage.clear();
    this.buckets.clear();
    this.totalRecorded = 0;
  }
}

// ---------------------------------------------------------------------------
// Human-readable formatting (the rendering boundary)
// ---------------------------------------------------------------------------

const BARE_VALUE = /^[A-Za-z0-9._:/@+%-]+$/;

/**
 * Render any value as a single safe logfmt-style token. Plain values are left
 * bare; anything else is double-quoted with backslash escapes, and every
 * control, bidi or other non-printable character becomes a \uXXXX escape, so
 * user-supplied text cannot inject new lines or fake fields.
 */
export function escapeLogValue(value: unknown, maxLength = 256): string {
  const text = truncate(typeof value === "string" ? value : safeJson(value), maxLength);
  if (text !== "" && BARE_VALUE.test(text)) return text;
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else out += char;
  }
  return `${out}"`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[Unserializable]";
  }
}

function field(name: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return `${name}=${escapeLogValue(value)}`;
}

function isoTime(ms: number): string {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "invalid-time";
}

/**
 * One-line human-readable rendering of a gateway event, e.g.
 * `2026-10-07T06:00:00.000Z request ok method=tools/call tool=search account=a1 status=200 latency=120ms retries=1`
 * Values are redacted (in case the event was built by hand) and escaped here.
 */
export function formatGatewayEvent(event: GatewayEvent): string {
  const parts = [
    isoTime(event.at),
    escapeLogValue(event.kind),
    event.outcome === "success" ? "ok" : "error",
    field("method", event.method),
    field("tool", event.tool),
    field("account", event.accountId),
    field("pool", event.pool),
    field("request", event.requestId),
    field("status", event.status),
    event.latencyMs === undefined ? undefined : `latency=${Math.round(event.latencyMs)}ms`,
    event.retries ? `retries=${event.retries}` : undefined,
    field("error", event.errorClass),
    field("msg", event.message === undefined ? undefined : redactString(event.message, 256)),
    event.payload === undefined ? undefined : field("payload", safeJson(redact(event.payload))),
  ];
  return parts.filter(Boolean).join(" ");
}

/** One-line rendering of a provider usage record, including its source and observation time. */
export function formatProviderUsage(record: ProviderUsageRecord): string {
  const parts = [
    isoTime(record.observedAt),
    "provider-usage",
    field("metric", record.metric),
    record.availability === "reported" ? field("value", record.value) : "value=unavailable",
    field("unit", record.unit),
    field("account", record.accountId),
    field("pool", record.pool),
    field("model", record.model),
    field("source", record.source),
    record.availability === "unavailable" ? field("reason", record.reason) : undefined,
  ];
  return parts.filter(Boolean).join(" ");
}

function formatStats(stats: AggregateStats): string {
  const latency =
    stats.latency.count === 0
      ? "latency=n/a"
      : `p50=${Math.round(stats.latency.p50 ?? 0)}ms p95=${Math.round(stats.latency.p95 ?? 0)}ms max=${Math.round(stats.latency.max ?? 0)}ms`;
  return `count=${stats.count} ok=${stats.success} error=${stats.error} error_rate=${(stats.errorRate * 100).toFixed(1)}% retries=${stats.retries} ${latency}`;
}

/** Multi-line plain-text rendering of a gateway summary for CLI/diagnostics output. */
export function formatSummary(summary: GatewaySummary): string {
  const lines = [
    `gateway telemetry (${summary.window.events} events` +
      (summary.window.from !== null && summary.window.to !== null
        ? ` from ${isoTime(summary.window.from)} to ${isoTime(summary.window.to)}`
        : "") +
      (summary.window.droppedFromRing ? `, ${summary.window.droppedFromRing} older events evicted` : "") +
      ")",
    `  total ${formatStats(summary.total)}`,
  ];
  for (const dimension of DIMENSIONS) {
    const entries = Object.entries(summary.by[dimension]);
    if (entries.length === 0 || (entries.length === 1 && entries[0][0] === UNSET_BUCKET)) continue;
    lines.push(`  by ${dimension}:`);
    for (const [key, stats] of entries) lines.push(`    ${escapeLogValue(key)} ${formatStats(stats)}`);
  }
  return lines.join("\n");
}
