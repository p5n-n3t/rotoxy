# Production worker access — 2026-11-02

## Observed failure and fix

The installed gateway at commit `1c2c7e99` returned an authorized Fleet but empty
legacy accounts/workers, without inference-resource discovery. Source changes had
not been activated. This was a deployment gap, not a request for a new per-project
provider workspace.

Activated immutable gateway release `03f9986062f5a01df11b39015dc1cd4ed33e9fef`
after CI run 41431559610 passed Node 22, Node 24 and oracle-api checks, and the new
source mixed-provider canary completed all three tasks. Dependency lock matches
the former installation. CLI links were updated to the same release and their
executable permissions corrected. Gateway health is healthy; existing OAuth
access still works. Funnel configuration and the separate monitor were unchanged.

The production MCP connection now discovers eight enabled/authorized/healthy
Cloudflare inference resources and an Oracle inference resource. Oracle capacity
varies with fresh host observations; discovery is not a reservation.

## Execution evidence

- Source mixed job `rx-mixed-20261102-c`: Oracle and Cloudflare independent tasks
  plus Oracle dependency join all completed with exact markers. Request intervals
  overlapped for 1.590 seconds. These intervals include HTTP/local validation and
  are not provider GPU timing. Dependency ordering does not inject prior outputs.
- Cloudflare chat-message-format canary: exact marker, 29 reported tokens.
  Published token rates imply an estimate, not a provider-reported bill.
- Live production MCP job `rx-desktop-access-20261102-a`: accepted and completed;
  retrieved `ROTOXY_DESKTOP_ACCESS_OK`, provider-reported model
  `oracle/qwen3.5:2b`, host ora5, 81 reported tokens, finish_reason stop.
- The first production submit was rejected at eligibility validation. Read-only
  database inspection confirmed zero assignments before same-key resubmission.
  No ambiguous mutation was replayed. Never infer guaranteed capacity from the
  immediately previous discovery response.

Detailed canary reports and the two conservative $0.001 verification reservations
are owner-private under `~/.local/state/rotoxy/verification/`. No purchases/top-ups.
Nebius was added to the existing encrypted generic provider store. Its custom
endpoint authenticated and listed 30 models; no models were automatically selected
and no Nebius inference was executed. The operator-reported $50 is not a verified
balance; this onboarding does not prove durable Nebius job dispatch.

## Client instructions

Use `workspace_projects`, then `job_workers` with the returned opaque projectId.
Use `inferenceResources` for eligible Oracle/Cloudflare resources and exact models.
Read `rotoxy_guide` topic dispatch, submit bounded jobs through `job_submit`, and
retrieve status/results. The retired workspace-provider accounts/workers arrays
remain empty. A cached client may need to refresh its MCP connection/schema.

A direct OpenAI-compatible model API uses a scoped model Bearer token. MCP OAuth
is a different audience/permission boundary. ChatGPT/Codex subscription workers
and Claude jobs are not yet wired into public durable dispatch, despite the
verified executor modules. Do not advertise a working Codex HTTP endpoint.

## Rollback and remaining gates

Backup: `/home/jq/.local/state/rotoxy/releases/rollback-03f9986-1793617145`.
It contains the previous gateway drop-in, CLI entrypoints, private configuration
copies and consistent supervisor/Oracle SQLite backups. To roll back code, restore
`gateway-dropin.conf` to the release drop-in, restore the backed-up CLI entrypoints,
reload user systemd and restart only rotoxy-gateway.service. Do not restore data
snapshots over newer work without a separate reviewed data-recovery decision.

Historical provider purge is not performed. Native account-origin broker and
Codex/Claude durable integration remain incomplete. Local browser use is disabled
in Work settings, so no authenticated visual acceptance was claimed.
