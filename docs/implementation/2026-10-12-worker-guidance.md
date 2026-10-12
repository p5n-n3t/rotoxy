# Admin worker guidance action

## Implemented contract

Added `POST /admin/api/v1/supervisor/:projectId/workers/:workerId/guidance` with JSON `{ requestId, message, expectedPromptCount, expectedQuestionId? }`. `workerId` is the registered session ID. The existing admin cookie and `x-csrf-token` checks are required. Project/session/account binding comes only from the private supervisor runtime config; callers cannot select an account or session in the body. The response is bounded metadata `{ requestId, state, reason?, requestedModel?, reportedModel? }`; an `accepted` receipt means the provider accepted the chat message, not that a task completed or a question was approved.

Before sending, runtime checks current account eligibility under the existing explicit quota-acknowledgment policy, evaluates the exact `lightsprint_api` POST against configured tool policy, and requests fresh session status using the existing account-pinned `LightSprintJobsAdapter`. It requires the configured account identity, `isOwner === true`, `canSendMessage === true`, idle status, and exact `expectedPromptCount` and session ID; optional question IDs must match the status observation. Any nonempty `parkedQuestion` is rejected as `native_question_answer_unsupported`. No approval or answer endpoint is fabricated. The only mutation is the documented `/api/agent-sessions/:id/chat` adapter call with `{ message, clientMessageId }`.

## Delivery guarantees

`WorkerGuidanceLedger` writes to the private Token2OAuth config directory using mode 0700/0600 and file/directory fsync and atomic rename, serialized through `StateStore.update`'s cross-process state lock. A record is reserved before `sendMessage`; its identity is project + session + request ID. It stores a SHA-256 payload digest, model attribution, timestamps and sanitized outcome only, never the message. A new request ID cannot bypass an unresolved action on the same worker or reuse a prompt count already consumed by an accepted action. Concurrent duplicates send once; exact completed retries return the recorded receipt; a reused request ID with a different digest is rejected. A `reserved` record after process interruption returns `ambiguous/needs_reconciliation`, and is never replayed automatically. The bounded ledger rejects new work after 10,000 actions rather than pruning uncertain history.

Thrown/ambiguous provider outcomes remain ambiguous. Policy denial returns `policy_paid_block` without reserving or sending. Native quota admission is unchanged: depleted/unauthorized accounts are ineligible, and unknown quota follows the runtime's explicit private-config acknowledgement. No model spend, quota, or approval is inferred.

## Verification and remaining boundary

Focused integration tests cover admin/CSRF enforcement, bounded delegation, fresh ownership/prompt/session checks, parked-question rejection, policy denial, stable request IDs, concurrent duplicate reservation, restart ambiguity, and no repeated provider send. The integration root executed one real `gpt-6-luna` follow-up through an isolated HTTP admin server connected to the actual LightSprint adapter: missing CSRF was denied, strict policy sent nothing, a narrowly permitted request was accepted, its duplicate returned the receipt, and the final assistant marker was retrieved. Exactly one provider send occurred. This proves the action path, not a native approval operation or a logged-in public dashboard session.

The UI now offers this action for observed idle workers. Production strict read-only tool policy remains in force: the route exists, but policy can deny paid guidance. This work does not enable automatic cloud guidance. See the [integrated checkpoint](2026-10-12-actionable-supervision.md) for final test totals and limitations.
