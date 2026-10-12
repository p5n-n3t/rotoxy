import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type CreditProvider = "lightsprint" | "exa";
export type CreditUnit = "credits" | "USD";
export type ReportSource = "provider-reported" | "user-reported";
export type UsageSource = ReportSource | "estimated";
export type ReservationState = "reserved" | "inflight" | "released" | "captured";
export const LIGHTSPRINT_MONTHLY_ALLOWANCE = 10_000_000;
const FILE_NAME = "credit-snapshots.json";
const LOCK_NAME = "credit-snapshots.lock";
const MAX_LEDGER_ROWS = 20_000;
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;

export interface CreditAccount {
  provider: CreditProvider;
  accountId: string;
  label: string;
  unit: CreditUnit;
}

export interface BalanceSnapshot {
  auditId: string;
  provider: CreditProvider;
  accountId: string;
  unit: CreditUnit;
  remaining: number;
  observedAt: number;
  source: ReportSource;
  refreshDate?: string;
  previousRemaining?: number;
  previousSource?: ReportSource;
}

export interface UsageEntry {
  id: string;
  provider: CreditProvider;
  accountId: string;
  unit: CreditUnit;
  amount: number;
  source: UsageSource;
  observedAt: number;
  provenance?: string;
  model?: string;
  slot?: string;
}

export interface ReservationEntry {
  id: string;
  provider: CreditProvider;
  accountId: string;
  unit: CreditUnit;
  amount: number;
  state: ReservationState;
  observedAt: number;
}

export interface RenewalEntry {
  provider: "lightsprint";
  accountId: string;
  verifiedAt: number;
  auditId: string;
  evidence: string;
}

export interface CreditSnapshotState {
  version: 1;
  snapshots: BalanceSnapshot[];
  usage: UsageEntry[];
  reservations: ReservationEntry[];
  renewals: RenewalEntry[];
}

export interface CreditSnapshotStoreOptions {
  directory?: string;
  lockTimeoutMs?: number;
  retryDelayMs?: number;
}

export interface ModelSlotUsage {
  provider: CreditProvider;
  accountId: string;
  model: string;
  slot: string;
  observedUsage: number;
  unit: string;
}

export interface SessionSpend {
  provider: CreditProvider;
  accountId: string;
  amountUsd: number;
  observedAt: number;
  source: ReportSource | "estimated";
  provenance?: string;
}

export interface AccountCreditView {
  account: CreditAccount;
  balanceSnapshot: null | { remaining: number; source: ReportSource; observedAt: number; stale: boolean; staleReason?: string; refreshDate?: string };
  monthlyAllowance: number | null;
  estimatedRemaining: number | null;
  estimateProvenance: string;
  estimateReason?: string;
  debitsBySource: Record<UsageSource, number>;
  reserved: number;
  inflight: number;
  availableAfterHolds: number | null;
  observedSessionSpendUsd: number;
  modelSlotUsage: Array<{ model: string; slot: string; observedUsage: number; unit: string; debit: null; debitReason: string }>;
}

