# Worker feedback and orchestrator continuity

Worker supervision has three separate responsibilities: detect an execution
outcome, preserve it, and deliver it to a client that can act. A notification
receipt is not evidence that an agent resumed or handled the incident.

## Current evidence

The live Oracle test `rx-oracle-contracts-20261102-a` produced durable inbox
events `repo:569`, `repo:570`, `repo:572`, and `repo:573`. These identify task
completion and assignment completion. The old workforce monitor does not consume
that event stream: it monitors retired sessions. Its existence is not proof of
Oracle monitoring-to-resumption delivery.

The new source adds two client paths:

| Path | Behavior | Verification boundary |
| --- | --- | --- |
| `job_wait` | An active caller waits up to 20 seconds for status changes; ordinary code polls | Local tests; deployment and live caller test required |
| MCP Events | Authorized job subscriptions receive signed callbacks for changed state | Opt-in implementation; actual ChatGPT subscription/response still required |
| Durable inbox | Outcomes remain available for reconnect and acknowledgement | Live Oracle completion events observed |
| Headless resumption | Existing explicitly bound local Codex adapter can produce advisory output | Not connected to the Oracle job stream; not a working automatic fallback yet |

No path injects keystrokes or messages into an unrelated chat or terminal.

## ChatGPT event integration

The official [MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events),
checked 2026-11-02, documents subscriptions in ChatGPT Work on web, Work with
Cloud selected on desktop, and dots. It uses an event-enabled plugin, callback
verification, and signed webhook delivery. The user specifies the response to
events. Ordinary MCP login does not create that subscription, and other client
modes must not be assumed to support it. This updates earlier blanket statements
that no ChatGPT event-driven response is possible.

Source opt-in: `ROTOXY_MCP_EVENTS_ENABLED=1`, with a configured supervisor backend.
The authenticated `/mcp` endpoint then advertises events to `mcp jobs:read`
clients. `events/list` describes `rotoxy.job.changed`, filtered by `projectId`
and `jobId`. Subscription requests come from the supported client, which supplies
its callback and signing secret. Do not construct an arbitrary platform callback.

Signing secrets are encrypted through the existing master key. Public HTTPS
callback validation pins DNS addresses and rejects private destinations and
redirects. Access is checked before subscription and delivery. A durable outbox
retains event IDs across bounded retries; receipts record callback acceptance or
failure without secrets. Refresh retains pending work; unsubscribe stops future
delivery; an already transmitted request cannot be recalled. Receipt acceptance
does not prove ChatGPT's resulting action. Status events coalesce observations;
the job event ledger remains the detailed audit history. Replay cursors are not
advertised for this event.

## Slow Oracle execution

Do not confuse host health with progress on a particular inference. Current
inference has no provider progress heartbeat. A loading model and a hung request
can both look like an unanswered HTTP request. Use `awaiting response` until
stronger evidence arrives. Current gateway inference deadlines are bounded; a
long-running dataset must be split into durable, bounded chunks with stable IDs.

Treat outcomes as follows:

- Finished: provider termination evidence plus retrieved, validated artifact.
- Needs guidance/approval: an explicit adapter state, not a guessed interpretation
  of inactivity. A plain inference response has no native mid-turn approval API.
- Deadline elapsed or connection lost: ambiguous; retain ownership and reconcile.
- Crashed: explicit process exit/provider error evidence.
- Idle: no success implication. Never replay merely because work seems slow.

No LLM is used as a polling clock. Supported event responses and headless agents
can consume subscription quota when invoked, so deduplicate significant changes
and keep recovery permissions and spending bounded.

## Release tests

Require completion, explicit failure, an unresolved slow request, guidance state,
partial sibling completion, authorization revocation, transient network loss,
callback verification rejection, duplicate delivery, unsubscribe, secret rotation,
gateway restart and reconnect. Verify both callback receipt and the native
client's actual reaction before declaring automatic feedback operational.
