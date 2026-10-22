import { createHash } from "node:crypto";

export interface ProvisioningIdentity {
  accountId: string;
  workspaceId: string;
  taskId: string;
}

export type ProvisioningState = "reserved" | "launching" | "started" | "rejected" | "needs_reconciliation";

export interface ProvisioningRecord {
  id: string;
  idempotencyKey: string;
  payloadDigest: string;
  identity: ProvisioningIdentity;
  requestedModel?: string;
  requestedEffort?: string;
  reportedModel?: string;
  reportedEffort?: string;
  providerSessionId?: string;
  refusalCode?: string;
  state: ProvisioningState;
  revision: number;
}

export interface ProvisioningReservation {
  idempotencyKey: string;
  payloadDigest: string;
  identity: ProvisioningIdentity;
  requestedModel?: string;
  requestedEffort?: string;
}

/**
 * Implementations MUST make reserve atomic across processes: idempotency-key/digest
 * collisions fail, and only one non-rejected reservation may own an account/workspace/task
 * tuple. settle MUST be an atomic CAS on expectedRevision, preserve id/key/digest/identity,
 * and reject invalid state transitions. Persist `reserved` before returning created=true.
 */
export interface ProvisioningLedger {
  reserve(input: ProvisioningReservation): Promise<{ record: ProvisioningRecord; created: boolean }>;
  getByIdempotencyKey(key: string): Promise<ProvisioningRecord | undefined>;
  settle(id: string, expectedRevision: number, patch: Partial<Pick<ProvisioningRecord,
    "state" | "reportedModel" | "reportedEffort" | "providerSessionId" | "refusalCode">>): Promise<ProvisioningRecord>;
}

export interface ProviderSessionEvidence extends ProvisioningIdentity {
  providerSessionId: string;
  reportedModel?: string;
  reportedEffort?: string;
}

export type ProviderLaunchResult =
  | { kind: "started"; evidence: ProviderSessionEvidence }
  | { kind: "refused"; beforeExecution: true; code: string };

export interface ProvisioningProviderAdapter {
  readonly capabilities: { modelPin: boolean; effortPin: boolean };
  isAccountEligible(identity: ProvisioningIdentity): boolean | Promise<boolean>;
  launch(input: {
    idempotencyKey: string;
    identity: ProvisioningIdentity;
    payload: unknown;
    model?: string;
    effort?: string;
  }): Promise<ProviderLaunchResult>;
  /** Read-only provider-specific evidence lookup; never starts or resumes a session. */
  reconcile(input: {
    idempotencyKey: string;
    payloadDigest: string;
    identity: ProvisioningIdentity;
  }): Promise<readonly ProviderSessionEvidence[]>;
}

export type ProvisioningResult = {
  state: "started" | "rejected" | "needs_reconciliation";
  record?: ProvisioningRecord;
  reason?: string;
};

export class ProvisioningConflictError extends Error {
  constructor(readonly code: "idempotency_collision" | "task_in_flight") {
    super(code);
    this.name = "ProvisioningConflictError";
  }
}