function expectedUnit(provider: CreditProvider): CreditUnit { return provider === "lightsprint" ? "credits" : "USD"; }
function validId(value: string, label: string): string {
  const id = value.trim();
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw new TypeError(`${label} must be a non-empty, control-free ID`);
  return id;
}
function validNumber(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be finite and non-negative`);
  return value;
}
function validTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(new Date(value).getTime())) throw new TypeError(`${label} must be a valid epoch-millisecond timestamp`);
  return value;
}
function validUnit(provider: CreditProvider, unit: string): asserts unit is CreditUnit {
  if (unit !== expectedUnit(provider)) throw new TypeError(`${provider} requires unit ${expectedUnit(provider)}`);
}
function validateRefreshDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new TypeError("refreshDate is not a real calendar date");
    return value;
  }
  if (/^\d{2}-\d{2}$/.test(value)) {
    const [month, day] = value.split("-").map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31) throw new TypeError("refreshDate must be MM-DD or YYYY-MM-DD");
    return value;
  }
  throw new TypeError("refreshDate must be MM-DD or YYYY-MM-DD; no year/time is inferred");
}

/** Return every configured LightSprint/Exa account; do not trim to currently active runtime workers. */
export function listCreditAccounts(config: { accounts: readonly { id: string; label: string; provider: string }[] }): CreditAccount[] {
  return config.accounts.flatMap((account) => {
    if (account.provider !== "lightsprint" && account.provider !== "exa") return [];
    const provider = account.provider;
    return [{ provider, accountId: validId(account.id, "accountId"), label: account.label, unit: expectedUnit(provider) }];
  });
}

function emptyState(): CreditSnapshotState { return { version: 1, snapshots: [], usage: [], reservations: [], renewals: [] }; }

/** Private, append-only financial evidence store. File replacement is atomic and serialized across processes. */
export class CreditSnapshotStore {
  private readonly directory: string;
  private readonly file: string;
  private readonly lockFile: string;
  private readonly accounts: Map<string, CreditAccount>;
  private readonly lockTimeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(accounts: readonly CreditAccount[], options: CreditSnapshotStoreOptions = {}) {
    this.directory = options.directory ?? process.env.TOKEN2OAUTH_CONFIG_DIR ?? path.join(os.homedir(), ".config", "token2oauth");
    this.file = path.join(this.directory, FILE_NAME);
    this.lockFile = path.join(this.directory, LOCK_NAME);
    this.accounts = new Map();
    for (const account of accounts) {
      validUnit(account.provider, account.unit);
      const key = this.key(account.provider, validId(account.accountId, "accountId"));
      if (this.accounts.has(key)) throw new TypeError(`duplicate account ${account.provider}/${account.accountId}`);
      this.accounts.set(key, account);
    }
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.retryDelayMs = options.retryDelayMs ?? 10;
  }

  private key(provider: CreditProvider, accountId: string) { return `${provider}\0${accountId}`; }
  private account(provider: CreditProvider, accountId: string, unit: string) {
    if (provider !== "lightsprint" && provider !== "exa") throw new TypeError("unsupported credit provider");
    validUnit(provider, unit);
    const result = this.accounts.get(this.key(provider, validId(accountId, "accountId")));
    if (!result) throw new TypeError(`unknown account ${provider}/${accountId}`);
    return result;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockTimeoutMs;
    let handle;
    while (!handle) {
      try { handle = await fs.open(this.lockFile, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("timed out waiting for credit snapshot file lock");
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      return await operation();
    } finally {
      await handle.close();
      await fs.rm(this.lockFile, { force: true });
    }
  }

  private async readUnlocked(): Promise<CreditSnapshotState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as CreditSnapshotState;
      if (parsed.version !== 1 || !Array.isArray(parsed.snapshots) || !Array.isArray(parsed.usage) || !Array.isArray(parsed.reservations) || !Array.isArray(parsed.renewals)) throw new Error("invalid credit snapshot ledger shape");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  private async writeUnlocked(state: CreditSnapshotState): Promise<void> {
    const total = state.snapshots.length + state.usage.length + state.reservations.length + state.renewals.length;
    if (total > MAX_LEDGER_ROWS) throw new RangeError(`credit ledger retention limit ${MAX_LEDGER_ROWS} reached`);
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(state) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, this.file);
    await fs.chmod(this.file, 0o600);
    const dirHandle = await fs.open(this.directory, "r");
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  }

  async load(): Promise<CreditSnapshotState> { return this.withLock(() => this.readUnlocked()); }

  async recordBalanceSnapshot(input: Omit<BalanceSnapshot, "previousRemaining" | "previousSource">): Promise<BalanceSnapshot> {
    this.account(input.provider, input.accountId, input.unit);
    validNumber(input.remaining, "remaining"); validTimestamp(input.observedAt, "observedAt");
    if (input.source !== "provider-reported" && input.source !== "user-reported") throw new TypeError("invalid balance source");
    const refreshDate = validateRefreshDate(input.refreshDate);
    const auditId = validId(input.auditId, "auditId");
    return this.withLock(async () => {
      const state = await this.readUnlocked();
      const previous = [...state.snapshots].reverse().find((row) => row.provider === input.provider && row.accountId === input.accountId);
      const row: BalanceSnapshot = { ...input, auditId, refreshDate,
        ...(previous ? { previousRemaining: previous.remaining, previousSource: previous.source } : {}) };
      state.snapshots.push(row); await this.writeUnlocked(state); return row;
    });
  }

  async recordUsage(input: UsageEntry): Promise<void> {
    this.account(input.provider, input.accountId, input.unit);
    validNumber(input.amount, "usage amount"); validTimestamp(input.observedAt, "usage observedAt"); validId(input.id, "usage id");
    if (!["provider-reported", "user-reported", "estimated"].includes(input.source)) throw new TypeError("invalid usage source");
    if (input.source === "estimated" && !validId(input.provenance ?? "", "estimate provenance")) throw new TypeError("estimated usage requires provenance");
    await this.withLock(async () => { const state = await this.readUnlocked(); state.usage.push(input); await this.writeUnlocked(state); });
  }

  async recordReservation(input: ReservationEntry): Promise<void> {
    this.account(input.provider, input.accountId, input.unit);
    validNumber(input.amount, "reservation amount"); validTimestamp(input.observedAt, "reservation observedAt"); validId(input.id, "reservation id");
    if (!["reserved", "inflight", "released", "captured"].includes(input.state)) throw new TypeError("invalid reservation state");
    await this.withLock(async () => { const state = await this.readUnlocked(); state.reservations.push(input); await this.writeUnlocked(state); });
  }

  async recordVerifiedRenewal(input: RenewalEntry): Promise<void> {
    this.account(input.provider, input.accountId, "credits");
    validTimestamp(input.verifiedAt, "verifiedAt"); validId(input.auditId, "auditId"); validId(input.evidence, "renewal evidence");
    await this.withLock(async () => { const state = await this.readUnlocked(); state.renewals.push(input); await this.writeUnlocked(state); });
  }
}

function latest<T>(rows: readonly T[], test: (item: T) => boolean): T | undefined { return [...rows].reverse().find(test); }

export function summarizeCredits(accounts: readonly CreditAccount[], state: CreditSnapshotState, options: {
  now?: number; maxSnapshotAgeMs?: number; sessionSpend?: readonly SessionSpend[]; modelSlotUsage?: readonly ModelSlotUsage[];
} = {}): AccountCreditView[] {
  const now = options.now ?? Date.now();
  const maxAge = options.maxSnapshotAgeMs ?? STALE_AFTER_MS;
  return accounts.map((account) => {
    const snapshot = latest(state.snapshots, (row) => row.provider === account.provider && row.accountId === account.accountId);
    const snapshotStale = snapshot ? snapshot.source === "user-reported" || now - snapshot.observedAt > maxAge || now < snapshot.observedAt : false;
    const snapshotView = snapshot ? { remaining: snapshot.remaining, source: snapshot.source, observedAt: snapshot.observedAt,
      stale: snapshotStale, ...(snapshotStale ? { staleReason: snapshot.source === "user-reported" ? "User-reported balance is retained as a historical snapshot; provider freshness is unverified." : "Provider-reported snapshot is outside the freshness window." } : {}),
      ...(snapshot.refreshDate ? { refreshDate: snapshot.refreshDate } : {}) } : null;
    const renewal = account.provider === "lightsprint" ? latest(state.renewals, (row) => row.accountId === account.accountId) : undefined;
    const renewalResetsBase = renewal !== undefined && (snapshot === undefined || renewal.verifiedAt > snapshot.observedAt);
    const estimateBase = renewalResetsBase ? LIGHTSPRINT_MONTHLY_ALLOWANCE : snapshot?.remaining ?? null;
    const baseAt = renewalResetsBase ? renewal?.verifiedAt : snapshot?.observedAt ?? renewal?.verifiedAt;
    const usageRows = state.usage.filter((row) => row.provider === account.provider && row.accountId === account.accountId && row.unit === account.unit &&
      (baseAt === undefined || row.observedAt >= baseAt) && (!renewal || row.observedAt >= renewal.verifiedAt));
    const debitsBySource: Record<UsageSource, number> = { "provider-reported": 0, "user-reported": 0, estimated: 0 };
    for (const row of usageRows) debitsBySource[row.source] += row.amount;
    const used = Object.values(debitsBySource).reduce((sum, amount) => sum + amount, 0);
    const estimatedRemaining = estimateBase === null || used > estimateBase ? null : estimateBase - used;
    const estimateReason = estimateBase === null ? "No compatible-unit allowance or balance snapshot is available."
      : used > estimateBase ? "Same-unit debits exceed the recorded allowance; negative remaining balance is not emitted."
        : snapshotStale ? "Estimate inherits stale user-reported snapshot provenance." : undefined;
    const estimateProvenance = estimateBase === null ? "No same-unit allowance or reported balance basis."
      : renewalResetsBase ? `10,000,000-credit allowance from verified renewal ${new Date(renewal!.verifiedAt).toISOString()}; same-unit usage after renewal subtracted.`
        : snapshot ? `${snapshot.source} snapshot observed ${new Date(snapshot.observedAt).toISOString()}; same-unit usage after snapshot subtracted.`
          : account.provider === "lightsprint" ? "Configured 10,000,000 monthly credits less same-unit recorded usage; no cycle reset inferred."
            : "No Exa USD balance snapshot; no allowance inferred.";
    const reservationRows = state.reservations.filter((row) => row.provider === account.provider && row.accountId === account.accountId && row.unit === account.unit);
    const latestReservations = new Map<string, ReservationEntry>();
    for (const row of reservationRows) latestReservations.set(row.id, row);
    const reserved = [...latestReservations.values()].filter((row) => row.state === "reserved").reduce((sum, row) => sum + row.amount, 0);
    const inflight = [...latestReservations.values()].filter((row) => row.state === "inflight").reduce((sum, row) => sum + row.amount, 0);
    const held = reserved + inflight;
    const sessionSpendUsd = (options.sessionSpend ?? []).filter((row) => row.provider === account.provider && row.accountId === account.accountId && Number.isFinite(row.amountUsd) && row.amountUsd >= 0 &&
      (row.source !== "estimated" || !!row.provenance?.trim())).reduce((sum, row) => sum + row.amountUsd, 0);
    const modelSlotUsage = (options.modelSlotUsage ?? []).filter((row) => row.provider === account.provider && row.accountId === account.accountId && Number.isFinite(row.observedUsage) && row.observedUsage >= 0)
      .map((row) => ({ model: row.model, slot: row.slot, observedUsage: row.observedUsage, unit: row.unit, debit: null,
        debitReason: "Provider does not report a per-model/per-slot debit breakdown; usage is not converted to credits." }));
    return { account, balanceSnapshot: snapshotView, monthlyAllowance: account.provider === "lightsprint" ? LIGHTSPRINT_MONTHLY_ALLOWANCE : null,
      estimatedRemaining, estimateProvenance, ...(estimateReason ? { estimateReason } : {}), debitsBySource, reserved, inflight,
      availableAfterHolds: estimatedRemaining === null || held > estimatedRemaining ? null : estimatedRemaining - held,
      observedSessionSpendUsd: sessionSpendUsd, modelSlotUsage };
  });
}

const escapeHtml = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const amountText = (amount: number | null, unit: string) => amount === null ? "Unknown" : unit === "USD" ? `$${amount.toFixed(2)} USD` : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(amount)} ${unit}`;

/** Server-renderable, escaped summary. Reported snapshots and estimated balances have visibly distinct labels. */
export function renderCreditSnapshots(views: readonly AccountCreditView[]): string {
  const rows = views.map((view) => {
    const snapshot = view.balanceSnapshot ? `<p><strong>${escapeHtml(amountText(view.balanceSnapshot.remaining, view.account.unit))}</strong> · ${escapeHtml(view.balanceSnapshot.source)} snapshot · ${view.balanceSnapshot.stale ? "stale" : "fresh"}${view.balanceSnapshot.refreshDate ? ` · refresh date ${escapeHtml(view.balanceSnapshot.refreshDate)} (date only)` : " · refresh date unknown"}</p>` : `<p>No reported balance snapshot.</p>`;
    const estimates = `<p>Estimated remaining: <strong>${escapeHtml(amountText(view.estimatedRemaining, view.account.unit))}</strong> · ${escapeHtml(view.estimateProvenance)}${view.estimateReason ? ` · ${escapeHtml(view.estimateReason)}` : ""}</p><p>Holds: reserved ${escapeHtml(amountText(view.reserved, view.account.unit))}; in flight ${escapeHtml(amountText(view.inflight, view.account.unit))}; after holds ${escapeHtml(amountText(view.availableAfterHolds, view.account.unit))}.</p>`;
    const debits = Object.entries(view.debitsBySource).map(([source, amount]) => `${escapeHtml(source)}: ${escapeHtml(amountText(amount, view.account.unit))}`).join(" · ");
    const usage = view.modelSlotUsage.length ? `<ul>${view.modelSlotUsage.map((row) => `<li>${escapeHtml(row.model)} / ${escapeHtml(row.slot)}: ${escapeHtml(amountText(row.observedUsage, row.unit))}; debit unknown</li>`).join("")}</ul>` : "<p>No model/slot usage observations.</p>";
    return `<article class="credit-account"><h3>${escapeHtml(view.account.label)} <small>${escapeHtml(view.account.provider)} · ${escapeHtml(view.account.accountId)}</small></h3>${snapshot}${estimates}<p>Usage sources: ${debits || "none reported"}.</p><p>Observed session spend: ${escapeHtml(amountText(view.observedSessionSpendUsd, "USD"))} (kept separate from provider credits).</p><h4>Model and slot usage</h4>${usage}</article>`;
  }).join("");
  return `<section class="credit-snapshots"><h2>Credit and spend snapshots</h2><p>Provider-reported, user-reported, and estimated values remain separate. Estimates are not provider balances; USD spend is not converted to LightSprint credits.</p>${rows || "<p>No LightSprint or Exa accounts are configured.</p>"}</section>`;
}
