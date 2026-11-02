const DATE_FIELD = /(?:At|Until|Date)$/;
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function clean(value: string): string {
  return value.replace(TERMINAL_CONTROL, character => /[\r\n\t]/.test(character) ? " " : "");
}

function cell(value: unknown, key?: string): string {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number" && key && DATE_FIELD.test(key) && Number.isFinite(value) && value > 0) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return clean(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date));
  }
  if (Array.isArray(value)) return clean(value.map(item => typeof item === "object" && item !== null ? JSON.stringify(item) : String(item)).join(", ")) || "-";
  if (typeof value === "object") return clean(JSON.stringify(value));
  return clean(String(value));
}

function flattened(value: unknown, prefix = "", output: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) output.push([prefix || "value", "{}"]);
    else for (const [key, child] of entries) flattened(child, prefix ? `${prefix}.${key}` : key, output);
  } else {
    output.push([prefix || "value", value]);
  }
  return output;
}

export function formatKeyValues(value: unknown): string {
  const rows = flattened(value);
  if (!rows.length || rows.every(([, item]) => item === undefined || item === null)) return "(none)";
  const keyWidth = Math.max(...rows.map(([key]) => key.length));
  return rows.map(([key, item]) => `${key.padEnd(keyWidth)}  ${cell(item, key)}`).join("\n");
}

export function formatTable(rows: readonly Record<string, unknown>[], columns?: readonly string[]): string {
  if (!rows.length) return "(none)";
  const keys = columns ? [...columns] : [...new Set(rows.flatMap(row => Object.keys(row)))];
  const widths = keys.map(key => Math.min(32, Math.max(key.length, ...rows.map(row => Math.min(32, cell(row[key], key).length)))));
  const render = (values: string[]) => values.map((value, i) => {
    const width = widths[i]!;
    return value.length > width ? value.slice(0, Math.max(1, width - 1)) + "…" : value.padEnd(width);
  }).join("  ").trimEnd();
  const header = render(keys);
  const rule = widths.map(width => "─".repeat(width)).join("  ");
  return [header, rule, ...rows.map(row => render(keys.map(key => cell(row[key], key))))].join("\n");
}
