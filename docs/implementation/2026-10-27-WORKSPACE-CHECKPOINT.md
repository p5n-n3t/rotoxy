# ROTOXY Fleet workspace checkpoint — 2026-10-27

This checkpoint supersedes earlier workspace notes only where it explicitly
describes newer commits. Historical handoffs remain evidence; do not delete or
rewrite them during normal delivery work.

## Objective

Make one ROTOXY Fleet available to authorized MCP clients from different local
folders while keeping projects as job context, and make a deliberately shared
job observable by other authorized Fleet clients without duplicating provider
work or moving its account/session ownership.

## Current implementation

- `671c2c2` added opt-in durable shared execution handles.
- `c6b7544` routes `shareMode` on `workspace_dispatch` and `shareHandle` on
  `workspace_sync` through the authenticated MCP proxy.
- `6c1c96d` removes a reconciliation starvation case: when several newly
  published bindings have an identical millisecond timestamp, the newest SQLite
  row receives its first observation before lexical backlog order can delay it.
- `03a24e7` updates the portable `rotoxy_guide` and operational documents with
  the current shared-execution contract.

`workspace_dispatch` remains private unless the owner sends
`shareMode: "fleet"`. A Fleet share returns an opaque `shareHandle`. An already
authorized Fleet collaborator may call `workspace_sync` with the same
`projectId` and handle to inspect bounded state/results. It cannot resubmit the
job, change private instructions, transfer provider account/session affinity,
send native provider messages, or approve the owner's artifact. Membership is
checked before provider reads and again before result projection.

## Verification evidence

- Local focused Node 22 background-reconciliation test passed in 25.6 seconds
  after the scheduler repair.
- Python ledger suite: 14 tests passed.
- TypeScript build passed.
- GitHub Actions run
  [`40561795697`](https://github.com/p5n-n3t/rotoxy/actions/runs/40561795697)
  passed on Node 22 and Node 24, including the durable Python supervisor check.
- The local gateway release `03a24e7` is active. `/healthz` reports the gateway
  healthy with 24 configured and 20 selectable accounts. These values are
  inventory/routing state, **not** proof of provider worker slots, exact quota,
  task launch, or completion.

## Runtime and rollback

The gateway service points at the immutable release directory
`~/.local/share/rotoxy-releases/03a24e7`. The worker monitor, Oracle pool, and
Funnel units are active. The latest release-override backups are under
`~/.local/state/rotoxy/backups/workspace-reconciliation-20261027T192500Z-6c1c96d/`
and `~/.local/state/rotoxy/backups/onboarding-guide-20261027T193000Z-03a24e7/`.
Restore the prior drop-in from the relevant backup, run `systemctl --user
daemon-reload`, then restart only `rotoxy-gateway.service`; do not alter
provider credentials or replay remote work as part of rollback.

## Open work and boundaries

1. Browser-level dashboard acceptance requires an authenticated admin tab; no
   browser was available at this checkpoint, so visual acceptance is not
   claimed.
2. Verified multi-account LightSprint launch/concurrency remains pending a
   separately approved bounded, paid execution test.
3. Oracle, Bedrock/local CLI and LightSprint currently retain distinct dispatch
   semantics. They are not yet a single heterogeneous scheduler; do not claim
   that a shared workspace handle creates that integration.
4. The persistent backend polls and stores events. Desktop notifications do not
   wake a dormant chat, and a ledger message is not native provider delivery.
