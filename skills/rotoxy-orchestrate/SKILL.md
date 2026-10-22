---
name: rotoxy-orchestrate
description: Delegate project work through a connected ROTOXY MCP gateway, track durable jobs and worker incidents, and collect reviewed artifacts across eligible resources.
---

# ROTOXY orchestration

Use the client's configured ROTOXY connection. Never read another client's tokens or treat an admin password as a bearer token. Inspect discovered tool schemas: permissions and installed adapters determine available operations.

## Discover before dispatch

Call `workspace_projects`, then `workspace_snapshot` for the authorized project. Read `job_workers` and `job_inbox`; use `oracle_catalog` when available. An empty project list requires an administrator's access grant. Do not use a different project's authorization. Registered models and idle sessions do not prove quota or usable execution capacity.

## Plan useful parallel work

Break the objective into independent, verifiable tasks and dependencies. Give each task explicit file ownership, inputs, acceptance criteria and an artifact destination. Use isolated branches or sandboxes for concurrent edits. Pick the cheapest demonstrated capable resource; reserve frontier reasoning for hard decisions. Distribute comparable work fairly across eligible accounts, subject to affinity, capacity and budget. Do not fill slots without useful work or split every task equally regardless of capability.

## Submit and retain control

Use `workspace_dispatch` for a bounded job DAG connected to the collaboration ledger, or `job_submit` when collaboration is unnecessary. Use one stable idempotency key per intended submission. Follow the exact tool schema: the current LightSprint job contract supports existing sessions, not arbitrary automatic session creation. Use Oracle submission tools for eligible inference tasks; do not claim they share the LightSprint scheduler unless the gateway explicitly reports that capability.

Record project, job and worker IDs before yielding. Record requested and provider-reported models separately. Workspace messages are durable collaboration records; they do not themselves deliver native LightSprint instructions or launch agents.

## Supervise and reconcile

Read `job_status`, `job_results`, `job_inbox` and `workspace_sync` as applicable. Let the persistent backend poll; do not keep an LLM running as a timer. Inspect provider errors independently of state: `ACP_RELAY_DIED` is a failure even when the session says idle. Idle is not verified completion. Retrieve and validate the requested output or artifact before completing a task.

If the discovered `job_control` schema supports `reconcile_task`, an authorized owner may request observation of a blocked or ambiguous original execution using its `jobId`, `taskId` and current `expectedRevision`. Read status first. This does not resend instructions, release ownership, change sessions, reset the original monitoring deadline or restart the worker. Re-read status/results afterwards; a queued observation is not completion. Do not retry automatically on stale revision or missing evidence. Older deployments may lack this action; use the documented operator handoff rather than inventing a tool.

For native approvals or questions, use only discovered supported actions within the operator's permissions. Otherwise preserve an actionable handoff. Do not replay an ambiguous mutation or restart a failed paid session blindly. Acknowledge a specific inbox event after recording its disposition; acknowledgement does not fix a worker.

Use `workspace_update` for attributed messages, artifact submission and review decisions, with the current revision and idempotency key. Review approval does not merge a PR. Keep routine updates compact and escalate decisions with the relevant task, account, reported model and evidence.

## Handoff

Before ending, leave the objective, job IDs, validated artifacts, outstanding incidents and exact next action in the project ledger/checkpoint. Desktop notification delivery does not wake a dormant chat. Claim automatic recovery or resumption only when that adapter is configured and its execution receipt is verified.
