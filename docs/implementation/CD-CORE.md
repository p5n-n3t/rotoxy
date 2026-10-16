# Controlled unknown-credit dispatch

> Status: complete within the assigned backend scope. Focused controlled-batch and JobRegistry suites pass; no provider calls were made.

This is an explicit local-admin exception to strict native credit admission. It does not estimate or convert a LightSprint cost, create provider credit, or change subscription state. `JobRegistry.claim_operation` always tries the existing `credit_admission.reserve` first. Only its typed `CreditDenied` result may fall through to an exact grant in the same JobRegistry SQLite write transaction; an exception, timeout, or any other failure does not.

An operator can approve only existing queued `chat_session` operation IDs and the exact selected account IDs they already reference. The CLI re-reads the assignment, task and operation from the owner-only database and hashes canonical immutable assignment/task/operation data. Claim recomputes that binding. A grant allows 1–3 launches during a 30–600 second start window, requires `--ack-unknown-credit-cost`, counts each operation once, and never covers a new operation ID or generation. Approval and consumption events contain IDs only, never prompts. No MCP approval tool exists.

Example (run locally as the database owner):

```sh
python3 -m snooze.controlled_batches --jobs-db /absolute/private/jobs.sqlite3 approve \
  --assignment-id JOB_ID --operation-ids OP_ID \
  --accounts ACCOUNT_ID --max-launches 1 --ttl-seconds 120 \
  --ack-unknown-credit-cost
```

For a previously held operation, the CLI requeues only an exact operation rejected as `CreditAdmissionDenied` before claim (no worker or lease), with its matching blocked task/attempt. It requires that project's durable dispatch control already be paused. Other rejected, claimed, accepted, ambiguous, cancelled, or stale-generation operations are not requeued. Keep the project paused until the operator is ready to permit starts. Approval expiry blocks new claims; it does not cancel an already accepted or ambiguous provider call and is not a cost ceiling. The persisted wall-clock high-water mark denies use after a backward clock jump.

Tests use temporary SQLite files and a typed fake credit denier. No provider API, CLI key, OAuth scope, UI or network integration is introduced here. Root can add a local admin surface later; it must invoke the same trusted approval function and must not expose approval creation to MCP callers.
