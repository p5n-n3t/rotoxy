# Monitor observation diagnostics checkpoint

The workforce monitor still performs one read-only remote status check per unique account/session and fans that observation out to its registered owners. Failures now produce only fixed category codes (`http_status`, `transport_error`, `timeout`, `malformed_protocol`, `account_missing`, `account_unavailable`, `session_missing`, `session_mismatch`, `owner_mismatch`, `observation_error`); HTTP responses may include only the numeric 100–599 status. Remote body text, exception messages, tokens, and prompts are never serialized.

Each `--once` or daemon cycle retains the existing `statusErrors` count and emits deduplicated `observationDiagnostics`, capped at 20 records, plus `observationDiagnosticsOmitted`. Identifiers are restricted to the monitor's safe character set. Read-only routes, owner checks, guidance, and recovery behavior are unchanged.

Focused verification passed: `npm run build`; `node --check scripts/monitor-workforce.mjs`; `node --test test/worker-observation.test.mjs test/release-contract.test.mjs` (11 passed); and `git diff --check`. The tests import the built `dist/worker-observation.js`, and the release contract confirms that module is in the npm tarball inventory.

No live monitor cycle was run, so this does not validate live account access or current upstream responses. It does not change resumption policy.
