import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  ProvisioningConflictError,
  type ProvisioningIdentity,
  type ProvisioningLedger,
  type ProvisioningRecord,
  type ProvisioningReservation,
  type ProvisioningState,
} from "./lightsprint-provisioning.js";

export class ProvisioningLedgerError extends Error {
  constructor(readonly code: "reservation_not_found" | "revision_conflict" | "invalid_transition" | "invalid_record") {
    super(code);
    this.name = "ProvisioningLedgerError";
  }
}

const STATES = new Set<ProvisioningState>([
  "reserved", "launching", "started", "rejected", "needs_reconciliation",
]);
const ALLOWED_TRANSITIONS: Record<ProvisioningState, ReadonlySet<ProvisioningState>> = {
  reserved: new Set(["launching", "rejected", "needs_reconciliation"]),
  launching: new Set(["started", "rejected", "needs_reconciliation"]),
  needs_reconciliation: new Set(["started", "needs_reconciliation"]),
  started: new Set(),
  rejected: new Set(),
};
const MAX_ID = 256;
const MAX_DB_BUSY_MS = 5_000;

type SqlRow = Record<string, SQLOutputValue>;

function validText(value: unknown, label: string, max = MAX_ID): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function validateIdentity(value: unknown): asserts value is ProvisioningIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid identity");
  const identity = value as Record<string, unknown>;
  const keys = Object.keys(identity).sort();
  if (keys.join(",") !== "accountId,taskId,workspaceId") throw new TypeError("Invalid identity fields");
  validText(identity.accountId, "account ID");
  validText(identity.workspaceId, "workspace ID");
  validText(identity.taskId, "task ID");
}

function validateReservation(input: ProvisioningReservation): void {
  if (!input || typeof input !== "object") throw new TypeError("Invalid reservation");
  validText(input.idempotencyKey, "idempotency key");
  if (typeof input.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.payloadDigest)) {
    throw new TypeError("Invalid payload digest");
  }
  validateIdentity(input.identity);
  for (const value of [input.requestedModel, input.requestedEffort]) {
    if (value !== undefined) validText(value, "requested pin");
  }
  const allowed = new Set(["idempotencyKey", "payloadDigest", "identity", "requestedModel", "requestedEffort"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("Unknown reservation field");
}

function optionalText(value: unknown, label: string, max = MAX_ID): string | undefined {
  if (value === null || value === undefined) return undefined;
  validText(value, label, max);
  return value;
}

function toRecord(row: SqlRow | undefined): ProvisioningRecord | undefined {
  if (!row) return undefined;
  const text = (key: string): string => {
    const value = row[key];
    if (typeof value !== "string") throw new ProvisioningLedgerError("invalid_record");
    return value;
  };
  const nullableText = (key: string): string | undefined => {
    const value = row[key];
    if (value === null) return undefined;
    if (typeof value !== "string") throw new ProvisioningLedgerError("invalid_record");
    return value;
  };
  const state = text("state") as ProvisioningState;
  const revision = row.revision;
  if (!STATES.has(state) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    throw new ProvisioningLedgerError("invalid_record");
  }
  return {
    id: text("id"), idempotencyKey: text("idempotency_key"), payloadDigest: text("payload_digest"),
    identity: { accountId: text("account_id"), workspaceId: text("workspace_id"), taskId: text("task_id") },
    ...(nullableText("requested_model") === undefined ? {} : { requestedModel: nullableText("requested_model") }),
    ...(nullableText("requested_effort") === undefined ? {} : { requestedEffort: nullableText("requested_effort") }),
    ...(nullableText("reported_model") === undefined ? {} : { reportedModel: nullableText("reported_model") }),
    ...(nullableText("reported_effort") === undefined ? {} : { reportedEffort: nullableText("reported_effort") }),
    ...(nullableText("provider_session_id") === undefined ? {} : { providerSessionId: nullableText("provider_session_id") }),
    ...(nullableText("refusal_code") === undefined ? {} : { refusalCode: nullableText("refusal_code") }),
    state, revision,
  };
}

function ensurePrivateDatabasePath(databasePath: string): string {
  if (!isAbsolute(databasePath) || resolve(databasePath) !== databasePath || databasePath === "/") {
    throw new TypeError("Database path must be an absolute file path");
  }
  const parent = dirname(databasePath);
  const parentExisted = existsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentInfo = lstatSync(parent);
  const ownerUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || (parentInfo.mode & 0o077) !== 0 ||
      (ownerUid !== undefined && parentInfo.uid !== ownerUid)) {
    throw new Error("Database directory must be private (mode 0700)");
  }
  if (existsSync(databasePath)) {
    const fileInfo = lstatSync(databasePath);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.nlink !== 1 ||
        (fileInfo.mode & 0o077) !== 0 || (ownerUid !== undefined && fileInfo.uid !== ownerUid)) {
      throw new Error("Database file must be a private regular file (mode 0600)");
    }
  } else {
    try {
      const fd = openSync(databasePath, "wx", 0o600);
      closeSync(fd);
    } catch (error) {
      if (!existsSync(databasePath)) throw error;
      const fileInfo = lstatSync(databasePath);
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.nlink !== 1 ||
          (fileInfo.mode & 0o077) !== 0 || (ownerUid !== undefined && fileInfo.uid !== ownerUid)) throw error;
    }
  }
  const fileInfo = lstatSync(databasePath);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1 ||
      (fileInfo.mode & 0o077) !== 0 || (ownerUid !== undefined && fileInfo.uid !== ownerUid)) {
    throw new Error("Database file must be private");
  }
  // Preserve private permissions if created under a restrictive umask.
  chmodSync(databasePath, 0o600);
  if (!parentExisted) chmodSync(parent, 0o700);
  return databasePath;
}

