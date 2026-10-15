import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decryptSecret, encryptSecret, ensureMasterKey, randomToken } from "./crypto.js";
import type { EncryptedSecret } from "./types.js";
import type { StateStore } from "./store.js";

export type ModelScope = "model:read" | "model:invoke";
export interface ModelCredentialView { id: string; label: string; enabled: boolean; createdAt: number; cooldownUntil?: number }
export interface ModelCredentialUpdate { label?: string; enabled?: boolean }
interface ModelAccount extends ModelCredentialView { secret: EncryptedSecret }
interface ModelToken { id: string; hash: string; scopes: ModelScope[]; createdAt: number; expiresAt: number }
interface ModelCredentialAuditEntry { action: "credential_removed"; credentialId: string; at: number }
interface ModelDocument { version: 1; accounts: ModelAccount[]; tokens: ModelToken[]; audit?: ModelCredentialAuditEntry[] }
const EMPTY: ModelDocument = { version: 1, accounts: [], tokens: [] };
const MAX_CREDENTIAL_AUDIT = 500;
const TOKEN_LIFETIME_MAX_SECONDS = 90 * 24 * 60 * 60;
const labelRe = /^[^\u0000-\u001f\u007f]{1,80}$/;

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function validApiKey(value: unknown): value is string { return typeof value === "string" && value.length >= 8 && value.length <= 4096 && !/[\r\n\0]/.test(value); }
function validId(value: string): boolean { return /^[A-Za-z0-9_-]{8,80}$/.test(value); }

/** Encrypted Ollama credentials and independent hashed gateway tokens. Never stored in MCP accounts. */
export class ModelCredentialStore {
  private readonly file: string;
  private readonly keyPath: string;
  constructor(private readonly store: StateStore) {
    this.file = join(store.dir, "model-credentials.json");
    this.keyPath = store.keyPath;
  }

  private async read(): Promise<ModelDocument> {
    try {
      const doc = JSON.parse(await readFile(this.file, "utf8")) as ModelDocument;
      if (doc.version !== 1 || !Array.isArray(doc.accounts) || !Array.isArray(doc.tokens) ||
          doc.audit !== undefined && (!Array.isArray(doc.audit) || doc.audit.length > MAX_CREDENTIAL_AUDIT || doc.audit.some((entry) =>
            !entry || entry.action !== "credential_removed" || typeof entry.credentialId !== "string" || !validId(entry.credentialId) || !Number.isSafeInteger(entry.at)))) {
        throw new Error("invalid model credential store");
      }
      return doc;
    } catch (error: any) {
      if (error?.code === "ENOENT") return structuredClone(EMPTY);
      throw error;
    }
  }

