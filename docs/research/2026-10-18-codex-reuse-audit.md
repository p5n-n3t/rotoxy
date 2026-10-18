# Codex pool and proxy reuse audit

**Checked:** 2026-10-18
**Purpose:** Find the smallest safe way to reuse existing Codex multi-account work without adding another auth store or proxy to ROTOXY.

## Recommendation

Keep the existing official Codex App Server profile integration as the authentication and execution boundary. For new work, reuse the *selection policy shape* seen in OpenCodex, implemented against ROTOXY's own profile snapshots and ownership ledger: first honor an existing thread's bound profile; for a new thread, consider only fresh, healthy, model-capable profiles with known, non-exhausted quota windows; choose the least-used candidate with a stable tie-break; persist thread ownership before dispatch. This small policy is not worth importing from a project whose function is coupled to a much larger private state graph.

Do not install another always-on proxy. ROTOXY already owns a generic `/v1` gateway, and `CodexProfiles` already launches one official `codex app-server --stdio` process per isolated profile directory. An optional external OpenCodex endpoint can be treated as an explicitly configured OpenAI Responses provider in the existing provider interface, but that would pool at the proxy-request layer and must not be mistaken for native durable Codex task/session execution.

## Existing ROTOXY boundary

At audited repository HEAD `a43c5e2be3c1e156c360e85ba428b0237f7c4d7d`, [`src/codex-profiles.ts`](../../src/codex-profiles.ts) already:

- launches the official app server with fixed `app-server --stdio` arguments and a per-profile `CODEX_HOME`;
- starts the official device login flow, reads account/model/rate-window snapshots through the app-server RPCs, and keeps only metadata in its profile registry;
- exposes `eligibleProfiles(modelId)` as a conservative candidate filter (fresh snapshot, ChatGPT auth, model present, all windows known, none exhausted); it does not select or dispatch a worker;
- binds a thread ID to one profile and refuses a conflicting rebind.

Snapshots are held in process memory, while thread ownership is persisted. This is a good credential boundary for independent worker sessions; it is different from a request router that swaps a bearer credential between calls. A new-account selection helper should preserve this distinction and fail closed if a required snapshot is stale or unknown.

## Candidate projects

