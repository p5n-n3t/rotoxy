import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const api = await import(pathToFileURL(path.resolve("dist/credit-snapshots.js")).href);
const account = { provider: "lightsprint", accountId: "ls-01", label: "LS", unit: "credits" };

async function storeFor(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rotoxy-renewal-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new api.CreditSnapshotStore([account], { directory: dir });
}

test("scheduled renewal is idempotent, effective on its UTC date, and waits for verification", async t => {
  const store = await storeFor(t);
  const scheduledAt = Date.parse("2026-10-31T12:00:00.000Z");
  const input = { provider: "lightsprint", accountId: "ls-01", dueDate: "2026-11-03", scheduledAt, auditId: "schedule-1", source: "user-scheduled-estimate" };
  const first = await store.scheduleRenewal(input);
  const duplicate = await store.scheduleRenewal({ ...input, auditId: "schedule-replayed" });
  assert.deepEqual(duplicate, first);
  assert.equal((await store.checkScheduledRenewals(Date.parse("2026-11-02T23:59:59.999Z")))[0].status, "scheduled");
  await assert.rejects(store.verifyScheduledRenewal({ accountId: "ls-01", dueDate: "2026-11-03", verifiedAt: Date.parse("2026-11-02T23:59:59.999Z"), auditId: "verify-too-early", evidence: "test" }), /not due/);
  const due = await store.checkScheduledRenewals(Date.parse("2026-11-03T00:00:00.000Z"));
  assert.equal(due[0].status, "due-pending-verification");
  const checkedAt = due[0].checkedAt;
  assert.equal((await store.checkScheduledRenewals(Date.parse("2026-11-04T00:00:00.000Z")))[0].checkedAt, checkedAt, "repeat timer checks do not duplicate or move the effective boundary");
  let view = api.summarizeCredits([account], await store.load(), { now: Date.parse("2026-11-04T00:00:00.000Z") })[0];
  assert.equal(view.estimatedRemaining, null, "a scheduled estimate does not create a 10M balance");
  assert.equal(view.scheduledRenewal.status, "due-pending-verification");
  await store.verifyScheduledRenewal({ accountId: "ls-01", dueDate: "2026-11-03", verifiedAt: Date.parse("2026-11-04T00:00:00.000Z"), auditId: "verify-1", evidence: "provider notice confirmed by operator" });
  await store.verifyScheduledRenewal({ accountId: "ls-01", dueDate: "2026-11-03", verifiedAt: Date.parse("2026-11-04T00:00:00.000Z"), auditId: "verify-1", evidence: "provider notice confirmed by operator" });
  view = api.summarizeCredits([account], await store.load(), { now: Date.parse("2026-11-04T00:00:00.000Z") })[0];
  assert.equal(view.estimatedRemaining, 10_000_000);
  assert.equal(view.scheduledRenewal, undefined, "verified schedule no longer renders as pending");
});

test("future dates stay scheduled, overage clamps to zero, and only quota-disabled accounts restore", () => {
  assert.equal(api.remainingAfterUsage(10_000_000), 0);
  assert.equal(api.remainingAfterUsage(10_000_001), 0);
  assert.equal(api.remainingAfterUsage(2_400_000), 7_600_000);
  assert.equal(api.shouldRestoreQuotaDisabledAccount({ enabled: false, quotaDisabledBy: "quota-policy" }), true);
  assert.equal(api.shouldRestoreQuotaDisabledAccount({ enabled: false }), false, "manual disables remain untouched");
  assert.equal(api.shouldRestoreQuotaDisabledAccount({ enabled: true, quotaDisabledBy: "quota-policy" }), false);
});

test("explicit account toggles remove quota-owned restoration permission", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rotoxy-manual-pause-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const priorConfig = process.env.ROTOXY_CONFIG_DIR;
  process.env.ROTOXY_CONFIG_DIR = dir;
  t.after(() => { if (priorConfig === undefined) delete process.env.ROTOXY_CONFIG_DIR; else process.env.ROTOXY_CONFIG_DIR = priorConfig; });
  const { StateStore } = await import("../dist/store.js");
  const store = new StateStore();
  await store.init({ adminPassword: "synthetic-manual-pause-test-password" });
  const saved = await store.addAccount({ label: "Quota test", token: "synthetic-quota-test-credential" });
  await store.update(state => {
    const row = state.accounts.find(item => item.id === saved.id);
    row.enabled = false;
    row.metadata = { ...row.metadata, quotaDisabledBy: "quota-policy", disabledReason: "quota-depleted" };
  });
  await store.setAccountEnabled(saved.id, false);
  const row = (await store.load()).accounts.find(item => item.id === saved.id);
  assert.equal(row.enabled, false);
  assert.equal(api.shouldRestoreQuotaDisabledAccount({ enabled: row.enabled, quotaDisabledBy: row.metadata.quotaDisabledBy }), false);
  assert.equal(row.metadata.quotaDisabledBy, undefined);
});

test("balance snapshot audit IDs are idempotent and reject conflicting refresh replays", async t => {
  const store = await storeFor(t);
  const input = { auditId: "snap-1", provider: "lightsprint", accountId: "ls-01", unit: "credits", remaining: 0, observedAt: Date.parse("2026-10-31T12:00:00.000Z"), source: "user-reported", refreshDate: "2026-11-03" };
  const first = await store.recordBalanceSnapshot(input);
  const replay = await store.recordBalanceSnapshot(input);
  assert.deepEqual(replay, first);
  await assert.rejects(store.recordBalanceSnapshot({ ...input, remaining: 1 }), /different balance snapshot/);
  assert.equal((await store.load()).snapshots.length, 1);
});
