# Dispatch approvals and private services — 2026-10-16

This checkpoint extends the provider/fleet release. It separates a recorded permission from actual execution and from a provider-enforced spending ceiling.

## Dispatch approvals

`/admin/dispatch-approvals` exposes existing queued operations and known pre-dispatch credit denials. The administrator selects exact operations, acknowledges unknown provider cost, and chooses a finite start window and 1–3 maximum launches. Approval does not resume a paused project. The grant is not a monetary ceiling and does not refill credits.

The submitted form carries the bindings shown when the page was rendered. The Python registry validates those bindings inside the same write transaction that records approval. Changes to the instruction, account, session, task generation, or assignment invalidate the observed binding. Neither browser requests nor MCP callers may supply database paths. The ordinary strict reservation path remains first; an exact controlled grant is considered only after a typed credit denial.

The internal worker obtains an operation-specific adapter only after a durable authenticated registry claim. The production factory checks the configured account/session/model, captures the exact message and client-message ID, and authorizes one matching chat POST. The capability is invalidated on its first attempted use before provider I/O; changing the raw tool policy cannot make it reusable. The ordinary account-pinned adapter and downstream MCP calls retain their existing restrictions. Eligibility, lease, model, and session ownership checks still apply. No automatic grant, generic bypass flag, arbitrary provider mutation, or retry after an ambiguous send is introduced.

One bounded Opus 4.6 review conditionally supported this boundary. Its useful recommendations were reviewed independently. Claims about provider-side lease semantics and serializing function references were not adopted as evidence of real platform capabilities. One LightSprint implementation reached its time limit after pushing a checkpoint; the integration lead repaired and verified that code rather than treating the provider's idle/running state as completion.

## Private services

`/admin/services` manages an owner-only service inventory, using revisions, backups, and atomic file replacement. Defaults describe LiteLLM on ora3 and the desktop Loopback listener. Add/edit/enable/disable/remove affect this inventory; they do not reconfigure an external service.

A manual LiteLLM probe selects an enabled host from the approved fleet registry and runs a fixed remote Python program over the existing SSH transport. It reads only localhost port 4000's `/health/liveliness` and `/v1/models`, with redirects and inherited proxy forwarding disabled. Request paths and commands cannot come from HTTP input. Reported model aliases are shown as aliases, not proof of the underlying vendor/model. The desktop Loopback probe checks only TCP reachability on localhost port 2026, which is less evidence than an authenticated MCP execution test. Neither probe performs inference or calls an MCP tool.

The service page does not probe on page load. Probe results are bounded, explicitly timestamped, and cached in the registry. An unknown or inaccessible result remains visible instead of implying healthy execution.

## Verification boundaries

All 436 Node tests and 362 Python tests pass. The built-in browser review led to wider service panels and a responsive approval form; desktop and mobile screenshots are retained privately. Package auditing and a fresh-install check also pass. Detailed deployment diagnostics are retained separately. A regression uncovered valid base64url account IDs beginning with underscore or hyphen being rejected by the routing rules; the validator and a deterministic test now cover these IDs. No production controlled grant was issued to claim live paid execution for this checkpoint. Prior controlled LightSprint development batches and public Cloudflare execution remain separately evidenced.

Still outside this implementation: automatic fleet provisioning, model download/removal, external service lifecycle/configuration changes, a fully unified coding-agent scheduler, OpenCode/Hermes execution adapters, arbitrary web-chat wake-up, and automatic approval of provider-native prompts.

## Live admitted operation and transcript repair

A separate owner-only temporary registry exercised strict credit denial and a one-operation controlled grant, using one existing idle LightSprint Luna session. The grant was consumed exactly once and the chat operation was accepted. LightSprint produced `ROTOXY_ADMITTED_OK`; the first supervisor run did not complete the job. This exposed a real transcript mismatch: the provider assigns independent `turnId` identifiers to user and assistant items. Matching those identifiers incorrectly withheld the fresh answer.

The repair uses strictly increasing sequence order, the latest user boundary, a reply timestamp no earlier than that instruction, and the existing exact instruction SHA-256 check in the worker. The adapter requests a bounded text-only transcript page so intervening tool records cannot hide that boundary. Missing boundaries, invalid order, truncation, and a later user instruction still fail closed. Only documented read-only transcript query parameters were added to the local policy; raw mutations remain blocked. Restart recovery of the already-sent operation is verified separately, without sending the instruction again.
