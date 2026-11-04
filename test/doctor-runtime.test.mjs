import test from "node:test";
import assert from "node:assert/strict";
import { collectDoctorSnapshot } from "../dist/doctor-runtime.js";

function account(id, enabled, lastProbeAt, lastProbeOk, lastProbeStatus, lastProbeError) {
  return { id, label: id, enabled, stats: { state: "healthy", lastProbeAt, lastProbeOk, lastProbeStatus, lastProbeError } };
}

function fakeStore(accounts, capabilities) {
  const state = { config: { upstreamUrl: "https://provider.example/mcp", publicBaseUrl: "https://gateway.example",
    basePath: "", requestTimeoutMs: 10_000 }, accounts, capabilities, oauthClients: [] };
  return { load: async () => state, revealToken: async () => "synthetic-token" };
}

test("doctor uses the newest fresh enabled failure and ignores disabled-account success", async () => {
  const now = Date.now();
  const accounts = [
    account("enabled-old-success", true, now - 6 * 60_000, true, 200),
    account("enabled-new-failure", true, now - 1_000, false, 401, "unauthorized"),
    account("disabled-new-success", false, now - 500, true, 200),
  ];
  const capabilities = {
    "enabled-old-success": { capturedAt: now - 6 * 60_000, ok: true, tools: [{ name: "old" }] },
    "enabled-new-failure": { capturedAt: now - 1_000, ok: false, error: "inventory rejected", tools: [] },
    "disabled-new-success": { capturedAt: now - 500, ok: true, tools: [{ name: "disabled" }] },
  };

  const snapshot = await collectDoctorSnapshot(fakeStore(accounts, capabilities), null);
  assert.deepEqual(snapshot.upstream, {
    checked: true, connected: true, timedOut: false, status: 401, initializeOk: false, error: "unauthorized",
  });
  assert.deepEqual(snapshot.tools, { checked: true, toolsListOk: false, toolCount: 0, error: "inventory rejected" });
});

test("doctor leaves stale-only upstream and tool evidence unchecked", async () => {
  const stale = Date.now() - 6 * 60_000;
  const accounts = [account("enabled-stale", true, stale, true, 200)];
  const capabilities = { "enabled-stale": { capturedAt: stale, ok: true, tools: [{ name: "stale" }] } };
  const snapshot = await collectDoctorSnapshot(fakeStore(accounts, capabilities), null);
  assert.deepEqual(snapshot.upstream, { checked: false });
  assert.deepEqual(snapshot.tools, { checked: false });
});

test("doctor skips upstream probes and stale tool inventories when no upstream is configured", async () => {
  const now = Date.now();
  const accounts = [account("legacy-account", true, now, true, 200)];
  const capabilities = { "legacy-account": { capturedAt: now, ok: false, error: "legacy tools/list rejected", tools: [] } };
  const store = fakeStore(accounts, capabilities);
  store.load = async () => {
    const state = await fakeStore(accounts, capabilities).load();
    state.config.upstreamUrl = "";
    return state;
  };
  let probes = 0;
  const pool = { probeAccount: async () => { probes += 1; } };
  const snapshot = await collectDoctorSnapshot(store, pool, { live: true });
  assert.equal(probes, 0, "no upstream probe is launched without a configured target");
  assert.deepEqual(snapshot.upstream, { checked: false });
  assert.deepEqual(snapshot.tools, { checked: false });
});
