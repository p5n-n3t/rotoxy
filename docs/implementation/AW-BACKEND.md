# Agent Workspace backend handoff

This branch adds the TypeScript AW1 boundary in `src/agent-workspace.ts`. `AgentWorkspaceService` accepts only projects listed by the configured `SupervisorBackend`, forwards a validated trusted actor and bounded request to the private Python module, and checks the returned snapshot envelope. The bridge uses `/usr/bin/python3 -m snooze.agent_workspace --db <absolute-store-path>`, runs from the embedded `supervisor/` directory, sends one JSON document on stdin, ignores stderr, and caps runtime at 10 seconds and stdout at 512 KiB. Tests inject the runner and do not invoke a provider or depend on the Python implementation.

`createAgentWorkspaceRouter(store, sessions, service, renderer?)` provides the admin project selector, snapshot endpoint, and CSRF plus same-origin protected update endpoint. It binds `admin:local` itself; request bodies cannot choose the actor or project. Pass an optional renderer when the Agent Workspace UI module is ready. Without one, the project view deliberately shows a small escaped snapshot placeholder. The factory does not mount itself or grant MCP access.

Root integration seams:

- Mount the router with the existing admin app and pass the configured supervisor backend to the service. The Python module `snooze.agent_workspace` must implement the AW1 SQLite transaction, ownership, revision, action and snapshot rules before these routes can serve durable records.
- At the verified OAuth/MCP boundary, call `SupervisorRuntime.authorizeWorkspace(projectId, clientId)` first, then call the service with `actor: "client:" + verifiedClientId`; never accept actor from tool input. Use the exported `AW_TOOL_DEFINITIONS`, `validateAgentWorkspaceToolArguments`, `isAgentWorkspaceToolName`, and `awRequiredScope` for the two workspace tools.
- This layer does not start jobs, invoke providers, access GitHub, merge changes, or assert that labels/models/accounts are verified. Those remain separate root responsibilities.

Focused coverage lives in `test/agent-workspace.test.mjs`: isolated state paths, exact subprocess envelope and limits, project/actor/input checks, tool scope/schema helpers, admin authentication, CSRF/origin checks, project confinement, and actor binding. Run `npm run build` followed by `node --test test/agent-workspace.test.mjs`.
