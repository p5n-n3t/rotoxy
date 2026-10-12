# ROTOXY consolidation checkpoint — 2026-10-12

ROTOXY is the unified product on the Token2OAuth codebase. The canonical repository remains `p5n-n3t/token2oauth` during migration because `p5n-n3t/rotoxy` already names the predecessor. Existing configuration directories, package identity and `/token2oauth` URLs remain compatible. This checkpoint describes verified behavior, not completion of the entire platform roadmap.

The later [actionable supervision update](2026-10-12-actionable-supervision.md) supersedes the worker-question/manual-guidance and headless-adapter status below. It records separate current test and runtime evidence.

## Authentication and runtime

The recurring ROTOXY client-token error came from two launchers competing for the same Tailscale listener. The predecessor installed a root proxy to port 2025 and could remove the gateway's mounts. The unified runtime now owns one foreground HTTPS Funnel route at `/`, targeting port 2030. The application accepts both root and `/token2oauth` paths. OAuth registration, authorization and token compatibility aliases use the original secured handlers.

The legacy process was stopped. Its old user unit and the old path-restoration unit were backed up and masked. Its source launcher now delegates to the unified command when the local ownership marker exists; unrelated source edits and credentials remain preserved. Loopback on port 2026 was left running.

Real `rotoxy down`, `up`, and repeated `up` passed: down withdrew the route and stopped the configured services; up restored one foreground route after the health check; repeated up started nothing. Gateway/Oracle/monitor boot activation is disabled, and the new target and Funnel units have no boot installation target. No machine reboot was performed. A live public doctor check passed all seven stages, including actual upstream MCP initialization, tool inventory, OAuth metadata and Funnel inspection.

Claude Code 2.1.286 used its official HTTP MCP configuration and browser consent. It authenticated and then performed a real LightSprint `GET /api/repos`; it repeated this successfully after the gateway restart and Funnel migration. Repository counts varied with the account selected by pooling. This test proves authenticated read execution and result retrieval, not a paid cloud inference task initiated by Claude. Project-scoped job access also requires the approved client ID in the private supervisor project binding; OAuth job scopes alone do not grant project membership. A stale cached registration ID initially caused a job-access denial. The active grant was signature-verified and its client ID was added explicitly.

## Implemented surfaces

| Surface | Current behavior | Evidence limit |
|---|---|---|
| Models | Encrypted Ollama Cloud key pool; enable/disable/rotate; separate expiring scoped client tokens; bounded payload-free recent activity | In-memory activity resets at restart; no reported quota or durable model billing ledger |
| Model protocols | `/v1/models`, `/v1/chat/completions`, stateless `/v1/responses`, `/api/tags`, `/api/chat`, `/api/generate`; compatibility `/p/ollama` and `/pool/ollama` prefixes | Live execution tested on chat completions; other routes share the guarded proxy and require provider support |
| Credits | All 12 LightSprint and 12 Exa historical readings, manual updates, source/date, meaningful capacity bars and a separate holds/debits ledger | Readings are not live balances; new-account full balances are derived from operator-provided zero usage and allowance; USD is not converted to native credits |
| Oracle | Read-only operations view for ora1/ora3/ora5, cached health/model catalog, actual queue assignments and reported token throughput | No live CPU/RAM panel; cached catalog is not an SSH heartbeat; routing advice is not authority |
| Supervisor | Full-width worker console, tabbed inbox/recovery/handoffs, account/session/task identity, requested versus observed model, durable events | Native approval/question reply controls and automatic cloud/headless recovery are not connected |
| Search | Encrypted Exa/Firecrawl/Tavily account entry, adapter capability binding, explicit per-client permissions, live configuration reload | Stored keys are not provider execution proof; Exa credit/team records alone do not connect credentials |
| Codex | Isolated official CLI profiles, user-mediated device sign-in, model catalog, reported quota windows, thread ownership | Automatic subscription pooling/task dispatch is not enabled; no subscription entitlement is inferred |
| Branding | ROTOXY mark, wordmark, favicon, grouped navigation, shared responsive light/dark theme | Repository rename and broader release collateral remain outstanding |

