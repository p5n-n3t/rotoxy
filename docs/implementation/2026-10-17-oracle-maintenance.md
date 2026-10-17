# Oracle dispatch maintenance

The pool now owns a durable maintenance fence in its task database. Operators can pause new claims, inspect drain blockers, and explicitly abort maintenance to resume dispatch from **Private workers → Oracle models**. Trusted local CLI commands expose the same lifecycle.

## Guarantees

- Pause and claim use the same SQLite `BEGIN IMMEDIATE` serialization boundary. Work already claimed may finish; queued work stays queued and new submissions may still queue.
- Only the dispatch loop acknowledges a drained pause. Running, ambiguous, dispatching, or unknown task states prevent acknowledgement. Reading status never acknowledges or recovers tasks.
- Epoch and revision checks reject stale actions. Retrying the immediately preceding identical pause is idempotent. No timer silently releases a pause.
- Restart preserves the fence. Missing/corrupt singleton state in an existing fence table fails closed. Legacy schema migration initializes once under the SQLite transaction.
- The admin bridge reads existing state only and uses a controller that cannot create a missing queue or recover claims. Administrative mutations require authenticated session, same-origin, CSRF, current fleet revision, and exact fence epoch.
- Abort uses the original pinned fence revision while still checking the currently displayed fleet revision. It can therefore release a pause after a fleet edit, without applying that edit to the running daemon.
- Request, acknowledgement changes, and release produce sanitized, bounded durable audit events. Idempotent requests and unchanged poll observations do not duplicate those events.

## Scope and limits

Pause does not cancel remote inference, stop SSH, reject new queue submissions, or prove that an ambiguous operation stopped. The four pre-existing ambiguous operations remain untouched. They block drain acknowledgement rather than being deleted or replayed.

**Configuration apply remains preview-only.** A future reload protocol must bind service restart, loaded config revision, daemon identity, health, and explicit release to the same fence epoch. A paused/drained indicator alone is not that protocol. Do not start an older pool binary while a maintenance pause is active: older binaries do not enforce the fence.

## Verification

The cloud implementation was independently integrated and repaired before release. Tests cover claim/pause races across two pool instances, queued preservation, running/ambiguous/unknown blockers, restart persistence, damaged and missing state, concurrent first migration, stale CAS, read-only status, existing-database-only control, authenticated admin actions, and abort after editing the fleet. An isolated backup of the actual queue retained all four ambiguous records and blocked a queued proof task without executing it.

Ora5 independently built the TypeScript and passed all 442 Node tests; its 219 compiled files matched the integration build. The final admin tests and core audit tests passed independently. Final full Python verification on ora5 passed 387 tests; local verification also passed the 32-test core and 10-test admin suites. Package and final deployment evidence is recorded in the private phase ledger; credentials and account identifiers are excluded from this report.

The built-in ChatGPT browser verified 1280×720 and 390×844 views. Maintenance controls appear before model tables, action buttons wrap without truncation, and neither viewport has page-level horizontal overflow. Screenshots stay outside Git.

Two account-pinned LightSprint GPT-6 Luna workers produced the core and admin changes. All three Oracle hosts completed advisory tasks; those suggestions were reviewed rather than adopted automatically. A bounded Claude Opus 4.6 review ended at its client budget threshold without a verdict and is not counted as approval. Its reported list-price cost exceeded the requested threshold, demonstrating that the CLI budget flag is not a strict per-request spending ceiling.
