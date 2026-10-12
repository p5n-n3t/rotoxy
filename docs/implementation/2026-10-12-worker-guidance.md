# Admin worker guidance action

## Implemented contract

Added `POST /admin/api/v1/supervisor/:projectId/workers/:workerId/guidance` with JSON `{ requestId, message, expectedPromptCount, expectedQuestionId? }`. `workerId` is the registered session ID. The existing admin cookie and `x-csrf-token` checks are required. Project/session/account binding comes only from the private supervisor runtime config; callers cannot select an account or session in the body. The response is bounded metadata `{ requestId, state, reason?, requestedModel?, reportedModel? }`; an `accepted` receipt means the provider accepted the chat message, not that a task completed or a question was approved.

Before sending, runtime checks current account eligibility under the existing explicit quota-acknowledgment policy, evaluates the exact `lightsprint_api` POST against configured tool policy, and requests fresh session status using the existing account-pinned `LightSprintJobsAdapter`. It requires the configured account identity, `isOwner === true`, `canSendMessage === true`, idle status, and exact `expectedPromptCount`; optional question IDs must match the status observation. Any nonempty `parkedQuestion` is rejected as `native_question_answer_unsupported`. No approval or answer endpoint is fabricated. The only mutation is the documented `/api/agent-sessions/:id/chat` adapter call with `{ message, clientMessageId }`.

## Delivery guarantees

`WorkerGuidanceLedger` writes to the private Token2OAuth config directory using mode 0700/0600 and atomic rename, serialized through `StateStore.update`'s cross-process state lock. A record is reserved before `sendMessage`; its identity is project + session + request ID. It stores a SHA-256 payload digest, model attribution, timestamps and sanitized outcome only, never the message. Concurrent duplicates send once; exact completed retries return the recorded receipt; a reused request ID with a different digest is rejected. A `reserved` record after process interruption returns `ambiguous/needs_reconciliation`, and is never replayed automatically. The bounded ledger rejects new work after 10,000 actions rather than pruning uncertain history.

Thrown/ambiguous provider outcomes remain ambiguous. Policy denial returns `policy_paid_block` without reserving or sending. Native quota admission is unchanged: depleted/unauthorized accounts are ineligible, and unknown quota follows the runtime's explicit private-config acknowledgement. No model spend, quota, or approval is inferred.

## Verification and remaining boundary

Tests set temporary `HOME` and `TOKEN2OAUTH_CONFIG_DIR` before constructing `StateStore`. `npm run build` passed; the focused worker-guidance, supervisor API, and Python IPC runtime tests passed 12/12, and the full `npm test` suite passed 330/330. They cover admin/CSRF enforcement, bounded input delegation, fresh ownership/prompt checks, parked question rejection, policy denial, wrong bindings, stable request IDs, concurrent duplicate reservation, restart ambiguity, and no repeated provider send. The official execution surface used is the existing documented account-pinned adapter in `src/providers/lightsprint-jobs.ts` (`GET .../status`; `POST .../chat` with `message` and `clientMessageId`). No official native answer/approval semantics were found in that surface, so parked questions remain unsupported.

No UI was added. Root may add a UI control that submits the exact request contract with current `promptCount`/question ID and displays accepted/rejected/ambiguous distinctly; it must preserve admin session + CSRF. Do not auto-retry ambiguous receipts or describe `accepted` as approval/completion.
