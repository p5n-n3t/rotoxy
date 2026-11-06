import { createHash, randomUUID } from "node:crypto";
import type { PersistedState } from "./types.js";
import type { StateStore } from "./store.js";

const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_BINDINGS = 128;
const MAX_ALIASES_PER_BINDING = 16;
const MAX_LEASE_MS = 30 * 24 * 60 * 60 * 1000;
const SUBJECT_DOMAIN = "rotoxy:subscription-origin-subject:v1\0";
const ACTOR_DOMAIN = "rotoxy:subscription-origin-actor:v1\0";

interface OriginBinding {
  bindingId: string;
  actorHash: string;
  nativeProfileId: string;
  protectedProfileIds: string[];
  subjectHash: string;
  createdAt: number;
  expiresAt: number;
  closedAt?: number;
  revision: number;
}

interface OriginProtectionDocument {
  version: 1;
  revision: number;
  bindings: OriginBinding[];
}

type ExtendedState = PersistedState & { originProtection?: OriginProtectionDocument };
const EMPTY: OriginProtectionDocument = { version: 1, revision: 0, bindings: [] };

export interface OriginActor { clientId: string; sessionId: string }
export interface OriginBindingEvidence {
  actor: OriginActor;
  nativeProfileId: string;
  profileAliases: readonly string[];
  verifiedProviderAccountSubject: string;
  source: "trusted-server-resolver";
}
export interface OriginRevisionInput { expectedRevision: number }
export interface OriginProtectionDecision {
  allowed: boolean;
  reason?: "origin_unknown" | "origin_expired" | "origin_unverified" | "native_origin_protected";
  revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function digest(domain: string, value: string): string {
  return createHash("sha256").update(domain).update(value).digest("hex");
}
function validActor(actor: unknown): actor is OriginActor {
  return isRecord(actor) && typeof actor.clientId === "string" && OPAQUE_ID.test(actor.clientId) &&
    typeof actor.sessionId === "string" && OPAQUE_ID.test(actor.sessionId);
}
function actorHash(actor: OriginActor): string {
  return digest(ACTOR_DOMAIN, actor.clientId + "\0" + actor.sessionId);
}
function subjectHash(subject: unknown): string | undefined {
  if (typeof subject !== "string" || !subject.trim() || subject.length > 512 || /[\u0000-\u001f\u007f]/.test(subject)) return undefined;
  return digest(SUBJECT_DOMAIN, subject);
}

function parseDocument(value: unknown): OriginProtectionDocument {
  if (value === undefined) return structuredClone(EMPTY);
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
      !Array.isArray(value.bindings) || value.bindings.length > MAX_BINDINGS) throw new Error("origin protection state is invalid");
  const bindings: OriginBinding[] = [];
  for (const raw of value.bindings) {
    if (!isRecord(raw) || typeof raw.bindingId !== "string" || !PROFILE_ID.test(raw.bindingId) ||
        typeof raw.actorHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.actorHash) ||
        typeof raw.nativeProfileId !== "string" || !PROFILE_ID.test(raw.nativeProfileId) ||
        !Array.isArray(raw.protectedProfileIds) || raw.protectedProfileIds.length < 1 || raw.protectedProfileIds.length > MAX_ALIASES_PER_BINDING ||
        raw.protectedProfileIds.some((id) => typeof id !== "string" || !PROFILE_ID.test(id)) ||
        typeof raw.subjectHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.subjectHash) ||
        !Number.isSafeInteger(raw.createdAt) || !Number.isSafeInteger(raw.expiresAt) || !Number.isSafeInteger(raw.revision) ||
        Number(raw.expiresAt) <= Number(raw.createdAt) ||
        (raw.closedAt !== undefined && !Number.isSafeInteger(raw.closedAt))) throw new Error("origin protection state is invalid");
    const aliases = [...new Set(raw.protectedProfileIds as string[])];
    if (!aliases.includes(raw.nativeProfileId as string)) throw new Error("origin protection aliases are invalid");
    bindings.push({
      bindingId: raw.bindingId, actorHash: raw.actorHash, nativeProfileId: raw.nativeProfileId,
      protectedProfileIds: aliases, subjectHash: raw.subjectHash, createdAt: Number(raw.createdAt),
      expiresAt: Number(raw.expiresAt), ...(raw.closedAt !== undefined ? { closedAt: Number(raw.closedAt) } : {}),
      revision: Number(raw.revision),
    });
  }
  return { version: 1, revision: Number(value.revision), bindings };
}

