# Controlled batch dispatch approvals

Added an authenticated, CSRF- and same-origin-protected admin router factory for `/admin/dispatch-approvals` (root owns mounting and navigation). The page uses a fixed Python module invocation and a trusted supervisor state directory; the request cannot choose a database path. The Python helper opens the existing `snooze.sqlite3` registry through `create_job_registry`, lists only bounded metadata for queued chat operations and known credit-denied rows, and applies grants by calling `controlled_batches.approve`.

Approvals are scoped to 1–3 exact operations and their exact selected accounts, with 1–3 maximum launches, a 30–600 second TTL, and mandatory unknown-cost acknowledgment. Per-operation binding hashes from the read view are compared again before approval; the existing approval function also revalidates operation/task/assignment state transactionally. The UI explains that this is not a monetary ceiling, does not resume projects, and does not override strict raw-tool policy. No operation prompts, secrets, or dispatch actions are displayed or performed.

Tests use an isolated temporary state directory and injected Python runner. No live external calls were made.
