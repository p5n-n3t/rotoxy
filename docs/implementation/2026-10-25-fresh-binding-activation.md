# Fresh LightSprint binding activation — 2026-10-25

## Purpose

Activate the verified source path that permits a **future** fresh LightSprint
worker creation only after an account-specific workspace and stack have been
read from that account's documented contract and stack catalog.

## Release

- Source commits: `785d471` (owner-only binding manager) and `f1da89e`
  (fresh-readiness inventory projection).
- Both commits are on `origin/main`.
- The gateway is running immutable release directory `f1da89e`.
- The workforce monitor and Oracle pool remain on the immediately preceding
  compatible staged release; no Tailscale route was changed.
- A private, owner-only backup of the prior service drop-in, gateway state,
  supervisor policy, credit snapshots, workspace database, Snooze databases,
  and monitor state was made before the service swap. The backup location is
  intentionally not committed.

## Verification

- TypeScript build passed.
- Targeted supervisor and binding suites: 19 passed.
- Isolated package audit and clean-install smoke passed before activation.
- Gateway local health endpoint returned HTTP 200 after activation.
- OAuth metadata exposes the canonical root ROTOXY issuer and its authorize,
  token, and dynamic-registration endpoints.
- A bounded read-only LightSprint contract and stack-catalog check succeeded
  for `maryjoebake` and `jqthefoo` independently.
- The authenticated worker inventory reports both as `fresh_ready` and
  `automaticProvisioning: true`; their workspace/stack/provider tuples are
  present only in protected runtime configuration and authenticated output.

## Deliberate limits

This did **not** submit a task, create a remote agent, send a provider message,
change an account credential, alter a quota snapshot, or measure a worker-slot
limit. A verified catalog tuple establishes the relevant account/workspace/stack
relationship only. It does not prove model pinning, reasoning selection,
provider quota, cost, concurrency entitlement, task completion, or artifact
retrieval.

## Next execution gate

Use one bounded, explicitly budgeted fresh job on one `fresh_ready` account.
Require a returned session identity, retrieve its status and result, and verify
its durable Snooze observation before adding more account bindings or increasing
parallelism. A missing launch response remains ambiguous and must not be
replayed.
