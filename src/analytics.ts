import type { GatewayEvent, ProviderUsageRecord } from "./telemetry.js";
import type { SupervisorJob, SupervisorTask } from "./supervisor-ui.js";

/** A project-scoped event from the supervisor EventFeed (timestamps are Unix seconds). */
export interface SupervisorAnalyticsEvent {
  id?: number | string;
  kind?: string;
  at?: number | string;
  task?: string;
  attempt?: string;
  worker?: string;
  data?: Readonly<Record<string, unknown>>;
}

export interface AnalyticsInput {
  gatewayEvents?: readonly GatewayEvent[];
  providerUsage?: readonly ProviderUsageRecord[];
  jobs?: readonly SupervisorJob[];
  tasks?: readonly SupervisorTask[];
  supervisorEvents?: readonly SupervisorAnalyticsEvent[];
}

export interface AnalyticsFilters {
  /** Milliseconds since Unix epoch, inclusive. */
  from?: number;
  /** Milliseconds since Unix epoch, inclusive. */
  to?: number;
  provider?: string;
  accountId?: string;
  model?: string;
  client?: string;
  jobId?: string;
}

export interface AnalyticsOptions {
  filters?: AnalyticsFilters;
  bucketMs?: number;
  maxRecords?: number;
}

export interface AvailableMetric<T> {
  availability: "reported" | "unavailable";
  value: T | null;
  reason?: string;
  source: string;
  unit: string;
}

export interface AnalyticsBucket {
  start: number;
  end: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
}

export interface AnalyticsProjection {
  source: "token2oauth-telemetry-and-supervisor";
  window: { from: number | null; to: number | null; gatewayEventsConsidered: number; gatewaySourceProvided: boolean; recordsCapped: boolean };
  filters: { requested: AnalyticsFilters; unsupportedForRequests: string[] };
  requests: {
    count: AvailableMetric<number>;
    successCount: AvailableMetric<number>;
    errorCount: AvailableMetric<number>;
    durationP50: AvailableMetric<number>;
    durationP95: AvailableMetric<number>;
    durationP99: AvailableMetric<number>;
  };
  routingDistribution: AvailableMetric<Record<string, number>>;
  providerUsage: AvailableMetric<Array<{ metric: string; source: string; accountId?: string; model?: string; unit?: string; reportedValue: number | null; records: number; unavailableRecords: number }>>;
  timeBuckets: { availability: "reported" | "unavailable"; bucketMs: number; unit: "requests"; values: AnalyticsBucket[]; reason?: string };
  activityHeatmap: { availability: "reported" | "unavailable"; timezone: "UTC"; unit: "requests"; values: Array<{ weekday: number; hour: number; count: number }>; reason?: string };
  jobIntervals: AvailableMetric<{ intervals: Array<{ attemptId: string; workerId: string; start: number; end: number }>; maxConcurrentWorkers: number }>;
  supervisorWake: {
    attempts: AvailableMetric<number>;
    outcomes: AvailableMetric<Record<string, number>>;
  };
  supervisorRecords: {
    jobs: AvailableMetric<number>;
    tasks: AvailableMetric<number>;
  };
  dimensions: {
    provider: "job records only; not attached to gateway requests";
    account: "gateway accountId, provider-usage accountId, job/task account";
    model: "provider-usage and task records only; not attached to gateway requests";
    client: "unavailable in current gateway/job snapshot";
    job: "supervisor job records only; not attached to gateway requests";
  };
}

const DEFAULT_MAX_RECORDS = 10_000;
const HARD_MAX_RECORDS = 100_000;
const MAX_BUCKETS = 2_000;
const SUCCESS = "success";

function timestamp(value: number | string | undefined, numericSeconds = false): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return numericSeconds && value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function inWindow(at: number | undefined, filters: AnalyticsFilters): boolean {
  if (at === undefined) return filters.from === undefined && filters.to === undefined;
  return (filters.from === undefined || at >= filters.from) && (filters.to === undefined || at <= filters.to);
}