function validateEvidence(evidence: OriginBindingEvidence): { actorHash: string; subjectHash: string; aliases: string[] } {
  if (!evidence || evidence.source !== "trusted-server-resolver" || !validActor(evidence.actor) ||
      !PROFILE_ID.test(evidence.nativeProfileId) || !Array.isArray(evidence.profileAliases) ||
      evidence.profileAliases.length < 1 || evidence.profileAliases.length > MAX_ALIASES_PER_BINDING ||
      evidence.profileAliases.some((id) => typeof id !== "string" || !PROFILE_ID.test(id))) {
    throw new TypeError("trusted origin binding evidence is invalid");
  }
  const aliases = [...new Set([evidence.nativeProfileId, ...evidence.profileAliases])];
  if (aliases.length > MAX_ALIASES_PER_BINDING) throw new TypeError("origin profile alias limit exceeded");
  const hashedSubject = subjectHash(evidence.verifiedProviderAccountSubject);
  if (!hashedSubject) throw new TypeError("verified provider account subject is invalid");
  return { actorHash: actorHash(evidence.actor), subjectHash: hashedSubject, aliases };
}

/** Private, revision-fenced origin protection data stored in the existing StateStore document. */
export class OriginProtectionStore {
  constructor(private readonly store: StateStore, private readonly now: () => number = Date.now) {}

  private async read(): Promise<OriginProtectionDocument> {
    const state = await this.store.load() as ExtendedState;
    return parseDocument(state.originProtection);
  }

  async snapshot(): Promise<{ revision: number; bindings: number }> {
    const document = await this.read();
    return { revision: document.revision, bindings: document.bindings.length };
  }

