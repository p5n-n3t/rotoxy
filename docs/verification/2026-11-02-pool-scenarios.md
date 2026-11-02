# Pool and orchestration scenario evidence — 2026-11-02

This matrix separates catalog access, execution, scheduler completion and output
validation. It is not exhaustive proof of every possible prompt or failure mode.
The live gateway tested here is `03f9986`; later source fixes require activation.

## Independent API access

All catalog requests used a short-lived scoped model token, revoked afterwards.
The common public origin is `https://jq-xubuntu1.bigeye-escalator.ts.net`.

| Base path | Observed catalog | Execution evidence |
| --- | --- | --- |
| `/providers/ollama/v1` | 200, 25 models | Gemma classification completed; strict JSON failed |
| `/providers/cloudflare/v1` | 200, one selected model | Chat-message canary and mixed DAG completed |
| `/providers/oracle/v1` | 200, five unique models | Live MCP tasks and three-prompt DAG completed |
| `/providers/openai/v1` | 200, no selected models | Not inference verified |
| `/providers/openrouter/v1` | 200, no selected models | Not configured for inference |
| `/providers/custom-50c82aedf60a1471e5877940/v1` | 200, no selected models | Nebius upstream authenticated and listed 30; selections remain empty |
| `/v1` | 200, 51 entries including Ollama aliases | Oracle is still separate from this merged catalog |

For each compatible base, append `/models` or `/chat/completions` as appropriate.
MCP uses `/mcp`, and search-only MCP uses `/search/mcp`. MCP OAuth and model API
tokens are different permissions. Claude Code and Codex agent profiles are not
ordinary OpenAI-compatible inference endpoints. Their public durable dispatch
integration remains incomplete; do not advertise a made-up endpoint for them.

## Ollama output contracts

Two distinct bounded requests used `ollama/gemma4:31b`. Both returned the correct
personal classification and a provider stop, but wrapped JSON in Markdown fences.
The second explicitly requested `response_format: json_object`. Both failed raw
JSON validation; usage was 47 and 48 tokens respectively. These are subscription
usage observations, not a verified monetary bill.

Ollama explicitly documents that cloud structured output is unsupported:
<https://docs.ollama.com/capabilities/structured-outputs> (checked 2026-11-02).
The source gateway now refuses these unsupported contracts before provider calls;
plain-text requests remain supported. Do not strip fences and call the original
strict contract successful.

## Oracle multi-prompt DAG

`rx-oracle-contracts-20261102-a` was submitted once through live MCP, with custom
concurrency two. Classification and CSV transformation were independent;
extraction depended on both. All used `oracle/qwen3.5:2b`, max 128 output tokens.

| Task | Host | Provider tokens | Strict expected text |
| --- | --- | --- | --- |
| classify | ora5 | 127 | Pass |
| transform | ora3 | 132 | Fail: repeated final marker |
| extract | ora6 | 114 | Fail: repeated final marker |

All three reached scheduler `complete` with provider finish evidence. That
completion contract currently checks final marker, bounds and finish evidence,
not arbitrary requested formatting. Preserve the stricter artifact failures.
The independent request intervals overlapped by 8.840 seconds. The dependent
request began after both independent tasks completed. These are gateway request
intervals, not GPU timing. No automatic retry was performed.

The source status DTO now reports the actual requested inference model and
provider before completion, while keeping reported model absent until evidence
arrives. The live release still reports `not_reported` for that requested field.

## Decision-model boundary and remaining coverage

Use a capable planner for difficult decomposition and ordinary scheduling code
for eligibility, capacity, account protection, budgets and safe retries. A small
classifier can be benchmarked later; no per-host parent/child decision hierarchy
is required. Do not route a complex planning problem to a tiny model solely
because it is called a decision model.

Existing local regressions cover permission failures, unsupported contracts,
rate limits, local saturation, cancellation, ambiguity/no replay, dependency
handling and native-origin protection. These are synthetic evidence. Still need
live durable Claude/Codex integration, protected-origin account selection,
long-running work with restart/worker loss, full mixed-pool task validation and
authenticated browser acceptance. No claim of complete orchestration is made.
