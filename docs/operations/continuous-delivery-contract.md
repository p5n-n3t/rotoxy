# ROTOXY continuous-delivery contract

This repository is a long-running product build. A narrow commit, focused test pass, provider probe, or progress summary is a checkpoint, not a reason to stop the overall delivery.

## Product model

ROTOXY is one **ROTOXY Fleet**: its providers, authorized accounts, routing policy, durable supervision, and worker records are shared by authorized clients. A repository, folder, or project identifier is **task context**. It isolates a job's owner, scope, budget, artifacts, and event history without creating another account pool by default.

The compatibility `projectId` may remain `token2oauth` in machine calls and persisted records. UI and agent-facing guidance use **ROTOXY Fleet**. Do not migrate the durable identifier without a backup, a compatibility plan, and verification of OAuth grants, jobs, and session ownership.

## Required execution behavior

1. Recover current state from Git, current handoffs, durable records, and relevant memory before changing code.
2. Continue through implementation, targeted validation, integration, and documentation after each checkpoint.
3. Create concise durable checkpoints at meaningful phase boundaries, including the next concrete action and test evidence.
4. Do not claim a provider operation completed until its expected artifact or provider-confirmed result is retrieved and reconciled.
5. Keep account credentials, raw prompts, browser sessions, and private provider output out of checkpoints and memory.

## Legitimate stopping boundaries

Stop only for a required interactive OAuth/login step, a material external deployment or data migration awaiting review, an unapproved billable dispatch, a destructive action, or a blocker that cannot be resolved from source and existing evidence. Before that boundary, prepare the exact change, validation, and rollback path so the decision is reviewable.

## Agent compatibility

Local Codex agents can use the `rotoxy-continuous-delivery` skill. Other MCP clients may not load local skills, so the portable `rotoxy_guide` MCP tool remains the canonical operating guide. Clients should call `rotoxy_guide` and `workspace_projects` at connection time, then preserve their authorized project/fleet ID for subsequent calls.
