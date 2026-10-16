# Connected Agent Workspace release evidence — 2026-10-16

**Status: useful connected-workspace milestone; the broader execution roadmap is not complete.** This report separates the deployed runtime evidence from the newer source/browser evidence so that tests, UI checks, and provider operations are not conflated.

## Current runtime and source evidence

The earlier runtime report identifies deployed source `70c03f6` at `https://jq-xubuntu1.bigeye-escalator.ts.net`, with root TLS port 443 routed to the gateway on port 2030. The gateway is one manually started, boot-off service. Root reports a full **416-test Node suite** and **336-test Python suite**, plus package-install and release verification, for that release.

The integrated candidate includes the task-first UI (`7090878`), fixed dispatch-readiness advisories (`6f7ceda`), and updated integration documentation. Its build and full **420-test Node suite** pass. Python code is unchanged from the 336-test baseline. The built-in desktop browser verified the task-first screen at 1280 × 720, a sidebar without internal scrolling, no horizontal overflow, and model/account attribution where participant metadata exists. A read-only localhost fixture injected a newer execution revision: the refresh button was initially hidden, became visible after polling, and preserved an unsaved draft. No task was submitted in that check. Earlier nine page/viewport checks cover the preceding UI baseline, rather than being claimed as a fresh mobile check for this candidate. The earlier package and test evidence establishes artifact/build behavior, while browser checks establish rendered UI behavior. Neither proves that a provider executed a paid task.

## Connected read-only evidence

Claude Code **2.1.300** OAuth connected successfully and reconnect was confirmed. A read-only headless session called `workspace_projects` and found one authorized project, then `workspace_snapshot` returned 10 tasks and 9 artifacts. Separately, a `lightsprint_api` GET to `/api/repos` returned seven repository records. Four successful turns have a **reported estimated usage of $0.0774339**; this is an estimate, not a verified charge or account balance. These calls demonstrate the connected read-only tools and their returned data, not paid workspace dispatch or unrestricted provider capability.

The failed Frontier attempt ended with `ACP_RELAY_DIED`. That session is retired from the dispatch registry/configuration and was not restarted; its history is retained.

## Delegation and readiness

Two economical LightSprint workers implemented readiness and documentation independently. Eleven paired observations reported both accounts running between 07:34:45 and 07:37:27 UTC on 2026-10-16, with `gpt-6-luna` reported by both. Combined reported session-cost increments were approximately $0.131; this is not a native-credit debit or a verified charge. Pushed branches and integrated artifacts were reviewed separately from the provider idle state.

Configured resources now display fixed reasons for a failed credit check, disabled/unhealthy accounts, or unavailable/malformed status. A passing credit check explicitly leaves live session readiness unchecked. This changes visibility, not the credit guard or dispatch authority.

The read-only public doctor returned healthy with OAuth issuer/resource/redirect and root Funnel checks passing. No paid operation was launched by that check; upstream/tool stages may use retained observations.

## Boundaries and remaining blockers

- Strict numeric credit admission is enabled, but there are zero enabled account policies and no verified native per-run cost ceiling. Generic paid job launch therefore remains blocked.
- Bounded private LightSprint code workers have run independently, but there is no production proof of paid workspace fanout. Oracle and Claude remain separate queues, not a heterogeneous scheduler.
- A workspace can represent an explicit task DAG; it does not automatically decompose work. Workspace review is an internal record, not provider-native approval or a GitHub merge.
- Dormant ChatGPT conversations are not awakened. A consumer login profile is not subscription-backed inference or automatic subscription rotation.

No credentials, private client/session/account identifiers, email addresses, or local user balances are included here. Do not describe the release as unrestricted orchestration, verified native credit accounting, or roadmap completion.