/** Durable SQLite implementation of the injected coordinator ledger contract. */
export class SqliteProvisioningLedger implements ProvisioningLedger {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    const safePath = ensurePrivateDatabasePath(databasePath);
    this.db = new DatabaseSync(safePath);
    this.db.exec(`PRAGMA busy_timeout = ${MAX_DB_BUSY_MS}; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provisioning_sessions (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_digest TEXT NOT NULL,
        account_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        requested_model TEXT,
        requested_effort TEXT,
        reported_model TEXT,
        reported_effort TEXT,
        provider_session_id TEXT,
        refusal_code TEXT,
        state TEXT NOT NULL CHECK (state IN ('reserved','launching','started','rejected','needs_reconciliation')),
        revision INTEGER NOT NULL CHECK (revision >= 1)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS provisioning_live_task_unique
        ON provisioning_sessions(account_id, workspace_id, task_id) WHERE state <> 'rejected';
    `);
    chmodSync(safePath, 0o600);
  }

  async reserve(input: ProvisioningReservation): Promise<{ record: ProvisioningRecord; created: boolean }> {
    this.assertOpen();
    validateReservation(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = toRecord(this.db.prepare("SELECT * FROM provisioning_sessions WHERE idempotency_key = ?").get(input.idempotencyKey));
      if (existing) {
        if (existing.payloadDigest !== input.payloadDigest ||
            existing.identity.accountId !== input.identity.accountId ||
            existing.identity.workspaceId !== input.identity.workspaceId || existing.identity.taskId !== input.identity.taskId ||
            (existing.requestedModel ?? null) !== (input.requestedModel ?? null) ||
            (existing.requestedEffort ?? null) !== (input.requestedEffort ?? null)) {
          throw new ProvisioningConflictError("idempotency_collision");
        }
        this.db.exec("COMMIT");
        return { record: existing, created: false };
      }
      const sameTask = this.db.prepare(`SELECT id FROM provisioning_sessions
        WHERE account_id = ? AND workspace_id = ? AND task_id = ? AND state <> 'rejected' LIMIT 1`)
        .get(input.identity.accountId, input.identity.workspaceId, input.identity.taskId);
      if (sameTask) throw new ProvisioningConflictError("task_in_flight");

      const id = randomUUID();
      this.db.prepare(`INSERT INTO provisioning_sessions (
        id, idempotency_key, payload_digest, account_id, workspace_id, task_id,
        requested_model, requested_effort, state, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 1)`).run(
        id, input.idempotencyKey, input.payloadDigest, input.identity.accountId,
        input.identity.workspaceId, input.identity.taskId, input.requestedModel ?? null,
        input.requestedEffort ?? null,
      );
      const record = toRecord(this.db.prepare("SELECT * FROM provisioning_sessions WHERE id = ?").get(id));
      if (!record) throw new ProvisioningLedgerError("invalid_record");
      this.db.exec("COMMIT");
      return { record, created: true };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  async getByIdempotencyKey(key: string): Promise<ProvisioningRecord | undefined> {
    this.assertOpen();
    validText(key, "idempotency key");
    return toRecord(this.db.prepare("SELECT * FROM provisioning_sessions WHERE idempotency_key = ?").get(key));
  }

  async settle(
    id: string,
    expectedRevision: number,
    patch: Partial<Pick<ProvisioningRecord, "state" | "reportedModel" | "reportedEffort" | "providerSessionId" | "refusalCode">>,
  ): Promise<ProvisioningRecord> {
    this.assertOpen();
    validText(id, "reservation ID");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new TypeError("Invalid expected revision");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("Invalid settlement patch");
    const allowed = new Set(["state", "reportedModel", "reportedEffort", "providerSessionId", "refusalCode"]);
    if (Object.keys(patch).some((key) => !allowed.has(key)) || !STATES.has(patch.state as ProvisioningState)) {
      throw new TypeError("Invalid settlement fields");
    }
    const nextState = patch.state!;
    const providerSessionId = optionalText(patch.providerSessionId, "provider session ID");
    const reportedModel = optionalText(patch.reportedModel, "reported model");
    const reportedEffort = optionalText(patch.reportedEffort, "reported effort");
    const refusalCode = optionalText(patch.refusalCode, "refusal code", 64);
    if (refusalCode !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(refusalCode)) throw new TypeError("Invalid refusal code");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = toRecord(this.db.prepare("SELECT * FROM provisioning_sessions WHERE id = ?").get(id));
      if (!current) throw new ProvisioningLedgerError("reservation_not_found");
      if (current.revision !== expectedRevision) throw new ProvisioningLedgerError("revision_conflict");
      if (!ALLOWED_TRANSITIONS[current.state].has(nextState)) throw new ProvisioningLedgerError("invalid_transition");
      if (nextState === "started" && !providerSessionId) throw new TypeError("Started state requires a provider session ID");
      if (nextState === "rejected" && !refusalCode) throw new TypeError("Rejected state requires a refusal code");
      if (current.providerSessionId && providerSessionId && current.providerSessionId !== providerSessionId) {
        throw new ProvisioningLedgerError("invalid_transition");
      }
      if (nextState !== "started" && nextState !== "needs_reconciliation" && (providerSessionId !== undefined || reportedModel !== undefined || reportedEffort !== undefined)) {
        throw new TypeError("Provider result fields require a started or uncertain execution");
      }
      if (nextState !== "rejected" && refusalCode !== undefined) throw new TypeError("Refusal code is only valid when rejecting");

      const result = this.db.prepare(`UPDATE provisioning_sessions SET
        state = ?, reported_model = ?, reported_effort = ?, provider_session_id = ?, refusal_code = ?, revision = revision + 1
        WHERE id = ? AND revision = ?`).run(
        nextState,
        reportedModel ?? current.reportedModel ?? null,
        reportedEffort ?? current.reportedEffort ?? null,
        providerSessionId ?? current.providerSessionId ?? null,
        refusalCode ?? current.refusalCode ?? null,
        id, expectedRevision,
      );
      if (Number(result.changes) !== 1) throw new ProvisioningLedgerError("revision_conflict");
      const updated = toRecord(this.db.prepare("SELECT * FROM provisioning_sessions WHERE id = ?").get(id));
      if (!updated) throw new ProvisioningLedgerError("invalid_record");
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Provisioning ledger is closed");
  }

  private rollback(): void {
    try { this.db.exec("ROLLBACK"); } catch { /* transaction already ended */ }
  }
}
