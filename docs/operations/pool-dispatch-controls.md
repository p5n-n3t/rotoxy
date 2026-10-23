# Pool dispatch controls

`/admin/routing` provides authenticated, CSRF-protected pool switches and account
ceilings for LightSprint, Ollama and Cloudflare Workers AI. Controls use the
existing routing rules store and preserve model allowlists and relative weights.
A stale form is rejected with HTTP 409; refresh before saving again.

Pausing blocks new work; it does not cancel an accepted operation. LightSprint
read-only observations and explicit session stop remain available. Durable
LightSprint dispatch refreshes policy before claiming more operations, without a
service restart. A policy read failure prevents new claims until a later retry.

Automatic routing continues inside the operator ceilings. Blank means the adapter
limit or registered session count. A manual ceiling cannot raise a hard adapter
limit, create upstream sessions, enable a depleted credential, or establish an
unverified provider slot entitlement. Ollama/Cloudflare ceilings count concurrent
inference requests; LightSprint ceilings count durable worker allocations. These
measurements are deliberately distinct. Direct LightSprint MCP mutations respect
the pause, but raw MCP calls do not constitute durable worker-slot reservations.

Oracle host/model/maintenance controls remain at `/admin/oracle`; they are not
controlled by the three switches above. Generic OpenAI-compatible providers and
Bedrock retain their existing provider-specific controls.

## Protocols and paths

The shared agent control surface is `/mcp`. Provider-specific inference endpoints
and their required token scopes are listed in the credentials interface. OpenAI
compatible inference paths expose only models that their adapters can execute.
An MCP workspace, search tool or remote coding session is not automatically an
OpenAI chat-completions backend. Protocol conversion must be implemented and
verified before claiming that compatibility.

## Human-readable operations

Supervisor timestamps display a readable UTC date with exact ISO timestamps in
attributes. Missing heartbeat, model, task and account attribution have distinct
explanations. Internal missing-data sentinels are retained for machine consumers;
no missing value is replaced with invented health or capacity.