function validDimension(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function metric<T>(value: T, source: string, unit: string): AvailableMetric<T> {
  return { availability: "reported", value, source, unit };
}

function unavailable<T>(reason: string, source: string, unit: string): AvailableMetric<T> {
  return { availability: "unavailable", value: null, reason, source, unit };
}

function cap<T>(items: readonly T[], max: number): { items: T[]; capped: boolean } {
  if (items.length <= max) return { items: [...items], capped: false };
  return { items: items.slice(-max), capped: true };
}

function unsupportedRequestFilters(filters: AnalyticsFilters): string[] {
  return (["provider", "model", "client", "jobId"] as const).filter((key) => filters[key] !== undefined);
}

/** Pure, bounded projection. It never inspects prompt/body/message fields. */
export function projectAnalytics(input: AnalyticsInput, options: AnalyticsOptions = {}): AnalyticsProjection {
  const filters = options.filters ?? {};
  if (filters.from !== undefined && !Number.isFinite(filters.from) || filters.to !== undefined && !Number.isFinite(filters.to) ||
      filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) throw new RangeError("time filters must be finite and ordered epoch milliseconds");
  if (options.maxRecords !== undefined && !Number.isFinite(options.maxRecords)) throw new RangeError("maxRecords must be finite");
  const maxRecords = Math.max(1, Math.min(HARD_MAX_RECORDS, Math.floor(options.maxRecords ?? DEFAULT_MAX_RECORDS)));
  const requestedBucketMs = options.bucketMs ?? 60_000;
  if (!Number.isSafeInteger(requestedBucketMs) || requestedBucketMs < 1) throw new RangeError("bucketMs must be a positive safe integer");

  const boundedGateway = cap(input.gatewayEvents ?? [], maxRecords);
  const boundedUsage = cap(input.providerUsage ?? [], maxRecords);
  const boundedJobs = cap(input.jobs ?? [], maxRecords);
  const boundedTasks = cap(input.tasks ?? [], maxRecords);
  const boundedSupervisor = cap(input.supervisorEvents ?? [], maxRecords);
  const capped = [boundedGateway, boundedUsage, boundedJobs, boundedTasks, boundedSupervisor].some((set) => set.capped);

  const requests = boundedGateway.items.filter((event) => event.kind === "request" &&
    inWindow(timestamp(event.at), filters) && (filters.accountId === undefined || event.accountId === filters.accountId));
  const unsupported = unsupportedRequestFilters(filters);
  const filterReason = unsupported.length ? `Gateway requests have no ${unsupported.join(", ")} association in the current telemetry schema.` : undefined;
  const requestCount = requests.length;
  const successes = requests.filter((event) => event.outcome === SUCCESS).length;
  const errors = requests.length - successes;
  const durations = requests.map((event) => event.latencyMs).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const requestMetric = (value: number, unit: string) => filterReason ? unavailable<number>(filterReason, "gateway request events", unit)
    : input.gatewayEvents === undefined ? unavailable<number>("Gateway event source was not supplied.", "gateway request events", unit)
      : metric(value, "gateway request events", unit);
  const latencyMetric = (p: number) => filterReason
    ? unavailable<number>(filterReason, "gateway request latencyMs", "milliseconds")
    : input.gatewayEvents === undefined ? unavailable<number>("Gateway event source was not supplied.", "gateway request latencyMs", "milliseconds")
    : durations.length ? metric(percentile(durations, p)!, "gateway request latencyMs; nearest-rank percentile over valid samples", "milliseconds")
      : unavailable<number>("No valid latency samples were reported.", "gateway request latencyMs", "milliseconds");

  const pools: Record<string, number> = {};
  let unreportedPool = 0;
  for (const event of requests) {
    const pool = validDimension(event.pool);
    if (pool) pools[pool] = (pools[pool] ?? 0) + 1;
    else unreportedPool += 1;
  }
  if (unreportedPool) pools["(routing pool unreported)"] = unreportedPool;

  const times = requests.map((event) => timestamp(event.at)).filter((value): value is number => value !== undefined);
  const minimumTime = times.reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
  const maximumTime = times.reduce((maximum, value) => Math.max(maximum, value), Number.NEGATIVE_INFINITY);
  const observedRange = filters.from !== undefined && filters.to !== undefined ? filters.to - filters.from : (times.length ? maximumTime - minimumTime : 0);
  const bucketMs = Math.max(requestedBucketMs, Math.ceil((observedRange + 1) / MAX_BUCKETS));
  const from = times.length ? minimumTime : null;
  const to = times.length ? maximumTime : null;
  const buckets = new Map<number, AnalyticsBucket>();
  const heat = new Map<string, number>();
  for (const event of requests) {
    const at = timestamp(event.at);
    if (at === undefined) continue;
    const start = Math.floor(at / bucketMs) * bucketMs;
    const bucket = buckets.get(start) ?? { start, end: start + bucketMs, requestCount: 0, successCount: 0, errorCount: 0 };
    bucket.requestCount += 1;
    if (event.outcome === SUCCESS) bucket.successCount += 1;
    else bucket.errorCount += 1;
    buckets.set(start, bucket);
    const date = new Date(at);
    const key = `${date.getUTCDay()}:${date.getUTCHours()}`;
    heat.set(key, (heat.get(key) ?? 0) + 1);
  }
  const missingGateway = input.gatewayEvents === undefined ? "Gateway event source was not supplied." : undefined;
  const timeBuckets = filterReason || missingGateway
    ? { availability: "unavailable" as const, bucketMs, unit: "requests" as const, values: [], reason: filterReason ?? missingGateway }
    : { availability: "reported" as const, bucketMs, unit: "requests" as const, values: [...buckets.values()].sort((a, b) => a.start - b.start) };
  const activityHeatmap = filterReason || missingGateway
    ? { availability: "unavailable" as const, timezone: "UTC" as const, unit: "requests" as const, values: [], reason: filterReason ?? missingGateway }
    : { availability: "reported" as const, timezone: "UTC" as const, unit: "requests" as const,
      values: [...heat.entries()].map(([key, count]) => { const [weekday, hour] = key.split(":").map(Number); return { weekday, hour, count }; }).sort((a, b) => a.weekday - b.weekday || a.hour - b.hour) };

  const usageUnsupported = ["provider", "client", "jobId"].filter((key) => filters[key as keyof AnalyticsFilters] !== undefined);
  const usageReason = usageUnsupported.length ? `Provider usage records have no ${usageUnsupported.join(", ")} association.` : undefined;
  const usageGroups = new Map<string, { metric: string; source: string; accountId?: string; model?: string; unit?: string; reportedValue: number; records: number; unavailableRecords: number }>();
  for (const record of boundedUsage.items) {
    if (!inWindow(record.observedAt, filters) || (filters.accountId !== undefined && record.accountId !== filters.accountId) ||
        (filters.model !== undefined && record.model !== filters.model)) continue;
    const key = JSON.stringify([record.metric, record.source, record.accountId, record.model, record.unit]);
    const row = usageGroups.get(key) ?? { metric: record.metric, source: record.source, accountId: record.accountId, model: record.model,
      unit: record.unit, reportedValue: 0, records: 0, unavailableRecords: 0 };
    if (record.availability === "reported") { row.reportedValue += record.value; row.records += 1; }
    else row.unavailableRecords += 1;
    usageGroups.set(key, row);
  }
  type UsageProjection = NonNullable<AnalyticsProjection["providerUsage"]["value"]>;
  const usageRows: UsageProjection = [...usageGroups.values()].map((row) => ({ ...row, reportedValue: row.records ? row.reportedValue : null }))
    .sort((a, b) => a.metric.localeCompare(b.metric) || a.source.localeCompare(b.source));
  const providerUsage = usageReason || input.providerUsage === undefined
    ? unavailable<UsageProjection>(usageReason ?? "Provider usage source was not supplied.", "provider usage records", "reported values grouped by metric and unit")
    : metric(usageRows, "provider usage records; values remain separated by source, metric and unit", "reported values grouped by metric and unit");

  const lifecycleEvents = boundedSupervisor.items.filter((event) => inWindow(timestamp(event.at, typeof event.at === "number"), filters));
  const jobIntervals = unavailable<{ intervals: Array<{ attemptId: string; workerId: string; start: number; end: number }>; maxConcurrentWorkers: number }>(
    "Current job and supervisor feeds do not report paired worker start/end timestamps; updatedAt and attempt reservation are not duration evidence.",
    "supervisor job and event records", "concurrent workers");

  const wakeOutcomes: Record<string, number> = {};
  for (const event of lifecycleEvents) {
    if (["delivery_accepted", "delivery_inbox", "delivery_failed", "delivery_queued"].includes(event.kind ?? "")) {
      wakeOutcomes[event.kind!] = (wakeOutcomes[event.kind!] ?? 0) + 1;
    }
  }
  const wakeCount = Object.values(wakeOutcomes).reduce((sum, count) => sum + count, 0);
  const wakeUnsupported = ["provider", "accountId", "model", "client", "jobId"].filter((key) => filters[key as keyof AnalyticsFilters] !== undefined);
  const wakeReason = wakeUnsupported.length ? `Supervisor delivery events have no ${wakeUnsupported.join(", ")} association.` : undefined;
  const wakeAvailability = wakeReason ? unavailable<number>(wakeReason, "supervisor delivery events", "attempts")
    : wakeCount ? metric(wakeCount, "explicit supervisor delivery_* outcome events", "attempts")
    : unavailable<number>("No explicit supervisor delivery attempt/outcome events were reported.", "supervisor delivery events", "attempts");
  const wakeOutcomeMetric = wakeReason ? unavailable<Record<string, number>>(wakeReason, "supervisor delivery events", "events by outcome")
    : wakeCount ? metric(wakeOutcomes, "explicit supervisor delivery_* outcome events", "events by outcome")
    : unavailable<Record<string, number>>("No explicit supervisor delivery outcomes were reported.", "supervisor delivery events", "events by outcome");

  const jobs = boundedJobs.items.filter((job) =>
    (filters.provider === undefined || job.provider === filters.provider) &&
    (filters.accountId === undefined || job.account === filters.accountId || job.account?.split(", ").includes(filters.accountId)) &&
    (filters.jobId === undefined || job.id === filters.jobId));
  const tasks = boundedTasks.items.filter((task) =>
    (filters.accountId === undefined || task.accountId === filters.accountId) &&
    (filters.model === undefined || task.reportedModel === filters.model) &&
    (filters.jobId === undefined || task.id.startsWith(`${filters.jobId}:`)));
  const recordTimeFilter = filters.from !== undefined || filters.to !== undefined;
  const supervisorJobs = input.jobs === undefined
    ? unavailable<number>("Supervisor job source was not supplied.", "supervisor job snapshot", "jobs")
    : filters.client !== undefined || filters.model !== undefined
    ? unavailable<number>(filters.client !== undefined ? "Client association is absent from supervisor job records." : "Model association is absent from supervisor job records.", "supervisor job snapshot", "jobs")
    : recordTimeFilter && boundedJobs.items.some((job) => job.updatedAt === undefined)
      ? unavailable<number>("Some supervisor jobs have no updatedAt timestamp for the requested time filter.", "supervisor job snapshot", "jobs")
      : metric(recordTimeFilter ? jobs.filter((job) => inWindow(timestamp(job.updatedAt), filters)).length : jobs.length, "supervisor job snapshot", "jobs");
  const supervisorTasks = input.tasks === undefined
    ? unavailable<number>("Supervisor task source was not supplied.", "supervisor task snapshot", "tasks")
    : filters.client !== undefined || filters.provider !== undefined
    ? unavailable<number>(filters.client !== undefined ? "Client association is absent from supervisor task records." : "Provider association is absent from supervisor task records.", "supervisor task snapshot", "tasks")
    : recordTimeFilter && boundedTasks.items.some((task) => task.updatedAt === undefined)
      ? unavailable<number>("Some supervisor tasks have no updatedAt timestamp for the requested time filter.", "supervisor task snapshot", "tasks")
      : metric(recordTimeFilter ? tasks.filter((task) => inWindow(timestamp(task.updatedAt), filters)).length : tasks.length, "supervisor task snapshot", "tasks");

  return {
    source: "token2oauth-telemetry-and-supervisor",
    window: { from, to, gatewayEventsConsidered: boundedGateway.items.length, gatewaySourceProvided: input.gatewayEvents !== undefined, recordsCapped: capped },
    filters: { requested: { ...filters }, unsupportedForRequests: unsupported },
    requests: {
      count: requestMetric(requestCount, "requests"), successCount: requestMetric(successes, "requests"), errorCount: requestMetric(errors, "requests"),
      durationP50: latencyMetric(0.5), durationP95: latencyMetric(0.95), durationP99: latencyMetric(0.99),
    },
    routingDistribution: filterReason || missingGateway ? unavailable(filterReason ?? missingGateway!, "gateway pool", "requests") : metric(pools, "gateway event pool", "requests"),
    providerUsage, timeBuckets, activityHeatmap, jobIntervals,
    supervisorWake: { attempts: wakeAvailability, outcomes: wakeOutcomeMetric },
    supervisorRecords: { jobs: supervisorJobs, tasks: supervisorTasks },
    dimensions: {
      provider: "job records only; not attached to gateway requests",
      account: "gateway accountId, provider-usage accountId, job/task account",
      model: "provider-usage and task records only; not attached to gateway requests",
      client: "unavailable in current gateway/job snapshot",
      job: "supervisor job records only; not attached to gateway requests",
    },
  };
}
