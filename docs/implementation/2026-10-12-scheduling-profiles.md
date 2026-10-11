# Durable scheduling profiles checkpoint

Assignment T2O-W2-SCHEDULER starts from `origin/main` at `00e6e8f` on branch `codex/t2o-w2-scheduler-controls-20261012`. Scope is limited to the Python durable scheduler, Node job-submit validation, focused tests, and this checkpoint.

`job_submit` accepts optional `scheduling`: `economy` limits each job to one active task; `balanced` keeps the historical three-worker preference; `throughput` uses the local scheduler ceiling; `custom` requires `maxConcurrency` from 1–32. Every profile is clamped by the persisted global `max_workers`, legacy per-job `maxWorkers` when present, and the sum of eligible registered accounts' configured `localCapacity`; actual session locks can lower it further. These are local software/operator limits, not verified provider slots. Omitting the field remains valid and defaults durably to `balanced`. Ready DAG tasks accept integer priority -100..100; higher values dispatch first, FIFO breaks ties, and dependencies still gate readiness. Existing durable pause/resume, emergency stop, cancellation, idempotency, affinity, and credit reservations remain intact. `POST /admin/api/v1/control` supports revisioned `{action:"set_concurrency",value:1..32,expectedRevision}`. Ambiguous mutations remain held and are never automatically retried.

## Integration checkpoint

The in-scope Python bridge already forwards admin control `action` and `value` to `JobRegistry.set_control`. Its admin UI should add a CSRF-protected concurrency field and send the revisioned `set_concurrency` body above. In `src/supervisor-runtime.ts`, preserve `scheduling` and per-task `priority` when mapping validated `job_submit` arguments to the existing `POST /v1/assignments` body; do not reinterpret them as provider capacity. Assignment decomposition remains caller-authored.

## Verification

`npm test`: TypeScript build plus 252 Node tests passed. Focused Python job tests: 31 passed; credit-admission tests: 11 passed. Full Python suite: 272 tests ran, with two unrelated installer failures (installer help omits `--state`; invalid `--repo /example` hung past the test's 5-second timeout). No provider calls or infrastructure changes were made.