function bounded(value: unknown, label: string, max = 256): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function canonical(value: unknown, seen = new Set<object>(), depth = 0, nodes = { count: 0, bytes: 0 }): string {
  if (++nodes.count > 20_000 || depth > 32) throw new TypeError("Payload is too complex");
  if (typeof value === "string") {
    nodes.bytes += Buffer.byteLength(value);
    if (nodes.bytes > 1_000_000) throw new TypeError("Payload exceeds 1 MB");
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length) {
      throw new TypeError("Payload arrays must be dense JSON data");
    }
    if (seen.has(value)) throw new TypeError("Payload must be acyclic JSON data");
    seen.add(value);
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) throw new TypeError("Payload arrays must contain data values");
      items.push(canonical(descriptor.value, seen, depth + 1, nodes));
    }
    const result = `[${items.join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value !== "object" || value === undefined) throw new TypeError("Payload must be JSON data");
  const object = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Payload must be plain JSON data");
  if (seen.has(object)) throw new TypeError("Payload must be acyclic JSON data");
  if (Object.getOwnPropertySymbols(object).length) throw new TypeError("Payload must be plain JSON data");
  seen.add(object);
  const parts = Object.keys(object).sort().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor)) throw new TypeError("Payload accessors are not supported");
    nodes.bytes += Buffer.byteLength(key);
    if (nodes.bytes > 1_000_000) throw new TypeError("Payload exceeds 1 MB");
    return `${JSON.stringify(key)}:${canonical(descriptor.value, seen, depth + 1, nodes)}`;
  });
  seen.delete(object);
  return `{${parts.join(",")}}`;
}

function identityMatches(a: ProvisioningIdentity, b: ProvisioningIdentity): boolean {
  return a.accountId === b.accountId && a.workspaceId === b.workspaceId && a.taskId === b.taskId;
}

function safeEvidence(evidence: ProviderSessionEvidence, expected: ProvisioningIdentity): boolean {
  if (!evidence || !identityMatches(evidence, expected)) return false;
  try { bounded(evidence.providerSessionId, "provider session ID"); } catch { return false; }
  for (const value of [evidence.reportedModel, evidence.reportedEffort]) {
    if (value !== undefined) { try { bounded(value, "reported value"); } catch { return false; } }
  }
  return true;
}

function safeCode(code: unknown): string {
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : "provider_refused";
}

/** Injected orchestration only: construction performs no I/O and no endpoint is assumed. */
export class DurableSessionProvisioningCoordinator {
  constructor(private readonly ledger: ProvisioningLedger, private readonly adapter: ProvisioningProviderAdapter) {}

  async provision(input: ProvisioningIdentity & {
    idempotencyKey: string;
    payload: unknown;
    model?: string;
    effort?: string;
  }): Promise<ProvisioningResult> {
    bounded(input.idempotencyKey, "idempotency key");
    bounded(input.accountId, "account ID"); bounded(input.workspaceId, "workspace ID"); bounded(input.taskId, "task ID");
    if (input.model !== undefined) bounded(input.model, "model");
    if (input.effort !== undefined) bounded(input.effort, "effort");
    if (input.model !== undefined && !this.adapter.capabilities.modelPin) return { state: "rejected", reason: "unsupported_model_pin" };
    if (input.effort !== undefined && !this.adapter.capabilities.effortPin) return { state: "rejected", reason: "unsupported_effort_pin" };

    const identity = { accountId: input.accountId, workspaceId: input.workspaceId, taskId: input.taskId };
    const digestInput = canonical({ identity, model: input.model ?? null, effort: input.effort ?? null, payload: input.payload });
    if (Buffer.byteLength(digestInput) > 1_000_000) throw new TypeError("Payload exceeds 1 MB");
    const payloadDigest = createHash("sha256").update(digestInput).digest("hex");
    const reserved = await this.ledger.reserve({
      idempotencyKey: input.idempotencyKey, payloadDigest, identity,
      ...(input.model === undefined ? {} : { requestedModel: input.model }),
      ...(input.effort === undefined ? {} : { requestedEffort: input.effort }),
    });
    let record = reserved.record;
    if (!reserved.created) return this.existing(record);

    try {
      if (!await this.adapter.isAccountEligible(identity)) {
        record = await this.ledger.settle(record.id, record.revision, { state: "rejected", refusalCode: "account_ineligible" });
        return { state: "rejected", reason: "account_ineligible", record };
      }
    } catch {
      return this.markUnknown(record, "eligibility_check_failed");
    }

    try {
      record = await this.ledger.settle(record.id, record.revision, { state: "launching" });
    } catch {
      return this.unknownAfterRead(record, "reservation_changed_before_launch");
    }
    let result: ProviderLaunchResult;
    try {
      result = await this.adapter.launch({
        idempotencyKey: input.idempotencyKey, identity, payload: input.payload,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
      });
    } catch {
      return this.markUnknown(record, "provider_launch_ambiguous");
    }
    if (!result || typeof result !== "object") return this.markUnknown(record, "provider_response_unrecognized");
    if (result.kind === "refused" && result.beforeExecution === true) {
      const refusalCode = safeCode(result.code);
      try {
        record = await this.ledger.settle(record.id, record.revision, { state: "rejected", refusalCode });
        return { state: "rejected", reason: refusalCode, record };
      } catch { return this.unknownAfterRead(record, "refusal_receipt_unconfirmed"); }
    }
    if (result.kind !== "started" || !safeEvidence(result.evidence, identity)) return this.markUnknown(record, "provider_identity_unconfirmed");
    return this.bind(record, result.evidence);
  }

  /** Explicit recovery only. This method never launches, resumes, or retries a session. */
  async reconcile(idempotencyKey: string): Promise<ProvisioningResult> {
    bounded(idempotencyKey, "idempotency key");
    let record = await this.ledger.getByIdempotencyKey(idempotencyKey);
    if (!record) return { state: "rejected", reason: "reservation_not_found" };
    if (record.state === "started" || record.state === "rejected") return { state: record.state, record };
    if (record.state !== "needs_reconciliation") {
      try { record = await this.ledger.settle(record.id, record.revision, { state: "needs_reconciliation" }); }
      catch { return this.unknownAfterRead(record, "reconciliation_fence_conflict"); }
    }
    let candidates: readonly ProviderSessionEvidence[];
    try {
      candidates = await this.adapter.reconcile({ idempotencyKey, payloadDigest: record.payloadDigest, identity: record.identity });
    } catch { return { state: "needs_reconciliation", record, reason: "evidence_lookup_unavailable" }; }
    if (!Array.isArray(candidates) || candidates.length !== 1 || !safeEvidence(candidates[0]!, record.identity)) {
      return { state: "needs_reconciliation", record, reason: "provider_session_not_uniquely_verified" };
    }
    return this.bind(record, candidates[0]!);
  }

  private existing(record: ProvisioningRecord): ProvisioningResult {
    if (record.state === "started" || record.state === "rejected") return { state: record.state, record };
    return { state: "needs_reconciliation", record, reason: "existing_reservation_will_not_be_replayed" };
  }

  private async bind(record: ProvisioningRecord, evidence: ProviderSessionEvidence): Promise<ProvisioningResult> {
    try {
      const settled = await this.ledger.settle(record.id, record.revision, {
        state: "started", providerSessionId: evidence.providerSessionId,
        ...(evidence.reportedModel === undefined ? {} : { reportedModel: evidence.reportedModel }),
        ...(evidence.reportedEffort === undefined ? {} : { reportedEffort: evidence.reportedEffort }),
      });
      return { state: "started", record: settled };
    } catch { return this.unknownAfterRead(record, "session_binding_unconfirmed"); }
  }

  private async markUnknown(record: ProvisioningRecord, reason: string): Promise<ProvisioningResult> {
    if (record.state === "needs_reconciliation") return { state: "needs_reconciliation", record, reason };
    try {
      const unknown = await this.ledger.settle(record.id, record.revision, { state: "needs_reconciliation" });
      return { state: "needs_reconciliation", record: unknown, reason };
    } catch { return this.unknownAfterRead(record, reason); }
  }

  private async unknownAfterRead(record: ProvisioningRecord, reason: string): Promise<ProvisioningResult> {
    try {
      const latest = await this.ledger.getByIdempotencyKey(record.idempotencyKey);
      return latest?.state === "started" ? { state: "started", record: latest }
        : { state: "needs_reconciliation", record: latest ?? record, reason };
    } catch { return { state: "needs_reconciliation", record, reason }; }
  }
}