Model-token authentication is independent of MCP OAuth and the administrative session. The admin password is **not** a bearer token. The predecessor's existing model client token was explicitly migrated as a hash with model-only scopes and a 30-day transition expiry. Its OpenRouter key and two MCP registry entries remain in the rollback configuration; those predecessor routes were not migrated and are no longer served.

## Execution and cost evidence

Nine Ollama keys each returned an 18-model catalog through the native gateway. One bounded `gemma4:31b` chat completion returned a non-empty answer with 18 prompt tokens and 2 completion tokens. All nine account IDs appeared in the rotation trace. Temporary test tokens were revoked.

Eight LightSprint workers had overlapping observed running intervals across four accounts, with a shared observation point at `2026-10-12T11:30:44.348Z`. These were genuinely running observations, not queue counts. Work used verified `claude-opus-5-5` for design/architecture and `gpt-6-luna` for implementation. No verified Fable selector or API reasoning-effort parameter is claimed. Thirteen bounded assignments, including follow-ups, are recorded in the private worker ledger; no assignment remains dispatched. Artifacts were reviewed and integrated instead of treating an idle state as success.

Observed USD cost thresholds are delayed stop conditions, not enforceable provider-native credit ceilings. One initial frontier run exceeded its observation threshold before cancellation; its incomplete output was not counted as delivered. No purchases or top-ups were made. The strict read-only gateway tool policy was restored after the bounded batches. Provider concurrency limits, available native credits and 24/35-worker operation remain unverified.

Three Oracle advisory tasks executed on separate hosts and completed. Actual queue history at the check was distributed 7/7/6 across ora1/ora3/ora5. Their advice remains bounded and subordinate to deterministic health, capacity, ownership and budget checks.

The installed Codex 0.162.1 App Server completed its real initialize/device-code-start/cancel protocol under an isolated temporary profile. No operator account or credential file was selected, copied or parsed. Actual signed-in profile model/quota readings require the operator's device authorization. The implementation was corrected against the installed client's generated JSON schema (`account.type`, display names and reasoning option objects).

## Verification

- Full Node regression suite: 326 passed before the final lifecycle/installer-only changes; focused lifecycle/installer/release checks: 9 passed afterward.
- Embedded Python suite: 306 passed.
- Desktop 1280px and mobile 390px headless rendering: Models, Credits, Oracle, Search and Codex all returned 200 without document-width overflow. Private screenshots were retained locally; they contain operator account data and are not published.
- Public OAuth/MCP and CLI lifecycle behavior were tested separately from unit mocks.
- Offline build/tarball audit passed with the new manual installer, controller and foreground units included.
- Manual installer behavior was tested with isolated local command doubles. A fresh clean-machine installation was not performed.

## Rollback and continuity

The operator installation retains mode-restricted credential, unit and routing backups under `~/.local/state/token2oauth/backups/pre-rotoxy-native-20261012/`, including a consistent stopped-state archive. The previous runtime is retained at `~/.local/share/token2oauth-pre-rotoxy-native-20261012`.

For a code-only rollback, run `rotoxy down`, restore the previous runtime directory, and restart the gateway under a reviewed routing configuration. That older runtime predates native model routes, so it does not provide model parity. Full predecessor rollback additionally requires restoring the saved legacy launcher and units, unmasking only those explicitly restored units, and applying the saved routes after reviewing current Tailscale state. Never execute a global Serve/Funnel reset or overwrite newer job databases blindly. Backups preserve a rollback path; a full predecessor rollback was not exercised during this consolidation.

Monitoring and its durable inbox continue when an interactive chat closes while the service host is online. `rotoxy down` or host shutdown stops local supervision. The credential-free AWS observer is not a cloud replacement for the scheduler. Dormant ChatGPT conversations cannot be arbitrarily awakened; outstanding events must remain in the handoff queue. Automatic paid cloud guidance, official headless resumption adapters, provider-native question/approval workflows, full subscription pooling, external supervisory failover, broad analytics and additional provider integrations remain follow-up work.

## Next work

Connect authenticated, revision-fenced question/approval actions to documented LightSprint operations; then implement bounded recovery adapters with durable action receipts and real disappearance/restart tests. Add durable model telemetry, fresh quota acquisition where officially available, deterministic cross-family scheduling and Oracle advice validation. Verify a clean installation and progressive useful concurrency before representing the platform as fully release-ready.