| Project and pinned revision | License / runtime | Useful work | Fit and decision |
|---|---|---|---|
| [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex/tree/6936d9885d8a9bda9301737affcbaf1a4ff00e17) — `6936d9885d8a9bda9301737affcbaf1a4ff00e17` | MIT. Bun-first TypeScript proxy; package supports Node 18+ via a bundled Bun runtime. | Closest product reference: ChatGPT/Codex account pool, quota-window display, policies, thread affinity, cooldown and a Responses proxy. The nearest ranking routines are [`pickLowestUsageAmong`](https://github.com/lidge-jun/opencodex/blob/6936d9885d8a9bda9301737affcbaf1a4ff00e17/src/codex/routing/selection.ts#L607-L627) and [`pickLowestUsageCodexAccount`](https://github.com/lidge-jun/opencodex/blob/6936d9885d8a9bda9301737affcbaf1a4ff00e17/src/codex/routing/selection.ts#L630-L642). | Do not embed the proxy or selector. `pickLowestUsageAmong` reads its process-global quota and plan state; its eligible-account logic also depends on pause, plan exclusions, reauth flags, cooldown, quota avoidance, refresh cooldown, model-denial and priority-tier state in [`getEligiblePoolAccounts`](https://github.com/lidge-jun/opencodex/blob/6936d9885d8a9bda9301737affcbaf1a4ff00e17/src/codex/routing/selection.ts#L197-L255). It is not an isolated module. Reuse the observed policy concept and cite OpenCodex as prior art. Its substantial translation/proxy layer duplicates ROTOXY. |
| [ndycode/codex-multi-auth](https://github.com/ndycode/codex-multi-auth/tree/b82211307685a2bb1166cd9f69988b965bfab3bc) — `b82211307685a2bb1166cd9f69988b965bfab3bc` | MIT. ESM, Node `>=22.19`; local runtime was Node `v22.22.1`. | Narrowly exported auth, storage, config and request modules; PKCE login, account health and a wrapper-owned loopback rotation proxy. | Do not import its credential vault or rotation proxy. It owns a second OAuth/account store under `~/.codex/multi-auth`, wraps the Codex CLI and writes its runtime routing state. That conflicts with the existing per-profile app-server ownership model and duplicates ROTOXY's `/v1` routing. Its documented security boundary correctly keeps the proxy loopback-only and states that local binding does not create upstream entitlement. Could be revisited only for a separately scoped, license-reviewed helper with a concrete gap not covered by official App Server APIs. |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/tree/911f49cbd49f4fe2516979754a7488a3fd14fe64) — `911f49cbd49f4fe2516979754a7488a3fd14fe64` | MIT. Go service (`go 1.26.0` at this revision), broad proxy/admin surface. | Multi-provider OAuth and OpenAI-compatible/Responses routing; useful reference for operational management and account observability. | Do not embed or deploy beside ROTOXY. It is a separate Go proxy/runtime and would create overlapping gateway, account and admin state. Current source targets a different runtime generation from the host's configured Node service. |
| [Soju06/codex-lb](https://github.com/Soju06/codex-lb/tree/72630bbfeee9e3b0d9acfb95e2b1e706b8b0188e) — `72630bbfeee9e3b0d9acfb95e2b1e706b8b0188e` | MIT. Python/FastAPI/SQLAlchemy; upstream marks it Alpha. | Codex account load balancer, usage dashboard and OpenCode-compatible endpoints. | Do not adopt its service/database. It is another full proxy and web application, so its integration boundary is too broad for ROTOXY's existing TypeScript gateway and profile registry. Its README advertises usage/cost tracking; do not treat those estimates as authoritative quota or execution evidence without verifying their source. |
| [openai/codex](https://github.com/openai/codex/tree/8c076942cb70fba8e5c4732c23f1faabc4aed484) — `8c076942cb70fba8e5c4732c23f1faabc4aed484` | Apache-2.0. Official Codex implementation; Node `>=22`, Rust workspace and pnpm monorepo. | Correct protocol and behavior reference for official login, app-server, CLI execution and resume. | Keep using the installed official binary/App Server via the existing adapter. Do not fork or vendor the large CLI implementation; the gateway already uses the supported app-server RPC boundary and a separate isolated home per account. |

## Selector reuse finding

OpenCodex has a useful conceptual order: establish eligibility, retain an existing binding, then rank unbound candidates. However, its least-usage function is not a standalone selector. The source's `pickLowestUsageAmong` reaches global quota and plan accessors, and the surrounding selector uses many policy modules. Copying only the loop would falsely imply equivalent eligibility and plan scoring.

For a small ROTOXY implementation, derive `eligibleProfiles` candidates first. When a thread already has an owner, continue on that exact profile or report it unavailable; never silently move that thread. For a new thread, rank by the maximum reported `usedPercent` across its known quota windows (minimize the most-constrained window), then tie-break by stable profile ID. Persist the chosen thread binding before any mutating dispatch. If quota/window data is missing, stale, or provider eligibility is ambiguous, decline automatic selection. This is an adaptation of a general selection idea, not a copied code fragment; it does not need an OpenCodex source notice. If any OpenCodex code is later copied, carry its MIT license and the copyright notice `Copyright (c) 2026 opencodex contributors` into the distribution's third-party notices.

## Retry and execution boundary

Account failover belongs at **new independent task creation**, before a provider session is created. Once a task/session exists, keep its account and session affinity. Do not automatically replay an ambiguous create, message, or resume operation on another account: the upstream may have accepted the first operation even when the response was lost. Retry only a documented idempotent operation or after reconciling the exact remote operation/session state. OpenCodex documents bounded proxy failover, but that does not establish that every replay is safe for ROTOXY's durable agent tasks. The audited OpenAI account-pool projects are request routers and account managers; none replaces the missing durable multi-provider workspace scheduler or its remote-worker supervision contract.

## Evidence links

- [OpenCodex MIT license at audited revision](https://github.com/lidge-jun/opencodex/blob/6936d9885d8a9bda9301737affcbaf1a4ff00e17/LICENSE)
- [OpenCodex provider and account-pool behavior](https://github.com/lidge-jun/opencodex/blob/6936d9885d8a9bda9301737affcbaf1a4ff00e17/docs-site/src/content/docs/guides/providers.md)
- [codex-multi-auth public API contract](https://github.com/ndycode/codex-multi-auth/blob/b82211307685a2bb1166cd9f69988b965bfab3bc/docs/reference/public-api.md)
- [codex-multi-auth security policy](https://github.com/ndycode/codex-multi-auth/blob/b82211307685a2bb1166cd9f69988b965bfab3bc/SECURITY.md)
- [CLIProxyAPI MIT license](https://github.com/router-for-me/CLIProxyAPI/blob/911f49cbd49f4fe2516979754a7488a3fd14fe64/LICENSE)
- [codex-lb license and project maturity](https://github.com/Soju06/codex-lb/blob/72630bbfeee9e3b0d9acfb95e2b1e706b8b0188e/pyproject.toml)
- [Official Codex repository license](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/LICENSE)

**Scope:** Source-level audit only. No project was installed, copied, or run; no account credential, auth state, quota, or provider request was accessed.

## Applied increment

Following the audit, `CodexProfiles.eligibleProfiles` ranks eligible candidates by their most-used reported quota window, with a stable ID tie-break. Invalid freshness limits and snapshots dated in the future are rejected. This preserves the existing unknown/exhausted quota checks and persisted thread ownership; it does not reserve a slot, select an account for an existing thread, or launch a worker. The implementation is local policy inspired by the audit, not vendored OpenCodex code.

A separate, bounded Claude Code review completed in one turn for a reported $0.055281. That reviewer had no source-reading tools: its package-specific suggestions are advisory and are superseded by this source audit. Its useful acceptance criteria are concurrent account isolation, crash reconciliation under the same account, and refusal to move an existing thread to another account.
