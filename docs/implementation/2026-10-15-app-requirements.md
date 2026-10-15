# ROTOXY application release requirements

Source: operator's 2026-10-15 brainstorm and direct instructions. This is an acceptance ledger, not a completion claim.

## Product contract
ROTOXY is an application for managing authorized AI resources and durable work. The primary workflow is connect resources, select eligible models and budgets, submit work, observe execution, resolve decisions, and collect results. Workspace execution and stateless inference remain distinct capabilities.

## Acceptance ledger
| Area | Required result | Current wave |
|---|---|---|
| Accounts | Add, rename, edit, disable and remove appropriate profiles without changing identity or leaking credentials | Cloudflare and Codex/Ollama worker assignments |
| Cloudflare | Encrypted eight-account pool, catalog, allowlisted models, fair routing, real usage, authenticated execution | Eight catalogs and eight minimal inferences verified; product adapter pending |
| Application shell | Compact persistent navigation, coherent groups, keyboard/mobile access, no broken routes | Cloud worker implementing |
| Tool inventory | Distinguish upstream tools from gateway tools and client scope filtering | Integration change in progress |
| Bedrock | Official Claude Code execution, model and bounded usage attributed to configured AWS account | Config confirmed; bounded tools-disabled architecture review running |
| Private workers | ora1/ora3/ora5 fair eligible scheduling, health and task attribution, durable recovery | Three review tasks submitted; ora3 transport outcome ambiguous, no blind retry |
| Pipeline | Live inspectable graph from actual events; editable eligible providers/models/weights and deterministic constraints | Not implemented this wave yet |
| Supervision | Meaningful event-triggered recovery with budgets, durable decisions and supported resumption | Existing bounded manual guidance; automatic paid recovery remains gated |
| Branding | ROTOXY throughout visible UI, reversible repository/runtime identity migration | Preserve legacy compatibility until migration is tested |
| Duplicate profile | Remove only operator-identified 2_plus_ecummings6969@hotmail.com duplicate, preserve auth backup | Await tested removal method |

## Verification and policy
Credentials never enter repository, worker prompts, or reports. Cloudflare REST catalog and inference references: https://developers.cloudflare.com/api/resources/ai/ and https://developers.cloudflare.com/workers-ai/get-started/rest-api/ (checked 2026-10-15). Request neuron usage is reported consumption, not remaining allowance. Model availability does not prove capacity or context entitlement. No purchases or top-ups. LightSprint runs are bounded by elapsed time and observed cost, which is delayed and cannot guarantee a native credit ceiling. The production read-only tool policy is restored after each controlled batch.

Private assignment and evidence ledger: ~/.local/state/token2oauth/batches/20261015/app-wave/. Architecture, implementation, tests, deployment and live verification remain separate milestones.

## Architecture review adjudication
A tools-disabled official Claude Code call completed through Bedrock, reporting `global.anthropic.claude-opus-4-6-v1[1m]`, a 1,000,000-token context descriptor and USD0.03193 list-based estimated usage. This proves one model execution, not all account models or concurrent capacity. Its three-way separation of inference, durable jobs and an event-driven command centre is accepted. Recommendations to run tiny-model triage on every request, promise exactly-once external effects, or require known provider capacity for registration are rejected: use deterministic fast paths, reconciliation after uncertain effects, and explicit unknown capacity with conservative operator limits. No new framework dependency is justified yet.
