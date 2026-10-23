import { createHash } from "node:crypto";
import type {
  ProviderLaunchResult,
  ProviderSessionEvidence,
  ProvisioningIdentity,
  ProvisioningProviderAdapter,
} from "./lightsprint-provisioning.js";

/**
 * Narrow adapter boundary for a separately discovered LightSprint account contract.
 * This module intentionally knows no endpoint, credential store, or network client.
 */
export interface LightSprintProvisioningContract {
  accountId: string;
  status: "documented" | "unknown" | "unavailable";
  semantics: {
    accountPinned: boolean;
    workspaceScoped: boolean;
    taskCreate: boolean;
    sessionLaunch: boolean;
    correlationLookup: boolean;
  };
  modelPin: { status: "supported" | "unknown" | "unsupported"; values?: readonly string[] };
  effortPin: { status: "supported" | "unknown" | "unsupported"; values?: readonly string[] };
}

export type LightSprintTaskCreateResult =
  | { kind: "created"; identity: ProvisioningIdentity; taskRef: string }
  | { kind: "refused"; beforeExecution: true; code: string };

export type LightSprintSessionLaunchResult =
  | { kind: "started"; evidence: ProviderSessionEvidence }
  | { kind: "refused"; beforeExecution: true; code: string };

export interface LightSprintProvisioningClient {
  createTask(input: {
    identity: ProvisioningIdentity;
    idempotencyKey: string;
    payloadDigest: string;
    payload: unknown;
  }): Promise<LightSprintTaskCreateResult>;
  launchSession(input: {
    identity: ProvisioningIdentity;
    taskRef: string;
    idempotencyKey: string;
    payloadDigest: string;
    payload: unknown;
    model?: string;
    effort?: string;
  }): Promise<LightSprintSessionLaunchResult>;
  /** Must use the documented, read-only lookup keyed by all supplied values. */
  findSessions(input: {
    identity: ProvisioningIdentity;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<readonly {
    identity: ProvisioningIdentity;
    idempotencyKey: string;
    payloadDigest: string;
    evidence: ProviderSessionEvidence;
  }[]>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const VALUE = /^[^\u0000-\u001f\u007f]{1,128}$/;

function validId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function validValue(value: unknown): value is string {
  return typeof value === "string" && VALUE.test(value) && value.trim() === value;
}

function validIdentity(value: unknown): value is ProvisioningIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(",") === "accountId,taskId,workspaceId" &&
    typeof item.accountId === "string" && ACCOUNT_ID.test(item.accountId) && validId(item.workspaceId) && validId(item.taskId);
}

function sameIdentity(left: ProvisioningIdentity, right: ProvisioningIdentity): boolean {
  return left.accountId === right.accountId && left.workspaceId === right.workspaceId && left.taskId === right.taskId;
}

function canonicalJson(value: unknown, seen = new Set<object>(), depth = 0, budget = { nodes: 0, bytes: 0 }): string {
  if (++budget.nodes > 20_000 || depth > 32) throw new TypeError("Payload is too complex");
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > 1_000_000) throw new TypeError("Payload exceeds 1 MB");
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length || seen.has(value)) {
      throw new TypeError("Payload must be plain acyclic JSON data");
    }
    seen.add(value);
    const parts: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) throw new TypeError("Payload must contain data values");
      parts.push(canonicalJson(descriptor.value, seen, depth + 1, budget));
    }
    seen.delete(value);
    return `[${parts.join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) throw new TypeError("Payload must be JSON data");
  const object = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(object).length || seen.has(object)) {
    throw new TypeError("Payload must be plain acyclic JSON data");
  }
  seen.add(object);
  const parts = Object.keys(object).sort().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor)) throw new TypeError("Payload accessors are not supported");
    budget.bytes += Buffer.byteLength(key);
    if (budget.bytes > 1_000_000) throw new TypeError("Payload exceeds 1 MB");
    return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, seen, depth + 1, budget)}`;
  });
  seen.delete(object);
  return `{${parts.join(",")}}`;
}

function payloadDigest(input: { identity: ProvisioningIdentity; payload: unknown; model?: string; effort?: string }): string {
  const normalized = {
    identity: input.identity,
    model: input.model ?? null,
    effort: input.effort ?? null,
    payload: input.payload,
  };
  const canonical = canonicalJson(normalized);
  if (Buffer.byteLength(canonical) > 1_000_000) throw new TypeError("Payload exceeds 1 MB");
  return createHash("sha256").update(canonical).digest("hex");
}

function safeCode(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "provider_refused";
}

function completeContract(contract: LightSprintProvisioningContract): boolean {
  return contract.status === "documented" && typeof contract.accountId === "string" && ACCOUNT_ID.test(contract.accountId) &&
    contract.semantics.accountPinned === true && contract.semantics.workspaceScoped === true &&
    contract.semantics.taskCreate === true && contract.semantics.sessionLaunch === true &&
    contract.semantics.correlationLookup === true;
}

function supportedValues(pin: LightSprintProvisioningContract["modelPin"] | LightSprintProvisioningContract["effortPin"]): readonly string[] {
  if (pin.status !== "supported" || !Array.isArray(pin.values) || pin.values.length === 0 || pin.values.length > 512) return [];
  if (!pin.values.every(validValue) || new Set(pin.values).size !== pin.values.length) return [];
  return pin.values;
}

