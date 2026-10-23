import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.resolve("dist/credit-snapshots.js")).href;
const api = await import(moduleUrl);
const now = Date.parse("2026-11-07T12:00:00.000Z");
const lightsprint = (accountId = "ls-01", label = "LS account") => ({ provider: "lightsprint", accountId, label, unit: "credits" });
const exa = (accountId = "exa-01") => ({ provider: "exa", accountId, label: "Exa account", unit: "USD" });

async function isolatedStore(accounts = [lightsprint(), exa()]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "token2oauth-credit-test-"));
  const home = path.join(root, "home");
  const configDir = path.join(root, "private-config");
  await fs.mkdir(home, { recursive: true });
  process.env.HOME = home;
  process.env.TOKEN2OAUTH_CONFIG_DIR = configDir;
  return { root, store: new api.CreditSnapshotStore(accounts, { lockTimeoutMs: 60_000, retryDelayMs: 10 }) };
}

test("lists every configured LightSprint and Exa account, including dormant accounts", () => {
  const config = { accounts: [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `ls-${i}`, label: `LS ${i}`, provider: "lightsprint" })),
    { id: "exa-prod", label: "Exa prod", provider: "exa" },
    { id: "ignored", label: "Other provider", provider: "openai" },
  ] };
  const accounts = api.listCreditAccounts(config);
  assert.equal(accounts.length, 13);
  assert.equal(accounts.filter((account) => account.provider === "lightsprint").length, 12);
  assert.equal(accounts.find((account) => account.accountId === "ls-11").unit, "credits");
  assert.equal(accounts.find((account) => account.provider === "exa").unit, "USD");
});

