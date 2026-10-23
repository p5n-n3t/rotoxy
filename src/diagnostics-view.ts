export type DiagnosticLogMode = "readable" | "json";

export interface DiagnosticFormatOptions {
  /** Maximum characters returned for one formatted entry. Defaults to 6,000. */
  maxChars?: number;
}

export interface DiagnosticsViewOptions extends DiagnosticFormatOptions {
  /** Maximum number of entries rendered. Defaults to 200. */
  maxEntries?: number;
  /** Heading used by the standalone scaffold. */
  title?: string;
}

const DEFAULT_MAX_CHARS = 6_000;
const MAX_INPUT_CHARS = 24_000;
const DEFAULT_MAX_ENTRIES = 200;
const MAX_SANITIZED_NODES = 2_000;
const TRUNCATION_SUFFIX = "\n… [truncated]";
const REDACTED = "[REDACTED]";

type ParsedEntry = {
  record?: Record<string, unknown>;
  malformed?: string;
  sourceTruncated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maxCharsValue(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CHARS;
  return Math.max(64, Math.floor(value as number));
}

function bounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - TRUNCATION_SUFFIX.length)) + TRUNCATION_SUFFIX;
}

function keyLooksSensitive(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return [
    "authorization",
    "auth",
    "bearer",
    "token",
    "secret",
    "password",
    "passphrase",
    "credential",
    "cookie",
    "apikey",
    "privatekey",
    "clientsecret",
  ].some((needle) => normalized.includes(needle));
}

