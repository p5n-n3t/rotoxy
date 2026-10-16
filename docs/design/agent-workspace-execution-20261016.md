# Agent workspace execution context — 2026-10-16

The workspace snapshot can optionally report `executions` rows (`jobId`, `state`, `provider`, `taskCount`, `updatedAt`). The renderer treats those as bounded untrusted metadata, caps display at 50, escapes/redacts text, and labels unavailable fields as unknown. The compact Job executions strip links to the existing Supervisor and Jobs pages. If the array is absent, the page says execution rows were not included; an empty array says none were reported.

`executionResources` remain a separate closed-by-default disclosure because they describe configured LightSprint account sessions, not active workers. It shows the supplied account label/ID, model, session/workspace IDs, availability, and model source; missing values remain explicitly unknown. No provider call, launch action, availability probe, or billing control was added.

Task summaries are labeled as task descriptions; artifacts awaiting workspace review appear before already reviewed/completed artifacts so actionable work is easier to find. Workspace artifact decisions are labeled as workspace reviews. The review form states that approve/request-changes records an Agent Workspace decision only and does not approve provider-native requests or merge pull requests. Existing CSRF, revision, idempotency, nonce polling, and unsaved-draft protection remain unchanged.

Validation: focused `npm run build` and `node --test test/agent-workspace-ui.test.mjs`; tests cover the execution/resource snapshot shape, absent/unknown fields, escaping and credential redaction, review scope, existing form contracts, and nonce refresh behavior. Browser screenshots are owned by root integration.
