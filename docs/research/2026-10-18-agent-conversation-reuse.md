# Reusing open-source agent conversation UI patterns

Verified 2026-10-18 against project GitHub repositories and official docs. ROTOXY already combines a Node 22+ TypeScript/Express service and Python Snooze supervisor; its existing supervisor UI is built into that app. Current repository overview: [ROTOXY README](https://github.com/p5n-n3t/rotoxy/blob/main/README.md).

## Recommendation

Build the conversation and intervention surface into the existing ROTOXY/Snooze UI and APIs. Use **Termany** as the product-pattern reference for multi-bot group conversations, named bot identity, `@` routing, topic-scoped transcripts, lead delegation, and permission attention. Its exact name is **Termany**, at [termany.sh](https://termany.sh/) and [thinkany-ai/termany](https://github.com/thinkany-ai/termany), not “Termany.sh” as a project name. Termany is an independently runnable React + xterm.js/Tauri app with a Node PTY/API backend; importing it would bring terminal, storage, agent-runtime, and desktop assumptions ROTOXY does not need. It is licensed AGPL-3.0, and its README says modified network deployments must offer users source (commercial licensing is separately offered). Treat it as a design reference unless the project intentionally accepts those integration and licensing obligations.

For an incremental implementation, keep ROTOXY’s current UI and event ownership, borrowing:

1. Termany’s visible interaction model: persistent bot identity, group participants, explicit lead/recipient, topic boundaries, live “working / needs attention” status, and permission requests.
2. AG-UI’s event vocabulary and streaming conventions where they map cleanly to the existing Node/Python boundary. AG-UI is a protocol and integration layer, not a ready-made multi-agent chat product.
3. AgentsView’s session-tree, transcript, and handoff presentation for an optional read-only activity/history view. Do not treat its imported coding-agent transcripts as a live dispatch/control plane.

This reuses behavior and protocol patterns without replacing either runtime. Expose one ROTOXY-owned conversation/event API to the existing UI; let Node own browser-facing stream and conversation records while Snooze continues to own durable job/supervisor state. Preserve explicit control boundaries: UI actions request pause/approval/stop through current policy APIs and display provider-side outcomes separately from local supervisor state.

## Candidates

| Project | License and runtime | Reusable value | Fit for ROTOXY |
|---|---|---|---|
| [Termany](https://github.com/thinkany-ai/termany) | AGPL-3.0; React + xterm.js UI, Tauri desktop wrapper, Node PTY/API server and ACP bridge. | Closest match to live multi-agent interaction: group Bots, roles/identity, lead coordination, direct `@` routing, topics, and permission attention. | **Best behavior reference; weak drop-in.** Standalone terminal product and its backend/runtime assumptions create substantial rewrite/integration and AGPL network-source obligations. Reuse concepts; assess individual code only after licensing review. |
| [AG-UI](https://github.com/ag-ui-protocol/ag-ui) | MIT; open event-based protocol, with framework integrations and examples across TS/JS and Python agent frameworks. | Standard event patterns for run lifecycle, text streaming, tool calls/results, state snapshots/deltas, and human-in-the-loop interruption/continuation. Its Dojo examples are intentionally small. | **Best low-rewrite technical pattern.** Adapt event types at ROTOXY’s existing API/stream boundary; do not rebuild around CopilotKit or adopt another orchestration runtime. Multi-agent identity, group-chat policy, and durable control remain app responsibilities. |
| [AgentsView](https://github.com/kenn-io/agentsview) | MIT; Go daemon/API with SQLite archive and web/desktop UI; imports many coding-agent session formats. | Strong session browser, tree/child-session representation, live session-list updates over SSE, searchable transcripts, and markdown handoff including descendants. | **Useful read-only history reference.** Separate product and Go stack; it archives and displays agent sessions rather than providing ROTOXY’s live delegation, intervention, or scheduler control. Avoid importing its daemon or duplicating its archive. |
| [AutoGen Studio](https://github.com/microsoft/autogen/tree/main/python/packages/autogen-studio) | MIT repository; Python/FastAPI backend and Gatsby/Tailwind web UI, tied to AutoGen. | Prototype patterns for composing agents/workflows and inspecting multi-agent runs. | **Do not adopt as a product base.** Official README explicitly calls Studio a research prototype, not production-ready, and says AutoGen is in maintenance mode. It replaces rather than complements ROTOXY’s existing supervision model. Useful only for workflow-editor ideas. |

## Practical reuse boundary

- **Reuse at the UI/pattern level:** Termany’s participant/topic/group-chat model; AgentsView’s transcript hierarchy and handoff affordances.
- **Reuse at the protocol level:** AG-UI event names/shapes selectively, with a mapping layer to ROTOXY’s existing job, worker, and intervention events. Keep a ROTOXY extension for task IDs, bot identity, approval state, and supervisor state.
- **Do not adopt a second runtime or database:** AutoGen Studio and AgentsView each bring their own runtime/archive. Termany brings its own terminal/session manager. The existing Node service and Snooze event store already form the local system boundary.
- **Do not label a provider action completed on a UI request alone:** stream request accepted, supervisor state changed, and provider process/action confirmed as separate observable events.

## Primary sources

- Termany README and license: https://github.com/thinkany-ai/termany (AGPL-3.0; multi-bot sections; architecture and build details).
- AG-UI repository and MIT license: https://github.com/ag-ui-protocol/ag-ui
- AG-UI event specification: https://docs.ag-ui.com/concepts/events
- AgentsView repository and MIT license: https://github.com/kenn-io/agentsview
- AgentsView usage docs (SSE session updates and descendant session export): https://github.com/kenn-io/agentsview/blob/main/docs/usage.md
- AutoGen Studio README and explicit prototype/maintenance guidance: https://github.com/microsoft/autogen/blob/main/python/packages/autogen-studio/README.md and https://github.com/microsoft/autogen/blob/main/README.md

All links checked 2026-10-18. License labels reflect each repository’s stated project license; review bundled assets/dependencies and any AGPL obligations before copying code into ROTOXY.