  private async write(doc: ModelDocument): Promise<void> {
    await mkdir(this.store.dir, { recursive: true, mode: 0o700 });
    await chmod(this.store.dir, 0o700).catch(() => undefined);
    const temp = `${this.file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
    await writeFile(temp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }

  private async mutate<T>(fn: (doc: ModelDocument) => T | Promise<T>): Promise<T> {
    let result!: T;
    // Share StateStore's cross-process lock so the adjacent encrypted document
    // is serialized with all other writes in this gateway installation.
    await this.store.update(async () => {
      const doc = await this.read();
      result = await fn(doc);
      await this.write(doc);
    });
    return result;
  }

  async listCredentials(): Promise<ModelCredentialView[]> {
    return (await this.read()).accounts.map(({ id, label, enabled, createdAt, cooldownUntil }) => ({ id, label, enabled, createdAt, ...(cooldownUntil ? { cooldownUntil } : {}) }));
  }

  async addCredential(label: string, apiKey: string): Promise<ModelCredentialView> {
    const normalizedLabel = typeof label === "string" ? label.trim() : "";
    if (!normalizedLabel || !labelRe.test(normalizedLabel) || !validApiKey(apiKey)) throw new TypeError("model credential label or API key is invalid");
    return this.mutate(async (doc) => {
      const master = await ensureMasterKey(this.keyPath);
      const account: ModelAccount = { id: randomToken(12), label: normalizedLabel, enabled: true, createdAt: Date.now(), secret: encryptSecret(apiKey, master) };
      doc.accounts.push(account);
      return { id: account.id, label: account.label, enabled: true, createdAt: account.createdAt };
    });
  }

  async rotateCredential(id: string, apiKey: string): Promise<void> {
    if (!validId(id) || !validApiKey(apiKey)) throw new TypeError("model credential id or API key is invalid");
    await this.mutate(async (doc) => {
      const account = doc.accounts.find((entry) => entry.id === id);
      if (!account) throw new Error("model credential not found");
      account.secret = encryptSecret(apiKey, await ensureMasterKey(this.keyPath));
      account.cooldownUntil = undefined;
      account.enabled = true;
    });
  }

  async setCredentialEnabled(id: string, enabled: boolean): Promise<void> {
    if (!validId(id) || typeof enabled !== "boolean") throw new TypeError("model credential update is invalid");
    await this.mutate((doc) => {
      const account = doc.accounts.find((entry) => entry.id === id);
      if (!account) throw new Error("model credential not found");
      account.enabled = enabled;
    });
  }

  /** Update only public metadata; API key rotation stays on rotateCredential. */
  async updateCredential(id: string, update: ModelCredentialUpdate): Promise<ModelCredentialView> {
    if (!validId(id) || !update || typeof update !== "object" || Array.isArray(update) ||
        !Object.keys(update).length || Object.keys(update).some((key) => key !== "label" && key !== "enabled") ||
        Object.hasOwn(update, "label") && (typeof update.label !== "string" || !labelRe.test(update.label.trim())) ||
        Object.hasOwn(update, "enabled") && typeof update.enabled !== "boolean") {
      throw new TypeError("model credential update is invalid");
    }
    const label = Object.hasOwn(update, "label") ? update.label!.trim() : undefined;
    return this.mutate((doc) => {
      const account = doc.accounts.find((entry) => entry.id === id);
      if (!account) throw new Error("model credential not found");
      if (label && doc.accounts.some((entry) => entry.id !== id && entry.label.toLocaleLowerCase() === label.toLocaleLowerCase())) {
        throw new Error("model credential label already exists");
      }
      if (label !== undefined) account.label = label;
      if (update.enabled !== undefined) account.enabled = update.enabled;
      const { secret: _secret, ...view } = account;
      return { ...view };
    });
  }

  async renameCredential(id: string, label: string): Promise<ModelCredentialView> {
    return this.updateCredential(id, { label });
  }

  /** Remove one Ollama credential while preserving independent client tokens and audit history. */
  async removeCredential(id: string): Promise<void> {
    if (!validId(id)) throw new TypeError("model credential id is invalid");
    await this.mutate((doc) => {
      const index = doc.accounts.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error("model credential not found");
      doc.accounts.splice(index, 1);
      doc.audit = [...(doc.audit || []), { action: "credential_removed" as const, credentialId: id, at: Date.now() }].slice(-MAX_CREDENTIAL_AUDIT);
    });
  }

  async setCooldown(id: string, cooldownUntil: number): Promise<void> {
    await this.mutate((doc) => {
      const account = doc.accounts.find((entry) => entry.id === id);
      if (account) account.cooldownUntil = Math.max(Date.now(), Math.min(cooldownUntil, Date.now() + 60 * 60_000));
    });
  }

  async credentialForRequest(id: string): Promise<{ view: ModelCredentialView; apiKey: string } | undefined> {
    const doc = await this.read();
    const account = doc.accounts.find((entry) => entry.id === id);
    if (!account) return undefined;
    const { secret, ...view } = account;
    return { view, apiKey: decryptSecret(secret, await ensureMasterKey(this.keyPath)) };
  }

  async issueToken(input: { scopes: ModelScope[]; expiresInSeconds: number }): Promise<{ id: string; token: string; scopes: ModelScope[]; expiresAt: number }> {
    const scopes = [...new Set(input?.scopes || [])];
    const expiresInSeconds = input?.expiresInSeconds;
    if (!scopes.length || scopes.some((scope) => scope !== "model:read" && scope !== "model:invoke") ||
        !Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > TOKEN_LIFETIME_MAX_SECONDS) {
      throw new TypeError("model token scopes or lifetime are invalid");
    }
    const token = "t2om_" + randomToken(32);
    const id = randomToken(12);
    const createdAt = Date.now();
    const expiresAt = createdAt + expiresInSeconds * 1000;
    await this.mutate((doc) => { doc.tokens.push({ id, hash: hash(token), scopes, createdAt, expiresAt }); });
    return { id, token, scopes, expiresAt };
  }

  async revokeToken(id: string): Promise<boolean> {
    if (!validId(id)) throw new TypeError("model token id is invalid");
    return this.mutate((doc) => {
      const prior = doc.tokens.length;
      doc.tokens = doc.tokens.filter((token) => token.id !== id);
      return prior !== doc.tokens.length;
    });
  }

  async listTokens(): Promise<Array<{ id: string; scopes: ModelScope[]; expiresAt: number }>> {
    return (await this.read()).tokens.map(({ id, scopes, expiresAt }) => ({ id, scopes, expiresAt }));
  }

  /** Explicit local migration only: preserve a previously issued proxy token as a hash. */
  async importLegacyToken(token: string, expiresAt: number): Promise<string> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + TOKEN_LIFETIME_MAX_SECONDS * 1000) throw new TypeError("legacy token migration is invalid");
    return this.mutate((doc) => {
      const digest = hash(token);
      const prior = doc.tokens.find((entry) => entry.hash === digest);
      if (prior) return prior.id;
      const id = randomToken(12);
      doc.tokens.push({ id, hash: digest, scopes: ["model:read", "model:invoke"], createdAt: Date.now(), expiresAt });
      return id;
    });
  }

  async authorizeToken(token: string, scope: ModelScope, now = Date.now()): Promise<boolean> {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return false;
    const candidate = Buffer.from(hash(token), "hex");
    const doc = await this.read();
    return doc.tokens.some((record) => {
      const stored = Buffer.from(record.hash, "hex");
      return record.expiresAt > now && record.scopes.includes(scope) && stored.length === candidate.length && timingSafeEqual(stored, candidate);
    });
  }
}

/** Import caller-supplied legacy keys without reading host files or printing key material. */
export async function migrateLegacyOllamaCredentials(store: ModelCredentialStore, legacy: {
  accounts?: Array<{ label: string; apiKey: string }>;
  apiKeys?: string[];
}): Promise<{ imported: number; credentialIds: string[] }> {
  const entries = legacy?.accounts ?? (legacy?.apiKeys || []).map((apiKey, index) => ({ label: `Imported Ollama key ${index + 1}`, apiKey }));
  if (!Array.isArray(entries) || entries.length > 100) throw new TypeError("legacy Ollama credential list is invalid");
  const credentialIds: string[] = [];
  for (const entry of entries) credentialIds.push((await store.addCredential(entry.label, entry.apiKey)).id);
  return { imported: credentialIds.length, credentialIds };
}
