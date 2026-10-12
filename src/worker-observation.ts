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
