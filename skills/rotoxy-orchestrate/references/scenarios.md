# ROTOXY scenarios

Use these examples only after calling `tools/list`; tool names and fields are
authoritative only when the connected gateway advertises them.

## A new agent in an arbitrary repository

1. Authenticate its own client through the gateway's supported OAuth flow.
2. Call `rotoxy_guide` with `{"topic":"start"}` and then `tools/list`.
3. If `workspace_projects` is available, list projects and select an ID returned
   for that client. A folder name is not a project ID and does not create access.
4. If no project is returned, stop. An administrator must grant the client
   membership through the configured administrative path; another client's token
   must never be reused.

## A bounded parallel coding task

1. Read the guide's `dispatch` and `collaboration` topics.
2. Define independently reviewable tasks with non-overlapping `path:` scope keys,
   expected artifacts, dependencies and one stable idempotency key per operation.
3. Use `workspace_dispatch` only if the connected gateway advertises it. Give the
   authorized project ID and routing constraints supported by its schema.
4. Read durable status, results and inbox events. Verify each artifact before
   reporting success. A recorded review approval never merges code.

## A worker that looks idle

1. Read the `recovery` topic and current job status/inbox data.
2. Treat provider errors such as `ACP_RELAY_DIED` as failure even if a provider
   shows an idle state.
3. If the advertised control schema supports observation/reconciliation, use it
   only on the original task with its current revision. Do not replay an ambiguous
   paid operation or create a duplicate session.
4. Preserve an actionable handoff when recovery is not configured and verified.

## Picking providers and models

1. Read the `providers` topic and discover the live catalog and account state.
2. Respect tool schemas, account affinity, policy, budget and provider-reported
   availability. Catalog presence is not entitlement or execution proof.
3. Record requested and provider-reported model values separately. Do not claim a
   requested model ran unless the provider reports it.
