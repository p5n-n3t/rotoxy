import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StateStore } from "../dist/store.js";
import { OriginProtectionStore } from "../dist/origin-protection.js";

const profile = () => randomUUID();
const actor = (clientId, sessionId) => ({ clientId, sessionId });
const evidence = (owner, nativeProfileId, subject, aliases = [nativeProfileId]) => ({
  actor: owner, nativeProfileId, profileAliases: aliases,
  verifiedProviderAccountSubject: subject, source: "trusted-server-resolver",
});

async function harness(t, now = 10_000) {
  const dir = await mkdtemp(join(tmpdir(), "rotoxy-origin-protection-"));
  const previous = process.env.ROTOXY_CONFIG_DIR;
  process.env.ROTOXY_CONFIG_DIR = dir;
  const store = new StateStore();
  if (previous === undefined) delete process.env.ROTOXY_CONFIG_DIR; else process.env.ROTOXY_CONFIG_DIR = previous;
  await store.init({ adminPassword: "origin-protection-test-password" });
  const protection = new OriginProtectionStore(store, () => now);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store, protection };
}

test("origin bindings survive restart; expired leases block their actor and retain protection until renewed or closed", async (t) => {
  const h = await harness(t);
  const owner = actor("client-one", "session-one");
  const native = profile(), alias = profile(), target = profile();
  const binding = await h.protection.bindOrRenew({
    ...evidence(owner, native, "provider-subject-secret-sentinel", [native, alias]),
    expectedRevision: 0, expiresAt: 20_000,
  });
  const raw = await readFile(join(h.dir, "state.json"), "utf8");
  assert.doesNotMatch(raw, /provider-subject-secret-sentinel/);

  const restarted = new OriginProtectionStore(h.store, () => 20_001);
  assert.deepEqual(await restarted.snapshot(), { revision: 1, bindings: 1 });
  const expired = await restarted.evaluateSubscriptionDispatch(owner, target, "another-verified-subject");
  assert.deepEqual(expired, { allowed: false, reason: "origin_expired", revision: 1 });

  const second = actor("client-two", "session-two");
  await restarted.bindOrRenew({
    ...evidence(second, target, "second-subject"),
    expectedRevision: 1, expiresAt: 40_000,
  });
  assert.equal((await restarted.evaluateSubscriptionDispatch(second, alias, "provider-subject-secret-sentinel")).reason, "native_origin_protected",
    "an expired native lease keeps its profiles and account subject protected for every actor");

  const renewed = await new OriginProtectionStore(h.store, () => 20_001).bindOrRenew({
    ...evidence(owner, native, "provider-subject-secret-sentinel", [native, alias]),
    bindingId: binding.bindingId, expectedRevision: 2, expiresAt: 50_000,
  });
  assert.equal(renewed.bindingId, binding.bindingId);
  assert.equal(renewed.revision, 3);
});

test("simultaneous actors union protected aliases for a shared provider subject", async (t) => {
  const h = await harness(t);
  const first = actor("client-one", "session-one");
  const second = actor("client-two", "session-two");
  const ids = [profile(), profile(), profile(), profile(), profile()];
  await h.protection.bindOrRenew({ ...evidence(first, ids[0], "same-account", [ids[0], ids[1]]), expectedRevision: 0, expiresAt: 30_000 });
  await h.protection.bindOrRenew({ ...evidence(second, ids[2], "same-account", [ids[2], ids[3]]), expectedRevision: 1, expiresAt: 30_000 });

  assert.equal((await h.protection.evaluateSubscriptionDispatch(first, ids[3], "different-subject")).reason, "native_origin_protected");
  assert.equal((await h.protection.evaluateSubscriptionDispatch(first, ids[4], "same-account")).reason, "native_origin_protected");
  assert.deepEqual(await h.protection.evaluateSubscriptionDispatch(first, ids[4], "unrelated-account"), { allowed: true, revision: 2 });
});

test("only the owning actor can renew or close; stale revisions cannot clear a binding", async (t) => {
  const h = await harness(t);
  const owner = actor("client-owner", "session-owner");
  const other = actor("client-other", "session-other");
  const native = profile();
  const binding = await h.protection.bindOrRenew({ ...evidence(owner, native, "subject-owner"), expectedRevision: 0, expiresAt: 30_000 });
  await h.protection.bindOrRenew({ ...evidence(other, profile(), "subject-other"), expectedRevision: 1, expiresAt: 30_000 });
  await assert.rejects(h.protection.close({ ...other, bindingId: binding.bindingId, expectedRevision: 2 }), /ownership conflict/);
  await assert.rejects(h.protection.close({ ...owner, bindingId: binding.bindingId, expectedRevision: 1 }), /revision conflict/);
  await assert.rejects(h.protection.bindOrRenew({
    ...evidence(other, profile(), "subject-owner"), bindingId: binding.bindingId,
    expectedRevision: 2, expiresAt: 40_000,
  }), /ownership conflict/);
  assert.deepEqual(await h.protection.snapshot(), { revision: 2, bindings: 2 });

  const closed = await h.protection.close({ ...owner, bindingId: binding.bindingId, expectedRevision: 2 });
  assert.equal(closed.revision, 3);
  assert.equal((await h.protection.evaluateSubscriptionDispatch(owner, profile(), undefined)).reason, "origin_unknown");
  assert.deepEqual(await h.protection.evaluateSubscriptionDispatch(other, native, "subject-owner"), { allowed: true, revision: 3 },
    "closing is explicit; only then are this binding's native profile and subject released");
});

test("unknown or unverified origin evidence blocks subscription dispatch", async (t) => {
  const h = await harness(t);
  const owner = actor("client-one", "session-one");
  const target = profile();
  assert.equal((await h.protection.evaluateSubscriptionDispatch(owner, target, "verified-subject")).reason, "origin_unknown");
  await assert.rejects(h.protection.bindOrRenew({
    ...evidence(owner, profile(), "subject"),
    source: "client-label",
    expectedRevision: 0, expiresAt: 30_000,
  }), /trusted origin binding evidence is invalid/);
  await h.protection.bindOrRenew({ ...evidence(owner, profile(), "subject"), expectedRevision: 0, expiresAt: 30_000 });
  assert.equal((await h.protection.evaluateSubscriptionDispatch(owner, target, undefined)).reason, "origin_unverified");
});


test("origin protection accepts opaque OAuth client IDs beginning with underscore or hyphen", async t => {
  const h = await harness(t);
  const native = profile();
  for (const [index, clientId] of ["_opaque-client", "-opaque-client"].entries()) {
    const owner = actor(clientId, "session-one");
    await h.protection.bindOrRenew({ ...evidence(owner, native, "native-subject"), expectedRevision: index, expiresAt: 30000 });
    assert.equal((await h.protection.resolve(owner)).resolved, true);
    assert.equal((await h.protection.evaluateSubscriptionDispatch(owner, native, "native-subject")).reason, "native_origin_protected");
  }
});
