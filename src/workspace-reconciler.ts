import type { WorkspaceReconciliationBinding } from "./workspace-execution.js";

export interface WorkspaceReconcilerOptions {
  claim(limit: number): Promise<WorkspaceReconciliationBinding[]>;
  sync(binding: WorkspaceReconciliationBinding): Promise<unknown>;
  settle(binding: WorkspaceReconciliationBinding): Promise<void>;
  intervalMs?: number;
}

export interface WorkspaceReconcilerRun { claimed: number; settled: number; errors: number; skipped: boolean }

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL = new Set(["complete", "completed", "failed", "cancelled"]);
const DEFAULT_INTERVAL_MS = 30_000;
const CLAIM_LIMIT = 3;

function validBinding(value: unknown): value is WorkspaceReconciliationBinding {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.projectId === "string" && SAFE_ID.test(row.projectId) &&
    typeof row.jobId === "string" && SAFE_ID.test(row.jobId) &&
    typeof row.clientId === "string" && SAFE_ID.test(row.clientId);
}

function settlesSyncResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const dispatch = row.dispatch;
  if (!dispatch || typeof dispatch !== "object") return false;
  const state = (dispatch as Record<string, unknown>).state;
  return typeof state === "string" && TERMINAL.has(state.toLowerCase()) &&
    row.projectionPending === false && row.resultsUnavailable === false;
}

/** Polls only already-recorded bindings. It never submits or launches work. */
export class WorkspaceReconciler {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;
  private readonly intervalMs: number;

  constructor(private readonly options: WorkspaceReconcilerOptions) {
    const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 86_400_000) throw new TypeError("invalid reconciliation interval");
    this.intervalMs = interval;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<WorkspaceReconcilerRun> {
    if (this.stopped || this.running) return { claimed: 0, settled: 0, errors: 0, skipped: true };
    this.running = true;
    let claimed = 0;
    let settled = 0;
    let errors = 0;
    try {
      let bindings: WorkspaceReconciliationBinding[];
      try { bindings = await this.options.claim(CLAIM_LIMIT); }
      catch { return { claimed, settled, errors: 1, skipped: false }; }
      if (!Array.isArray(bindings)) return { claimed, settled, errors: 1, skipped: false };
      const seen = new Set<string>();
      for (const candidate of bindings.slice(0, CLAIM_LIMIT)) {
        if (this.stopped) break;
        if (!validBinding(candidate)) { errors++; continue; }
        const key = `${candidate.projectId}\0${candidate.clientId}\0${candidate.jobId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        claimed++;
        try {
          const result = await this.options.sync(candidate);
          if (!settlesSyncResult(result)) continue;
          await this.options.settle(candidate);
          settled++;
        } catch { errors++; }
      }
      return { claimed, settled, errors, skipped: false };
    } finally {
      this.running = false;
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref?.();
  }
}
