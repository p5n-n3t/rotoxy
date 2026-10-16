# Provider and private-fleet checkpoint — 2026-10-16

This extends the connected-workspace checkpoint. Installation and live execution are separate checks; the final private deployment receipt identifies the installed source commit.

## Working implementation

- `/admin/providers` groups OpenAI-compatible inference endpoints, Cloudflare Workers AI, Ollama, coding-agent clients, and the private fleet. Its links open the actual account-management controls. Client setup links do not claim that a runner adapter exists.
- `/admin/inference` supports administrator-defined public HTTPS compatible providers, multiple encrypted account keys, model allowlists, provider editing/removal, and namespaced models through `/v1`. Endpoint changes invalidate existing bound credentials until their tokens are replaced. Custom requests resolve and pin public addresses, retain TLS hostname/certificate verification, reject private/reserved addresses, refuse redirect forwarding, and bound response sizes and deadlines. Private tailnet services belong in explicitly trusted service adapters rather than this public-endpoint template.
- `/admin/oracle/fleet` adds, edits, enables/disables, and removes configured hosts and their allowed models. The original version-1 config remains valid; explicit edits produce version 2. Writes use an owner-only backup, lock, atomic replacement, and revision check. Historical jobs remain. The UI distinguishes configured models from installed models, and says changes require a pool restart. It does not download/delete models or restart services when saving.
- The Oracle pool and resource-map projections accept a validated expandable fleet instead of filtering everything down to the original three hosts. Current conservative execution limits remain unchanged.
- A local-admin controlled-batch backend provides exact-operation exceptions to strict credit admission. It records explicit acknowledgement of unknown cost, allows 1–3 new operations during a finite start window, hashes the immutable operation/assignment binding, and consumes permission in the same SQLite transaction as claiming work. Only a typed native-credit denial reaches this fallback. Other errors fail closed. Accepted/ambiguous operations are not refunded or automatically retried. This is not a credit or monetary ceiling.

## Execution evidence

Eight supplied Cloudflare accounts match the configured registry. All eight independently authenticated and returned a valid catalog. A real request through the Cloudflare adapter, with a 16-token output maximum, returned `ROTOXY_OK` from `@cf/meta/llama-3.1-8b-instruct`: 42 prompt and 4 completion tokens, with approximately 0.31245 reported neurons. No remaining balance or monetary charge is inferred. The supported catalog/run routes are documented by [Cloudflare's API reference](https://developers.cloudflare.com/api/resources/ai/).

After deployment, a separate scoped client called the public `/v1/models` and `/v1/chat/completions` endpoints. The Cloudflare model appeared in the catalog and returned `ROTOXY_OK` with 42 prompt and 4 completion tokens. Both requests returned HTTP 200; the completion took 930 ms. The temporary gateway token was revoked immediately afterward. This verifies downstream model execution in addition to the earlier direct adapter check.

A credential-free pinned-HTTPS request reached OpenAI's official API and returned the expected 401. That proves DNS/TLS/request transport, not vendor inference with a newly configured account. No NVIDIA credential was supplied or claimed verified.

The existing ora3 LiteLLM container answered passive liveness and model-list reads. Its Claude-named aliases include routes to Ollama models; an alias must not be displayed as proof of Anthropic execution. The existing Loopback connector reports a desktop gateway and SSH fleet targets. An actual read-only request through its ora3 target returned hostname `ora3`. Loopback and LiteLLM are different capabilities; neither service was replaced or restarted for these checks.

Three bounded Oracle advisory jobs completed on ora1, ora3, and ora5 with reported `qwen3.5:9b`. Seven LightSprint assignments produced independent pushed artifacts, including one bounded turn stopped after its checkpoint. Integration checks determine completion, not idle state or transcript-marker presence. One frontier architecture attempt exhausted its observed budget without a usable result. A subsequent narrower Opus 4.6 arbitration succeeded; its advice was reviewed rather than adopted wholesale.

## Verification and limits

The TypeScript build and all 429 Node tests pass on ora5, alongside all 356 Python tests. The built-in browser verified provider, inference setup, and fleet pages at 1280×720 and 390×844 with no page-level horizontal overflow. These were read-only local fixtures using existing metadata; real configuration writes are covered by isolated tests.

A desktop Node run exposed a background-test timing failure while RAM/swap were constrained. The test now observes the actual scheduled sync completing instead of repeatedly spawning snapshot commands. The interrupted run remains recorded. A fresh isolated build and complete Node run on ora5 passed; package/deployment receipts record their separate checks. A task-local official Node 26.3.1 ARM64 binary was installed on ora5 after checking its published SHA-256, to run the checks away from the memory-constrained desktop; the global Node/PATH and VM services were not replaced.

Remaining work is explicit:

1. Controlled-batch dashboard approval and narrowly trusted worker-adapter tool-policy integration; no live grant or unrestricted production paid fanout is claimed. Default strict admission remains enabled.
2. One durable execution scheduler for LightSprint, Oracle, Claude, and additional runners; current queues are not yet fully unified.
3. Runtime-compatible OpenCode/Hermes runner adapters and configured-model discovery. Official research is in `docs/research/agent-cli-integration-20261016.md`; a directory entry is not an implemented runner. The installed Hermes executable/config were found, but its bounded help probe did not finish, and OpenCode was not found on the current PATH.
4. Authenticated in-app LiteLLM/Loopback inventory and management adapters. Connectivity is verified; lifecycle/configuration controls are not implemented. Loopback's listed fleet targets currently differ from ROTOXY's Oracle fleet and must not silently replace it.
5. Model installation/removal, automatic fleet provisioning, and a safe apply/restart workflow. Model allowlist management does not imply those operations exist.
6. Existing broader roadmap items: automatic task decomposition, native approval integrations, additional workspace providers, and supported resumable runner control. Dormant web-chat wake-up remains unsupported.

No purchases/top-ups, new provider permissions, credential extraction, provider-policy bypass, or automatic infrastructure restart was performed in this checkpoint.

## Deployment receipt

The installed code checkpoint is `57e117853a9e624d182beb2719b44dad1790299c`. The subsequent release-note commit changes documentation only. The runtime was swapped using a backed-up staged installation; the gateway, Oracle pool, and workforce monitor were deliberately restarted for deployment. Existing LiteLLM and Loopback services were not restarted. The master-key checksum remained unchanged, the workspace database passed SQLite `quick_check`, and all four ROTOXY runtime/Funnel services reported active. Public diagnostics passed process, config, credentials, upstream initialization, OAuth, tool inventory, and Funnel routing with no findings. Official Claude Code MCP reconnection reported `Connected`; the previous end-to-end tool-execution proof remains recorded separately.

Seven reviewed LightSprint artifacts were imported into the durable agent workspace, producing 20 recorded tasks at import time. Their actual session/account/model attribution and Git references are preserved; local assignment identifiers are not passed off as upstream task identifiers. A provider's idle state remains separate from artifact approval.
