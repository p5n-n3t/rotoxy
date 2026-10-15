/** Bounded projection of the documented session-status parkedQuestion field. */
export type ParkedQuestion = {
  id?: string;
  text: string;
  choices?: string[];
  source: "provider";
  kind: "question" | "review" | "approval" | "unknown";
};

const MAX_QUESTION_BYTES = 2048;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SECRET_PATTERNS = [
  /\bBearer\s+[^\s,;]+/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)\s*[:=]\s*["']?[^\s,;"']+/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
];

export const OBSERVATION_FAILURE_CODES = [
  "http_status", "transport_error", "timeout", "malformed_protocol",
  "account_missing", "account_unavailable", "session_missing", "session_mismatch",
  "owner_mismatch", "observation_error",
] as const;
export type ObservationFailureCode = typeof OBSERVATION_FAILURE_CODES[number];
export type ObservationFailureDiagnostic = {
  accountId: string;
  sessionId: string;
  code: ObservationFailureCode;
  httpStatus?: number;
};

/** Safe typed failure: messages and upstream bodies are deliberately discarded. */
export class WorkerObservationFailure extends Error {
  readonly code: ObservationFailureCode;
  readonly httpStatus?: number;

  constructor(code: ObservationFailureCode, httpStatus?: number) {
    super(code);
    this.name = "WorkerObservationFailure";
    this.code = OBSERVATION_FAILURE_CODES.includes(code) ? code : "observation_error";
    if (Number.isInteger(httpStatus) && Number(httpStatus) >= 100 && Number(httpStatus) <= 599) this.httpStatus = Number(httpStatus);
  }
}

export function classifyObservationFailure(error: unknown): Pick<ObservationFailureDiagnostic, "code" | "httpStatus"> {
  if (!(error instanceof WorkerObservationFailure)) return { code: "observation_error" };
  return { code: error.code, ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}) };
}

/** Deduplicate by account/session and cap each cycle's emitted diagnostic list. */
export function boundObservationDiagnostics(
  diagnostics: readonly ObservationFailureDiagnostic[], limit = 20,
): { items: ObservationFailureDiagnostic[]; omitted: number } {
  const cap = Number.isInteger(limit) ? Math.max(0, Math.min(limit, 50)) : 20;
  const seen = new Set<string>();
  const unique: ObservationFailureDiagnostic[] = [];
  for (const item of diagnostics) {
    const accountId = /^[A-Za-z0-9_.:-]{1,160}$/.test(item.accountId) ? item.accountId : "unknown";
    const sessionId = /^[A-Za-z0-9_.:-]{1,160}$/.test(item.sessionId) ? item.sessionId : "unknown";
    const code: ObservationFailureCode = OBSERVATION_FAILURE_CODES.includes(item.code) ? item.code : "observation_error";
    const rawStatus = item.httpStatus;
    const httpStatus = Number.isInteger(rawStatus) && rawStatus !== undefined && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
    const key = `${accountId}\0${sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ accountId, sessionId, code, ...(httpStatus ? { httpStatus } : {}) });
  }
  return { items: unique.slice(0, cap), omitted: Math.max(0, unique.length - cap) };
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let text = value;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]");
  return text;
}

/** Unknown provider shapes remain unknown; never serialize the raw provider object. */
export function normalizeParkedQuestion(value: unknown): ParkedQuestion | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const text = safeText(raw.text ?? raw.question ?? raw.prompt);
  if (!text) return undefined;
  const kind = raw.kind === "review" || raw.kind === "approval" || raw.kind === "unknown" ? raw.kind : "question";
  const id = typeof raw.id === "string" && SAFE_ID.test(raw.id) ? raw.id : undefined;
  let choices: string[] | undefined;
  if (raw.choices !== undefined || raw.options !== undefined) {
    const source = raw.choices ?? raw.options;
    if (!Array.isArray(source) || source.length > 12) return undefined;
    const clean = source.map(safeText);
    if (clean.some((item) => item === undefined)) return undefined;
    choices = clean as string[];
  }
  const result: ParkedQuestion = { ...(id ? { id } : {}), text, ...(choices ? { choices } : {}), source: "provider", kind };
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_QUESTION_BYTES ? result : undefined;
}

/** Provider execution errors outrank an idle transport state. No raw error bodies leave this boundary. */
export function normalizeExecutionError(status: unknown): string | undefined {
  if (typeof status !== "object" || status === null || Array.isArray(status)) return undefined;
  const row = status as Record<string, unknown>;
  const code = row.errorCode;
  if (typeof code === "string" && code.trim()) {
    return /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : "provider_execution_error";
  }
  // Error messages can contain secrets; only project their existence, not their contents.
  if (typeof row.errorMessage === "string" && row.errorMessage.trim()) return "provider_execution_error";
  return undefined;
}

export type SessionObservation = {
  state: "running" | "idle" | "failed" | "cancelled" | "timed_out" | "unknown";
  errorCode?: string;
  needsInput: boolean;
  question?: ParkedQuestion;
};

/** A status read is evidence of observation only, never evidence of successful work. */
export function normalizeSessionObservation(status: unknown): SessionObservation {
  const row = typeof status === "object" && status !== null && !Array.isArray(status)
    ? status as Record<string, unknown> : {};
  const reported = row.sessionStatus ?? row.status ?? row.state;
  const errorCode = normalizeExecutionError(row);
  const raw = typeof reported === "string" ? reported.toLowerCase() : "";
  const state: SessionObservation["state"] = errorCode || ["failed", "interrupted", "error"].includes(raw) ? "failed"
    : ["cancelled", "canceled", "stopped"].includes(raw) ? "cancelled"
    : ["timeout", "timed_out", "timedout"].includes(raw) ? "timed_out"
    : raw === "running" ? "running" : raw === "idle" ? "idle" : "unknown";
  const parked = row.parkedQuestion;
  const needsInput = state !== "failed" && state !== "cancelled" && state !== "timed_out" &&
    parked !== undefined && parked !== null && parked !== false && parked !== "";
  const question = needsInput ? normalizeParkedQuestion(parked) : undefined;
  return { state, ...(errorCode ? { errorCode } : {}), needsInput, ...(question ? { question } : {}) };
}