function redactText(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|passphrase|secret|auth(?:orization)?(?:[_-]?(?:header|token))?|cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1${REDACTED}`,
    );
}

function sanitizeValue(
  value: unknown,
  key: string,
  seen: WeakSet<object>,
  depth: number,
  budget: { remaining: number },
): unknown {
  budget.remaining -= 1;
  if (budget.remaining < 0) return "[field limit reached]";
  if (keyLooksSensitive(key)) return REDACTED;
  if (typeof value === "string") {
    const truncated = value.length > MAX_INPUT_CHARS;
    return redactText(value.slice(0, MAX_INPUT_CHARS)) + (truncated ? TRUNCATION_SUFFIX : "");
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (typeof value !== "object") return String(value);
  if (depth >= 6) return "[maximum nesting reached]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => sanitizeValue(item, "", seen, depth + 1, budget));
    if (value.length > 100) items.push(`[${value.length - 100} additional items omitted]`);
    return items;
  }

  const clean: Record<string, unknown> = {};
  let keys: string[];
  try {
    const allKeys = Object.keys(value).sort();
    keys = allKeys.slice(0, 100);
    if (allKeys.length > 100) clean["[additional fields omitted]"] = allKeys.length - 100;
  } catch {
    return "[unreadable object]";
  }
  for (const childKey of keys) {
    try {
      clean[childKey] = sanitizeValue(
        (value as Record<string, unknown>)[childKey],
        childKey,
        seen,
        depth + 1,
        budget,
      );
    } catch {
      clean[childKey] = "[unreadable value]";
    }
  }
  return clean;
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(record, "", new WeakSet(), 0, { remaining: MAX_SANITIZED_NODES }) as Record<string, unknown>;
}

function parseEntry(input: unknown): ParsedEntry {
  if (typeof input === "string") {
    const sourceTruncated = input.length > MAX_INPUT_CHARS;
    const source = input.slice(0, MAX_INPUT_CHARS);
    try {
      const parsed: unknown = JSON.parse(source);
      if (isRecord(parsed)) return { record: sanitizeRecord(parsed), sourceTruncated };
      return {
        record: {
          value: sanitizeValue(parsed, "", new WeakSet(), 0, { remaining: MAX_SANITIZED_NODES }),
        },
        sourceTruncated,
      };
    } catch {
      return { malformed: redactText(source), sourceTruncated };
    }
  }

  if (isRecord(input)) return { record: sanitizeRecord(input), sourceTruncated: false };
  return {
    record: {
      value: sanitizeValue(input, "", new WeakSet(), 0, { remaining: MAX_SANITIZED_NODES }),
    },
    sourceTruncated: false,
  };
}

function firstValue(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unavailable]";
  }
}

function displayTime(value: unknown): string {
  if (value === undefined) return "time unavailable";
  const numeric = typeof value === "number" ? value : undefined;
  let date: Date;
  if (numeric !== undefined) {
    date = new Date(Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1000 : numeric);
  } else {
    const text = String(value);
    const isoDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
    const isoWithoutZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/.test(text);
    const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(text);
    if (!isoDateOnly && !isoWithoutZone && !hasExplicitZone) return scalar(value);
    date = isoDateOnly || isoWithoutZone
      ? new Date(`${text}${isoDateOnly ? "T00:00:00Z" : "Z"}`)
      : new Date(text);
  }
  return Number.isNaN(date.getTime()) ? scalar(value) : date.toISOString();
}

function severity(value: unknown): string {
  const normalized = scalar(value ?? "unknown").toLowerCase();
  if (["trace", "debug"].includes(normalized)) return "DEBUG";
  if (["info", "notice"].includes(normalized)) return "INFO";
  if (["warn", "warning"].includes(normalized)) return "WARN";
  if (["error", "err"].includes(normalized)) return "ERROR";
  if (["fatal", "critical", "crit", "panic"].includes(normalized)) return "FATAL";
  return normalized.toUpperCase();
}

const COMMON_FIELDS = new Set([
  "timestamp", "time", "ts", "createdAt", "created_at", "severity", "level", "logLevel",
  "provider", "pool", "poolName", "account", "accountLabel", "accountId", "requestId",
  "request_id", "correlationId", "traceId", "sessionId", "session_id", "mcpSessionId",
  "Mcp-Session-Id", "message", "msg", "error", "event",
]);

function readableRecord(record: Record<string, unknown>): string {
  const time = displayTime(firstValue(record, ["timestamp", "time", "ts", "createdAt", "created_at"]));
  const level = severity(firstValue(record, ["severity", "level", "logLevel"]));
  const parts = [
    `provider=${scalar(firstValue(record, ["provider"]) ?? "unknown")}`,
    `pool/account=${scalar(firstValue(record, ["pool", "poolName", "accountLabel", "account", "accountId"]) ?? "unknown")}`,
    `request=${scalar(firstValue(record, ["requestId", "request_id", "correlationId", "traceId"]) ?? "unknown")}`,
    `session=${scalar(firstValue(record, ["sessionId", "session_id", "mcpSessionId", "Mcp-Session-Id"]) ?? "unknown")}`,
  ];
  const lines = [`${time}  ${level}  ${parts.join("  ")}`];
  const message = firstValue(record, ["message", "msg", "error", "event"]);
  if (message !== undefined) lines.push(`message: ${scalar(message)}`);

  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (!COMMON_FIELDS.has(key)) extra[key] = record[key];
  }
  if (Object.keys(extra).length) {
    lines.push("fields:");
    lines.push(JSON.stringify(extra, null, 2));
  }
  return lines.join("\n");
}

/** Format a structured log record without mutating its input or exposing likely secrets. */
export function formatDiagnosticEntry(
  input: unknown,
  mode: DiagnosticLogMode = "readable",
  options: DiagnosticFormatOptions = {},
): string {
  const maxChars = maxCharsValue(options.maxChars);
  const parsed = parseEntry(input);
  let output: string;
  if (parsed.malformed !== undefined) {
    output = `Malformed JSON log entry\n${parsed.malformed}`;
  } else if (mode === "json") {
    try {
      output = JSON.stringify(parsed.record, null, 2) ?? "{}";
    } catch {
      output = "[log entry could not be serialized]";
    }
  } else {
    output = readableRecord(parsed.record ?? {});
  }
  if (parsed.sourceTruncated) output += TRUNCATION_SUFFIX;
  return bounded(output, maxChars);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeTitle(value: string | undefined): string {
  return (value || "Diagnostics").slice(0, 120);
}

/** Render an accessible, script-free HTML scaffold for an authenticated diagnostics page. */
export function renderDiagnosticsView(
  entries: readonly unknown[],
  options: DiagnosticsViewOptions = {},
): string {
  const maxEntries = Number.isFinite(options.maxEntries)
    ? Math.max(1, Math.min(1_000, Math.floor(options.maxEntries as number)))
    : DEFAULT_MAX_ENTRIES;
  const title = safeTitle(options.title);
  const shown = entries.slice(0, maxEntries);
  const items = shown.map((entry, index) => {
    const readable = formatDiagnosticEntry(entry, "readable", options);
    const raw = formatDiagnosticEntry(entry, "json", options);
    const entryTitle = `Log entry ${index + 1}`;
    return `<li><article aria-labelledby="diagnostic-entry-${index + 1}"><h2 id="diagnostic-entry-${index + 1}">${entryTitle}</h2><pre aria-label="Readable log entry">${escapeHtml(readable)}</pre><details><summary>Show redacted raw JSON</summary><pre aria-label="Redacted raw JSON">${escapeHtml(raw)}</pre></details></article></li>`;
  }).join("");
  const omitted = entries.length > shown.length
    ? `<p role="status">${entries.length - shown.length} older entr${entries.length - shown.length === 1 ? "y was" : "ies were"} omitted by the display limit.</p>`
    : "";
  const empty = shown.length ? "" : "<p>No diagnostic entries are available.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><section aria-labelledby="diagnostics-heading"><h1 id="diagnostics-heading">${escapeHtml(title)}</h1><p>Upstream provider log availability is unknown. This view displays only records supplied to ROTOXY.</p>${omitted}${empty}<ol aria-label="Diagnostic log entries">${items}</ol></section></main></body></html>`;
}
