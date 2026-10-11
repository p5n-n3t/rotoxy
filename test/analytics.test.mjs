import test from "node:test";
import assert from "node:assert/strict";
import { projectAnalytics } from "../dist/analytics.js";

const t0 = Date.parse("2026-10-12T10:00:00.000Z");
const gateway = (overrides = {}) => ({ scope: "gateway", kind: "request", at: t0, retries: 0, outcome: "success", ...overrides });

test("projects request counts, valid duration percentiles, routing and sparse UTC activity", () => {
  const result = projectAnalytics({ gatewayEvents: [
    gateway({ accountId: "acct-a", pool: "pool-1", latencyMs: 4 }),
    gateway({ at: t0 + 1_000, accountId: "acct-a", pool: "pool-1", outcome: "error", latencyMs: 10 }),
    gateway({ at: t0 + 2_000, accountId: "acct-b", outcome: "success", latencyMs: -1 }),
    gateway({ kind: "attempt", at: t0 + 3_000, outcome: "error", latencyMs: 1 }),
  ] }, { bucketMs: 60_000 });

  assert.equal(result.requests.count.value, 3);
  assert.equal(result.requests.successCount.value, 2);
  assert.equal(result.requests.errorCount.value, 1);
  assert.equal(result.requests.durationP50.value, 4);
  assert.equal(result.requests.durationP95.value, 10);
  assert.equal(result.requests.durationP99.value, 10);
  assert.deepEqual(result.routingDistribution.value, { "pool-1": 2, "(routing pool unreported)": 1 });
  assert.deepEqual(result.timeBuckets.values, [{ start: t0, end: t0 + 60_000, requestCount: 3, successCount: 2, errorCount: 1 }]);
  assert.deepEqual(result.activityHeatmap.values, [{ weekday: 1, hour: 10, count: 3 }]);
});

test("applies available time/account filters and marks missing request dimensions unavailable", () => {
  const events = [gateway({ at: t0, accountId: "acct-a", latencyMs: 5 }), gateway({ at: t0 + 10_000, accountId: "acct-b", latencyMs: 7 })];
  const filtered = projectAnalytics({ gatewayEvents: events }, { filters: { from: t0 + 1, accountId: "acct-b" } });
  assert.equal(filtered.requests.count.value, 1);
  assert.equal(filtered.requests.durationP50.value, 7);

  const unsupported = projectAnalytics({ gatewayEvents: events }, { filters: { provider: "provider-a", model: "model-a", client: "client-a", jobId: "job-a" } });
  assert.equal(unsupported.requests.count.availability, "unavailable");
  assert.deepEqual(unsupported.filters.unsupportedForRequests, ["provider", "model", "client", "jobId"]);
  assert.equal(unsupported.requests.count.value, null);
  assert.match(unsupported.requests.count.reason, /no provider, model, client, jobId association/);
});

test("uses actual supervisor delivery outcomes and leaves unsupported worker intervals unavailable", () => {
  const input = {
    jobs: [{ id: "job-a", status: "running", provider: "Lightsprint", account: "acct-a" }],
    tasks: [{ id: "job-a:task-a", status: "running", accountId: "acct-a", reportedModel: "model-a" }],
    supervisorEvents: [
      { id: 1, kind: "attempt_reserved", at: t0 / 1_000, task: "job-a:task-a", attempt: "attempt-a", data: { account: "acct-a", generation: 1 } },
      { id: 2, kind: "attempt_complete", at: t0 / 1_000 + 6, task: "job-a:task-a", attempt: "attempt-a", data: { state: "complete" } },
      { id: 3, kind: "delivery_accepted", at: t0 / 1_000 + 7, data: { state: "accepted" } },
    ],
  };
  const result = projectAnalytics(input);
  assert.equal(result.supervisorWake.attempts.value, 1);
  assert.deepEqual(result.supervisorWake.outcomes.value, { delivery_accepted: 1 });
  assert.equal(result.jobIntervals.availability, "unavailable");
  assert.match(result.jobIntervals.reason, /do not report paired worker start\/end timestamps/);
  assert.equal(result.supervisorRecords.jobs.value, 1);
  assert.equal(result.supervisorRecords.tasks.value, 1);
});