/** Account-pinned adapter over an injected contract and provider client; construction is inert. */
export class LightSprintProvisioningAdapter implements ProvisioningProviderAdapter {
  readonly capabilities: { modelPin: boolean; effortPin: boolean };
  private readonly modelValues: ReadonlySet<string>;
  private readonly effortValues: ReadonlySet<string>;

  constructor(
    private readonly contract: LightSprintProvisioningContract,
    private readonly client: LightSprintProvisioningClient,
  ) {
    const usable = completeContract(contract);
    this.modelValues = new Set(usable ? supportedValues(contract.modelPin) : []);
    this.effortValues = new Set(usable ? supportedValues(contract.effortPin) : []);
    this.capabilities = {
      modelPin: this.modelValues.size > 0,
      effortPin: this.effortValues.size > 0,
    };
  }

  isAccountEligible(identity: ProvisioningIdentity): boolean {
    return completeContract(this.contract) && validIdentity(identity) && identity.accountId === this.contract.accountId;
  }

  async launch(input: {
    idempotencyKey: string;
    identity: ProvisioningIdentity;
    payload: unknown;
    model?: string;
    effort?: string;
  }): Promise<ProviderLaunchResult> {
    if (!await this.isAccountEligible(input.identity) || !validValue(input.idempotencyKey)) {
      return { kind: "refused", beforeExecution: true, code: "account_ineligible" };
    }
    if (input.model !== undefined && (!validValue(input.model) || !this.modelValues.has(input.model))) {
      return { kind: "refused", beforeExecution: true, code: "unsupported_model_pin" };
    }
    if (input.effort !== undefined && (!validValue(input.effort) || !this.effortValues.has(input.effort))) {
      return { kind: "refused", beforeExecution: true, code: "unsupported_effort_pin" };
    }

    // Match the coordinator's canonical digest exactly so lookup is tied to the durable
    // reservation. The digest is not trusted from callers or provider responses.
    const digest = payloadDigest(input);

    const created = await this.client.createTask({
      identity: { ...input.identity }, idempotencyKey: input.idempotencyKey,
      payloadDigest: digest, payload: input.payload,
    });
    if (!created || created.kind === "refused") {
      if (created?.kind === "refused" && created.beforeExecution === true) {
        return { kind: "refused", beforeExecution: true, code: safeCode(created.code) };
      }
      throw new Error("LightSprint task creation response is unrecognized");
    }
    if (created.kind !== "created" || !sameIdentity(created.identity, input.identity) || !validId(created.taskRef)) {
      throw new Error("LightSprint task identity is unconfirmed");
    }

    const launched = await this.client.launchSession({
      identity: { ...input.identity }, taskRef: created.taskRef,
      idempotencyKey: input.idempotencyKey, payloadDigest: digest, payload: input.payload,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
    });
    if (!launched || launched.kind === "refused") {
      if (launched?.kind === "refused" && launched.beforeExecution === true) {
        return { kind: "refused", beforeExecution: true, code: safeCode(launched.code) };
      }
      throw new Error("LightSprint session launch response is unrecognized");
    }
    if (launched.kind !== "started" || !this.validEvidence(launched.evidence, input.identity)) {
      throw new Error("LightSprint session identity is unconfirmed");
    }
    return { kind: "started", evidence: launched.evidence };
  }

  async reconcile(input: {
    idempotencyKey: string;
    payloadDigest: string;
    identity: ProvisioningIdentity;
  }): Promise<readonly ProviderSessionEvidence[]> {
    if (!await this.isAccountEligible(input.identity) || !validValue(input.idempotencyKey) || !DIGEST.test(input.payloadDigest)) return [];
    const rows = await this.client.findSessions({
      identity: { ...input.identity }, idempotencyKey: input.idempotencyKey, payloadDigest: input.payloadDigest,
    });
    if (!Array.isArray(rows) || rows.length > 256) return [];
    // Keep only exact provider correlation and identity. Coordinator separately requires
    // exactly one candidate before binding a session.
    return rows.flatMap((row) => row && row.idempotencyKey === input.idempotencyKey &&
      row.payloadDigest === input.payloadDigest && sameIdentity(row.identity, input.identity) &&
      this.validEvidence(row.evidence, input.identity) ? [row.evidence] : []);
  }

  private validEvidence(evidence: ProviderSessionEvidence, expected: ProvisioningIdentity): boolean {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
    const allowed = new Set(["accountId", "workspaceId", "taskId", "providerSessionId", "reportedModel", "reportedEffort"]);
    if (Object.keys(evidence).some((key) => !allowed.has(key))) return false;
    const identity = { accountId: evidence.accountId, workspaceId: evidence.workspaceId, taskId: evidence.taskId };
    return validIdentity(identity) && sameIdentity(identity, expected) &&
      validId(evidence.providerSessionId) &&
      (evidence.reportedModel === undefined || validValue(evidence.reportedModel)) &&
      (evidence.reportedEffort === undefined || validValue(evidence.reportedEffort));
  }
}
