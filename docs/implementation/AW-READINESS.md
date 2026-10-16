# Workspace readiness advisory

`workspaceResources(projectId)` now performs one bounded read of the supervisor's local credit-admission status and combines that result with the same configured-account eligibility signals used by job submission. The projection is limited to the requested project's registered sessions and account IDs; provider response fields, error text, and foreign accounts are not returned.

Strict mode reports a fixed blocked state when an account has no verified policy or its known balance is below the verified operation upper bound. Unavailable, malformed, and legacy credit status remain explicitly unknown. A sufficient verified balance is reported only as “Credit check passed; live session readiness not checked”; it does not assert that the provider session is online, selectable, or available. This is advisory display data only and does not alter admission or dispatch.

Verification uses a fake bridge and temporary per-test state paths; no provider requests or live credit operations were made. The runtime/app UI can render the fixed `executionAvailability` strings. This branch adds no UI changes.