test("keeps reported usage separated by metric/source/unit and applies account/model filters", () => {
  const providerUsage = [
    { scope: "provider", metric: "input_tokens", source: "provider-reported", observedAt: t0, recordedAt: t0, accountId: "acct-a", model: "model-a", availability: "reported", value: 12, unit: "tokens" },
    { scope: "provider", metric: "input_tokens", source: "provider-reported", observedAt: t0, recordedAt: t0, accountId: "acct-b", model: "model-b", availability: "reported", value: 30, unit: "tokens" },
    { scope: "provider", metric: "credits_used", source: "provider-reported", observedAt: t0, recordedAt: t0, accountId: "acct-a", model: "model-a", availability: "unavailable", value: null, unit: "credits", reason: "not measured" },
  ];
  const result = projectAnalytics({ providerUsage }, { filters: { accountId: "acct-a", model: "model-a" } });
  assert.deepEqual(result.providerUsage.value.map(({ metric, reportedValue, unit, unavailableRecords }) => ({ metric, reportedValue, unit, unavailableRecords })), [
    { metric: "credits_used", reportedValue: null, unit: "credits", unavailableRecords: 1 },
    { metric: "input_tokens", reportedValue: 12, unit: "tokens", unavailableRecords: 0 },
  ]);
  const providerFiltered = projectAnalytics({ providerUsage }, { filters: { provider: "provider-reported" } });
  assert.equal(providerFiltered.providerUsage.availability, "unavailable");
});

test("does not convert update timestamps to durations or invent missing metrics; caps retained input", () => {
  const result = projectAnalytics({
    gatewayEvents: [gateway({ latencyMs: undefined }), gateway({ at: t0 + 1, latencyMs: Number.NaN })],
    jobs: [{ id: "job-a", status: "running", updatedAt: t0 }],
    supervisorEvents: [{ kind: "delivery_failed", at: t0 / 1_000 }],
  }, { filters: { from: t0 - 1, to: t0 + 2 }, maxRecords: 1 });
  assert.equal(result.window.recordsCapped, true);
  assert.equal(result.requests.count.value, 1);
  assert.equal(result.requests.durationP50.availability, "unavailable");
  assert.equal(result.jobIntervals.value, null);
  assert.equal(result.supervisorRecords.jobs.availability, "reported");
  assert.equal(result.supervisorWake.attempts.value, 1);
  assert.equal(JSON.stringify(result).includes("instructions"), false);
});

test("returns unavailable for absent supervisor evidence and bounds bucket count", () => {
  const result = projectAnalytics({ gatewayEvents: [gateway({ at: t0 })] }, { bucketMs: 1, filters: { from: t0, to: t0 + 86_400_000 } });
  assert.equal(result.timeBuckets.bucketMs, 43_201);
  assert.equal(result.supervisorWake.attempts.availability, "unavailable");
  assert.equal(result.jobIntervals.availability, "unavailable");
});

test("distinguishes an unsupplied source from an observed empty source", () => {
  const missing = projectAnalytics({});
  assert.equal(missing.requests.count.value, null);
  assert.equal(missing.requests.count.availability, "unavailable");
  assert.equal(missing.providerUsage.value, null);
  assert.equal(missing.supervisorRecords.jobs.value, null);
  const empty = projectAnalytics({ gatewayEvents: [], providerUsage: [], jobs: [], tasks: [], supervisorEvents: [] });
  assert.equal(empty.requests.count.value, 0);
  assert.equal(empty.timeBuckets.availability, "reported");
  assert.deepEqual(empty.providerUsage.value, []);
  assert.equal(empty.supervisorRecords.jobs.value, 0);
  assert.equal(empty.supervisorRecords.tasks.value, 0);
});
