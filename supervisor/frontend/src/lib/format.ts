import type { Slot } from "./types";

export function display(value: string | number | null | undefined, fallback = "Not reported"): string {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

export function formatTimestamp(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not reported";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value * 1000);
}

export function formatElapsed(startedAt: number | null | undefined, now = Date.now() / 1000): string {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return "Start not reported";
  const seconds = Math.max(0, Math.floor(now - startedAt));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function isSafeHttpsReference(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function slotIsActive(slot: Slot): boolean {
  const state = (slot.task_state ?? "").toLowerCase();
  return !new Set(["complete", "completed", "done", "cancelled", "canceled", "failed"]).has(state);
}

export function statusTone(value: string | null | undefined): "working" | "waiting" | "idle" | "stale" | "unclean" | "quiet" {
  const status = (value ?? "").toLowerCase();
  if (["running", "working", "active"].includes(status)) return "working";
  if (["waiting", "queued", "blocked"].includes(status)) return "waiting";
  if (["stale", "unavailable", "unobserved", "unknown"].includes(status)) return "stale";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "unclean";
  if (["idle", "complete", "completed", "done"].includes(status)) return "idle";
  return "quiet";
}
