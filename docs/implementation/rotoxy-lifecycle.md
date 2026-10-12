# ROTOXY manual lifecycle controller

Assignment checkpoint, 2026-10-12: branch `codex/rotoxy-lifecycle-20261012`, based on fetched `origin/main` commit `a7b7a30545d2fdd90d845a3a2003eaa973926927` in an isolated worktree. This cloud checkout did not access or modify operator-local files.

This change adds a deliberately manual controller for the locally installed Token2OAuth stack. `up`, `down`, `status`, and `install-plan` are explicit commands; neither the target nor the foreground Funnel unit is enabled at boot. It uses the user systemd manager and only manages `token2oauth.service`, `token2oauth-oracle-pool.service`, `token2oauth-worker-monitor.service`, `rotoxy-funnel.service`, plus the owned `rotoxy.target` activation anchor. Commands use argument arrays through `execFile`; a private bounded lock serializes up/down.

`up` inspects Tailscale Serve state, starts the activation anchor and any inactive backend units, polls `http://127.0.0.1:2030/healthz`, then starts the dedicated foreground `tailscale funnel --https=443 http://127.0.0.1:2030` unit. It verifies that `/` reaches port 2030 and Funnel is enabled. If startup or verification fails, it stops only units this invocation started. Existing `/token2oauth` is preserved only when it targets the same 2030 gateway; this keeps the legacy path compatible while the app handles root requests. Other mounts are blockers.

A conflicting root Serve route can be removed only with `up --migration-plan FILE`, where the reviewed JSON is exactly scoped to the observed old target, for example:

```json
{"version":1,"allowRemoveRoot":true,"rootTarget":"http://127.0.0.1:2025"}
```

The controller removes only that root path with `tailscale serve --https=443 --set-path=/ off`, then compares the observed full Serve configuration (excluding its ETag) with the expected snapshot before proceeding. A persistent/active Funnel (`AllowFunnel` on the listener) is always refused, even when a file is supplied: the operator must separately review and withdraw legacy exposure without a global reset, then retry. Foreign routes are not migrated. `down` stops the owned foreground service first and verifies withdrawal; if the route persists or remains public, it stops there and leaves backend units running for diagnosis. It never runs `tailscale serve reset`, global Serve/Funnel `off`, or edits `~/.local` files.

## Install and operator handoff

Run `node scripts/rotoxy-control.mjs install-plan` from the checkout and review its paths. Manually back up an existing `~/.local/bin/rotoxy`, install `packaging/rotoxy.target` and `packaging/rotoxy-funnel.service` under `~/.config/systemd/user/`, install the script under `~/.local/lib/`, then point the wrapper at it and run `systemctl --user daemon-reload`. Do not enable either unit. The plan intentionally prints commands only; it does not modify the operator machine.

Before `up`, inspect `tailscale serve status --json`, `tailscale funnel status`, the existing unit definitions and executable paths, Token2OAuth's local health, and the current `/token2oauth` route. Keep the prior root backend available until native proxy parity is verified. Only remove a root route after recording its exact observed target in the reviewed migration JSON. Do not disable global Funnel to clear a collision. If startup fails after an approved root removal, the controller rolls back units it started but leaves that route removal in place; restore the prior root only from the separately retained exact snapshot and after operator review. After `up`, check `rotoxy-control.mjs status`, root and `/token2oauth` from the tailnet, OAuth metadata, MCP initialize, and expected admin/UI routes. `down` is the rollback for the new foreground Funnel. No installation, systemd command, Tailscale command, or live route was exercised in this cloud checkout.

## Tests and remaining integration seam

`node --check scripts/rotoxy-control.mjs`, `node --check test/rotoxy-control.test.mjs`, `node --test test/rotoxy-control.test.mjs` (5 passed), `git diff --check`, and the `install-plan` output smoke check passed. Tests set a temporary `HOME` and `TOKEN2OAUTH_CONFIG_DIR` before any possible `StateStore` construction; they never construct one or call systemd/Tailscale. They cover startup ordering, route preservation, refusal, explicit root migration, rollback, idempotent up, and CLI validation. Root integration owns verifying the exact installed local unit paths/configuration, the installed CLI wrapper handoff, real Tailscale foreground command behavior and route output, and native root/OAuth/MCP parity. Do that acceptance locally before replacing the old wrapper or stopping the old backend.