  async bindOrRenew(input: OriginBindingEvidence & OriginRevisionInput & { bindingId?: string; expiresAt: number }): Promise<{ bindingId: string; revision: number; expiresAt: number }> {
    const evidence = validateEvidence(input);
    const now = this.now();
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + MAX_LEASE_MS) {
      throw new TypeError("origin binding lease or revision is invalid");
    }
    let output!: { bindingId: string; revision: number; expiresAt: number };
    await this.store.update((rawState) => {
      const state = rawState as ExtendedState;
      const document = parseDocument(state.originProtection);
      if (document.revision !== input.expectedRevision) throw new Error("origin protection revision conflict");
      const existing = input.bindingId ? document.bindings.find((binding) => binding.bindingId === input.bindingId) : undefined;
      if (input.bindingId && (!existing || existing.actorHash !== evidence.actorHash || existing.closedAt !== undefined)) {
        throw new Error("origin binding ownership conflict");
      }
      const actorBinding = document.bindings.find((binding) => binding.actorHash === evidence.actorHash && binding.closedAt === undefined);
      if (!existing && actorBinding) throw new Error("origin actor already has an open binding");
      if (existing && (existing.nativeProfileId !== input.nativeProfileId || existing.subjectHash !== evidence.subjectHash ||
          input.expiresAt <= existing.expiresAt)) throw new Error("origin renewal identity conflict");
      if (!existing && document.bindings.length >= MAX_BINDINGS) throw new Error("origin binding capacity reached");
      const revision = document.revision + 1;
      if (existing) {
        existing.protectedProfileIds = [...new Set([...existing.protectedProfileIds, ...evidence.aliases])];
        if (existing.protectedProfileIds.length > MAX_ALIASES_PER_BINDING) throw new Error("origin profile alias limit exceeded");
        existing.expiresAt = input.expiresAt;
        existing.revision = revision;
        output = { bindingId: existing.bindingId, revision, expiresAt: existing.expiresAt };
      } else {
        const binding: OriginBinding = {
          bindingId: randomUUID(), actorHash: evidence.actorHash, nativeProfileId: input.nativeProfileId,
          protectedProfileIds: evidence.aliases, subjectHash: evidence.subjectHash,
          createdAt: now, expiresAt: input.expiresAt, revision,
        };
        document.bindings.push(binding);
        output = { bindingId: binding.bindingId, revision, expiresAt: binding.expiresAt };
      }
      document.revision = revision;
      state.originProtection = document;
    });
    return output;
  }

  async close(input: OriginActor & { bindingId: string; expectedRevision: number }): Promise<{ revision: number }> {
    if (!validActor(input) || !PROFILE_ID.test(input.bindingId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new TypeError("origin close request is invalid");
    }
    let revision = 0;
    await this.store.update((rawState) => {
      const state = rawState as ExtendedState;
      const document = parseDocument(state.originProtection);
      if (document.revision !== input.expectedRevision) throw new Error("origin protection revision conflict");
      const binding = document.bindings.find((row) => row.bindingId === input.bindingId);
      if (!binding || binding.actorHash !== actorHash(input) || binding.closedAt !== undefined) throw new Error("origin binding ownership conflict");
      revision = document.revision + 1;
      binding.closedAt = this.now();
      binding.revision = revision;
      document.revision = revision;
      state.originProtection = document;
    });
    return { revision };
  }

  async listAdmin(): Promise<Array<{ bindingId: string; nativeProfileId: string; expiresAt: number; closed: boolean }>> {
    const document = await this.read();
    return document.bindings.map(binding => ({ bindingId: binding.bindingId, nativeProfileId: binding.nativeProfileId, expiresAt: binding.expiresAt, closed: binding.closedAt !== undefined }));
  }

  /** Resolve protected aliases only for an existing authenticated client/session lease. */
  async resolve(actor: OriginActor): Promise<{ resolved: boolean; protectedProfileIds: string[] }> {
    const document = await this.read();
    if (!validActor(actor)) return { resolved: false, protectedProfileIds: [] };
    const own = document.bindings.find(binding => binding.actorHash === actorHash(actor) && binding.closedAt === undefined);
    if (!own || own.expiresAt <= this.now()) return { resolved: false, protectedProfileIds: [] };
    return { resolved: true, protectedProfileIds: [...new Set(document.bindings.filter(binding => binding.closedAt === undefined).flatMap(binding => binding.protectedProfileIds))] };
  }

  /** Subscription-only gate; API-key and local inference pools do not call this policy. */
  async evaluateSubscriptionDispatch(actor: OriginActor, targetProfileId: string, verifiedProviderAccountSubject: string | undefined): Promise<OriginProtectionDecision> {
    const document = await this.read();
    const revision = document.revision;
    if (!validActor(actor) || !PROFILE_ID.test(targetProfileId)) return { allowed: false, reason: "origin_unknown", revision };
    const own = document.bindings.find((binding) => binding.actorHash === actorHash(actor) && binding.closedAt === undefined);
    if (!own) return { allowed: false, reason: "origin_unknown", revision };
    if (own.expiresAt <= this.now()) return { allowed: false, reason: "origin_expired", revision };
    const targetSubjectHash = subjectHash(verifiedProviderAccountSubject);
    if (!targetSubjectHash) return { allowed: false, reason: "origin_unverified", revision };

    // Expired bindings remain protected until their owner explicitly closes them.
    const protectedBindings = document.bindings.filter((binding) => binding.closedAt === undefined);
    const protectedProfiles = new Set(protectedBindings.flatMap((binding) => binding.protectedProfileIds));
    const protectedSubjects = new Set(protectedBindings.map((binding) => binding.subjectHash));
    if (protectedProfiles.has(targetProfileId) || protectedSubjects.has(targetSubjectHash)) {
      return { allowed: false, reason: "native_origin_protected", revision };
    }
    return { allowed: true, revision };
  }
}
