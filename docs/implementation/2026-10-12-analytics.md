# Analytics projection checkpoint (T2O-W2-ANALYTICS)

Branch: `codex/t2o-w2-analytics-20261012`, based on `origin/main` at `00e6e8f91564b7e4706b8dab3b36221c8bdfb4a2`.

## Owned implementation

`src/analytics.ts` exports pure `projectAnalytics(input, options)`. It consumes the repository's `GatewayEvent`, provider usage records, supervisor snapshot jobs/tasks, and project-scoped supervisor event rows. It emits request/success/error counts, nearest-rank p50/p95/p99 latency from valid `latencyMs` samples, pool routing counts, sparse UTC time buckets and weekday/hour heatmap cells, usage groups kept separate by source/metric/unit, supervisor job/task record counts, and wake delivery attempt/outcome counts only from explicit `delivery_accepted`, `delivery_inbox`, `delivery_failed`, or `delivery_queued` events. Worker intervals are explicitly unavailable today: job `updatedAt`, `attempt_reserved`, and terminal attempt events do not provide paired worker start/end timestamps.

All timestamps in the output are epoch milliseconds; gateway and usage records already use milliseconds, supervisor EventFeed numeric timestamps are Unix seconds and are converted. Counts have explicit units and source labels. Retention is capped (10,000 records per source by default, hard ceiling 100,000); time buckets are capped at 2,000. Omitted sources produce unavailable metrics; supplied empty arrays represent an observed empty input. Output excludes prompt/body/message/raw payload values. Unsupported request filters produce unavailable metrics with a reason, rather than false zeroes.

## Current evidence limits and integration patch for the API owner

Gateway events currently expose `accountId` and `pool`, but no provider, model, OAuth client, or job association. Thus time/account filters are usable for gateway request metrics; provider/model/client/job request filters return `availability: "unavailable"`. Provider usage has account/model dimensions, supervisor jobs have provider/account/job ID, and supervisor tasks have account/model plus the current runtime's `assignmentId:taskId` ID form. Client association is absent from these snapshots. No `updatedAt` value is promoted to a job duration.

To wire in an API-owned file, call `projectAnalytics` with bounded `telemetry.recent({limit: 2000})`, `telemetry.latestProviderUsage()`, `snapshot.jobs`, `snapshot.tasks`, and raw project-scoped job events from the supervisor runtime's existing `GET /admin/api/v1/events` read; preserve `kind`, `at`, `task`, `attempt`, and safe `data` instead of mapping them into display-only `SupervisorEvent.message`. The separate guidance `readSupervision(...).events` inbox is a different event family and does not supply job-event lifecycle or delivery outcomes. The current dashboard's display mapping discards job event fields. Do not expose the projection without the same project authorization as the source feed.

For request-level provider/model/client/job filtering, extend actual request instrumentation in `src/telemetry.ts` and its existing record sites in `src/proxy.ts` / `src/pool.ts` to attach those verified associations to `GatewayEvent`; do not infer them from pool names or display labels. Worker concurrency requires new source evidence: paired execution start/end events associated to the same stable attempt and worker ID. Existing delivery outcome events can count explicit delivery calls/outcomes but do not prove that a human read or acted on a notification.

## Checks and status

Deterministic cases are in `test/analytics.test.mjs` and use actual telemetry, SupervisorJob/SupervisorTask, and project event-feed-shaped records. `npm ci` completed from the lockfile with no reported vulnerabilities; `npm run build` passed; the focused analytics test passed 7 cases; `git diff --check` passed. The first build attempt occurred before dependency installation and returned `tsc: not found`; the successful rerun resolved it. Commit SHA is provided in the task report.
