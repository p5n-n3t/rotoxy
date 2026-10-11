# Persistent supervision increment

New code in this integration branch adds a private SQLite incident inbox (`snooze.guidance`), a read-only LightSprint observer (`scripts/monitor-workforce.mjs`), and bounded local-model recommendations through `snooze.oracle_pool`. It is a concrete increment, not the full cross-client autonomous recovery system.

The observer authenticates with the existing encrypted gateway account registry, reads only explicit account/session bindings, validates session ownership, and retains only status/model/progress-count metadata. It never sends cloud chat, launches an agent, buys credits, or merges code. Session polling is ordinary code. Failed/stalled/instruction-request episodes can enqueue a bounded qwen3.5:9b text review; running/completed/idle events do not continuously spend model inference. Recommendations are advisory and need authorized execution.

A stalled event means unchanged observed status/model/prompt-count over the configured interval, not proof that inference has stopped. Idle requires review; only a separately verified output receipt can prove completion. Model display is independent of cost coverage. Event IDs, owner checks, acknowledgment, deduplication and guidance job IDs survive client exits/restarts. Repeated local queue submissions use stable IDs; ambiguous upstream mutations remain prohibited.

Configuration is private, with explicit worker/owner/job bindings. It is not yet automatically populated by every AI client, all providers, or the distributed job registry. The live admin dashboard is not yet wired to this additional incident inbox. Existing Snooze service/state and installed gateway source are preserved. No claim that this chat or ChatGPT Web can be awakened. The official headless resumption broker remains a separate component requiring policy integration.

## Tests

Focused unit tests cover heartbeat deduplication, possible stalls/recovery, idle versus verified completion, owner-bound acknowledgments, hourly guidance limits and a lost local queue receipt. Real three-host inference evidence is in `../evidence/2026-10-11-oracle-pool-reviews.md`. A separately labeled synthetic incident tests the path into the real local queue; it is not proof of a real cloud-worker failure or automatic cloud guidance.

## Runtime and rollback

Private state lives in `~/.local/state/token2oauth/oracle-pool/` and `~/.local/state/token2oauth/supervision/`. The local user service `token2oauth-oracle-pool.service` runs the bounded queue independently of this conversation, without listening on a public port. A separate registered-worker monitor service can run the read-only observer.

Stop/disable only the newly named user services to roll back these daemons. Preserve their private databases for recovery. Installed gateway strict read-and-cancel policy has a private backup at `~/.local/state/token2oauth/quota/tool-policy-before-strict-credit-mode.json`; restore with `token2oauth tools policy set` only after reviewing credit enforcement. Do not reset shared Funnel or alter the pre-existing Snooze service.

## Execution evidence — 2026-10-11

Both `token2oauth-oracle-pool.service` and `token2oauth-worker-monitor.service` are enabled and active on the local host. The observer checked one explicitly registered owned LightSprint session, with zero status errors and zero guidance submissions while idle. This registered session is a design candidate, not a dispatched design assignment.

A separately labeled synthetic failure was submitted to the durable inbox. It created local queue job `guidance-41c3d3536eef-1`; the independent queue daemon completed a real `qwen3.5:9b` advisory review on ora1, attempt 1, after the initiating test command had returned. Ollama reported 99 prompt tokens, 149 output tokens and 35.221 seconds; measured elapsed time was 39.173 seconds. This demonstrates durable incident-to-local-model guidance, not actual cloud failure recovery, automatic delivery of instructions to LightSprint, or resumption of an interactive conversation.