test("serializes concurrent ledger writes and atomically persists private files", async () => {
  const { root, store } = await isolatedStore();
  try {
    await Promise.all(Array.from({ length: 40 }, (_, i) => store.recordUsage({ id: `u-${i}`, provider: "lightsprint", accountId: "ls-01", unit: "credits", amount: 1, source: "user-reported", observedAt: now + i })));
    const state = await store.load();
    assert.equal(state.usage.length, 40);
    assert.equal(new Set(state.usage.map((entry) => entry.id)).size, 40);
    assert.equal((await fs.stat(path.join(process.env.TOKEN2OAUTH_CONFIG_DIR, "credit-snapshots.json"))).mode & 0o777, 0o600);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("validates configured account, provider unit, non-negative amounts, timestamps, and refresh dates", async () => {
  const { root, store } = await isolatedStore();
  try {
    const base = { auditId: "audit-1", provider: "lightsprint", accountId: "ls-01", unit: "credits", remaining: 12, observedAt: now, source: "user-reported" };
    await assert.rejects(store.recordBalanceSnapshot({ ...base, remaining: -1 }), /finite and non-negative/);
    await assert.rejects(store.recordBalanceSnapshot({ ...base, accountId: "not-configured" }), /unknown account/);
    await assert.rejects(store.recordBalanceSnapshot({ ...base, provider: "exa", unit: "credits" }), /requires unit USD/);
    await assert.rejects(store.recordBalanceSnapshot({ ...base, observedAt: Number.NaN }), /valid epoch/);
    await assert.rejects(store.recordBalanceSnapshot({ ...base, refreshDate: "2026-11-31" }), /real calendar date/);
    await assert.rejects(store.recordUsage({ id: "bad", provider: "lightsprint", accountId: "ls-01", unit: "credits", amount: 1, source: "estimated", observedAt: now }), /provenance/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("keeps manual snapshots stale, records correction audit lineage, and resets only on verified renewal", async () => {
  const { root, store } = await isolatedStore();
  try {
    const before = { auditId: "snap-before", provider: "lightsprint", accountId: "ls-01", unit: "credits", remaining: 8_000_000, observedAt: now - 3_600_000, source: "user-reported", refreshDate: "11-06" };
    const saved = await store.recordBalanceSnapshot(before);
    assert.equal(saved.refreshDate, "11-06");
    assert.equal(saved.previousRemaining, undefined);
    const manualView = api.summarizeCredits([lightsprint()], await store.load(), { now });
    assert.equal(manualView[0].balanceSnapshot.stale, true);
    await store.recordBalanceSnapshot({ ...before, auditId: "snap-after", remaining: 7_900_000, source: "provider-reported", observedAt: now });
    const changed = (await store.load()).snapshots.at(-1);
    assert.equal(changed.previousRemaining, 8_000_000);
    assert.equal(changed.previousSource, "user-reported");

    await store.recordUsage({ id: "later", provider: "lightsprint", accountId: "ls-01", unit: "credits", amount: 300, source: "provider-reported", observedAt: now + 1_000 });
    const accounts = [lightsprint()];
    let view = api.summarizeCredits(accounts, await store.load(), { now: now + 1_500 });
    assert.equal(view[0].balanceSnapshot.stale, false);
    assert.equal(view[0].estimatedRemaining, 7_899_700);

    await store.recordVerifiedRenewal({ provider: "lightsprint", accountId: "ls-01", verifiedAt: now + 2_000, auditId: "renewal-1", evidence: "operator verified renewal notice" });
    view = api.summarizeCredits(accounts, await store.load(), { now: now + 3_000 });
    assert.equal(view[0].estimatedRemaining, 10_000_000);
    assert.equal(view[0].monthlyAllowance, 10_000_000);
    assert.match(view[0].estimateProvenance, /verified renewal/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("unknown LightSprint balance stays unknown; known balances subtract only same-unit spend", async () => {
  const { root, store } = await isolatedStore([lightsprint(), lightsprint("ls-02", "New LS account"), exa()]);
  try {
    await store.recordBalanceSnapshot({ auditId: "known", provider: "lightsprint", accountId: "ls-01", unit: "credits", remaining: 10_000_000, observedAt: now - 1, source: "user-reported" });
    await store.recordUsage({ id: "usd", provider: "exa", accountId: "exa-01", unit: "USD", amount: 9, source: "provider-reported", observedAt: now });
    await store.recordUsage({ id: "credit", provider: "lightsprint", accountId: "ls-01", unit: "credits", amount: 250, source: "estimated", provenance: "observed per-task credit estimate", observedAt: now });
    const views = api.summarizeCredits([lightsprint(), lightsprint("ls-02", "New LS account"), exa()], await store.load(), { now,
      sessionSpend: [{ provider: "lightsprint", accountId: "ls-01", amountUsd: 2.5, observedAt: now, source: "provider-reported" }],
      modelSlotUsage: [{ provider: "lightsprint", accountId: "ls-01", model: "m1", slot: "slot-a", observedUsage: 10_000, unit: "tokens" }] });
    assert.equal(views[0].estimatedRemaining, 9_999_750);
    assert.equal(views[0].observedSessionSpendUsd, 2.5);
    assert.equal(views[0].modelSlotUsage[0].debit, null);
    assert.match(views[0].modelSlotUsage[0].debitReason, /does not report/);
    assert.equal(views[1].estimatedRemaining, null);
    assert.match(views[1].estimateProvenance, /No same-unit allowance/);
    assert.equal(views[2].estimatedRemaining, null);
    assert.equal(views[2].debitsBySource["provider-reported"], 9);
    await assert.rejects(store.recordUsage({ id: "wrong-unit", provider: "lightsprint", accountId: "ls-01", unit: "USD", amount: 1, source: "user-reported", observedAt: now }), /requires unit credits/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("separates live holds from debits and excludes released reservations", async () => {
  const { root, store } = await isolatedStore([lightsprint()]);
  try {
    await store.recordBalanceSnapshot({ auditId: "known", provider: "lightsprint", accountId: "ls-01", unit: "credits", remaining: 10_000_000, observedAt: now - 1, source: "user-reported" });
    await store.recordUsage({ id: "debit-1", provider: "lightsprint", accountId: "ls-01", unit: "credits", amount: 10, source: "provider-reported", observedAt: now });
    await store.recordReservation({ id: "hold-a", provider: "lightsprint", accountId: "ls-01", unit: "credits", amount: 500, state: "reserved", observedAt: now });
    await store.recordReservation({ id: "hold-a", provider: "lightsprint", accountId: "ls-01", unit: "credits", amount: 500, state: "released", observedAt: now + 1 });
    await store.recordReservation({ id: "hold-b", provider: "lightsprint", accountId: "ls-01", unit: "credits", amount: 100, state: "inflight", observedAt: now + 1 });
    const [view] = api.summarizeCredits([lightsprint()], await store.load(), { now: now + 2 });
    assert.equal(view.debitsBySource["provider-reported"], 10);
    assert.equal(view.reserved, 0);
    assert.equal(view.inflight, 100);
    assert.equal(view.availableAfterHolds, 9_999_890);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("renderer escapes account labels and keeps USD spend distinct from credits", async () => {
  const html = api.renderCreditSnapshots([{ account: { provider: "lightsprint", accountId: "ls", label: "<script>x</script>", unit: "credits" },
    balanceSnapshot: null, monthlyAllowance: 10_000_000, estimatedRemaining: 10_000_000, estimateProvenance: "estimate basis", debitsBySource: { "provider-reported": 0, "user-reported": 0, estimated: 0 },
    reserved: 0, inflight: 0, availableAfterHolds: 10_000_000, observedSessionSpendUsd: 1.25, modelSlotUsage: [] }]);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("$1.25 USD"));
  assert.match(html, /not converted to LightSprint credits/);
});

test('session cost high-water accounting is durable, deduplicated, and independent of task state', async () => {
  const {root,store}=await isolatedStore();
  const reading={provider:'lightsprint',accountId:'ls-01',sessionId:'session-a',totalUsd:2,observedAt:now,model:'gpt-6-luna'};
  try {
    assert.equal((await store.recordSessionCost(reading)).deltaUsd,0,'first observation is a baseline, not a debit');
    await Promise.all(Array.from({length:5},()=>store.recordSessionCost({...reading,totalUsd:2.4,observedAt:now+10})));
    await store.recordSessionCost({...reading,totalUsd:9,observedAt:now-10});
    assert.equal((await store.recordSessionCost({...reading,totalUsd:1,observedAt:now+20})).status,'counter_decreased');
    const state=await store.load();
    assert.equal(state.sessionCosts.length,2);
    assert.equal(state.sessionCosts.reduce((sum,row)=>sum+row.deltaUsd,0),0.4);
    const reopened=new api.CreditSnapshotStore([lightsprint()],{directory:path.join(root,'private-config')});
    assert.equal((await reopened.recordSessionCost({...reading,totalUsd:2.6,observedAt:now+30})).deltaUsd,0.2);
    const view=api.summarizeCredits([lightsprint()],await reopened.load(),{now:now+40})[0];
    assert.equal(view.observedSessionSpendUsd,0.6);
    assert.equal(view.estimatedRemaining,null,'USD never becomes credits without a verified conversion');
    assert.equal((await fs.stat(path.join(root,'private-config','credit-snapshots.json'))).mode&0o077,0);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
