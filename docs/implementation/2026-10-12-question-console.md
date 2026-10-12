# Provider question console

This UI change accepts only normalized worker questions with `source: "provider"`. It bounds and escapes question text and choices, attributes the question to the rendered account/session row, and keeps requested and observed models distinct. Provider `question` and `review` items can show an explicit reply form only when a current nonnegative `promptCount`, project-mounted supervisor URL, and admin CSRF token are present. Polling never submits a message. Each attempt sends a stable `requestId`, `expectedPromptCount`, and optional `expectedQuestionId` to `POST /admin/api/v1/supervisor/:projectId/workers/:workerId/guidance` with `X-CSRF-Token`; retries after an ambiguous transport result reuse the same ID. UI receipts recognize only `accepted`, `rejected`, or `ambiguous` and never claim provider completion.

Native approval questions are rendered as handoffs with no approval/reply controls. The existing documented session status and chat APIs do not establish a native approval endpoint, so this UI does not invent one. Unsupported kinds, untrusted question sources, absent prompt counts, or missing CSRF/route data remain non-actionable.

## Root integration seam

The published base snapshot currently does not project `question` or `promptCount` onto its worker rows and does not mount the guidance route. Root must add a project- and session-owner-scoped route behind the existing admin session and CSRF middleware. It must validate the current provider question and expected prompt count immediately before forwarding exactly one plain-text message through the existing authorized chat instruction operation; it must preserve strict credit/dispatch policy, return an explicit receipt outcome (`accepted`, `rejected`, or `ambiguous`), and preserve request-ID idempotency. Do not replay an ambiguous request automatically or expose approval actions. Add the trusted, bounded optional question DTO and prompt count to worker projections; the live renderer's question row can be configured from the dashboard's existing mounted route and CSRF metadata.

The client reports backend acceptance only, not that a dormant initiating conversation woke or that a provider completed the requested work. No deployment, provider action, or native approval capability was verified in this change.

## Validation

`npm test` passed (331 tests); the focused supervisor UI suite passes all 24 tests after the final reply receipt assertions. Coverage includes bounded/escaped context, account/model/task attribution, mounted route construction, prompt-count fencing, CSRF payloads, stable retry IDs, accepted/rejected/ambiguous receipts, unsupported native approvals, and responsive form layout. `git diff --check` passed. No `StateStore` is constructed by these UI tests.
