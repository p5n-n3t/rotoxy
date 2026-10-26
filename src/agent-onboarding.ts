export const ONBOARDING_TOOL_NAME = "rotoxy_guide" as const;

const TOPICS = ["start", "dispatch", "recovery", "providers", "collaboration"] as const;
export type OnboardingTopic = typeof TOPICS[number];

export class OnboardingInputError extends Error {
  constructor(message: string) { super(message); this.name = "OnboardingInputError"; }
}

export const ONBOARDING_TOOL_DEFINITION = {
  name: ONBOARDING_TOOL_NAME,
  description:
    "Read the ROTOXY gateway guide for agents. Returns concise guidance for the requested topic. " +
    "Available topics: start, dispatch, recovery, providers, collaboration. Omit topic for an overview.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: [...TOPICS],
        description: "Guide section to read (start | dispatch | recovery | providers | collaboration). Default: start.",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

// Guide version: v1. Content refers only to gateway behaviour and invariants.
// No runtime account identifiers, credentials, balances, model names, or slot claims.
const GUIDE: Record<OnboardingTopic, string> = {
  start: `ROTOXY gateway guide v1 — start

## Overview
ROTOXY is an MCP gateway that pools upstream credentials, enforces tool policy, and provides durable agent-coordination tools when a supervisor is configured. One gateway instance can be shared across multiple client folders and machines.

## ROTOXY Fleet access
ROTOXY has one provider Fleet that can serve authorized clients from different folders and machines. A repository or project identifier is task context for a job, audit trail, budget, and artifact ownership; it does not make a second provider pool. Your token sees only Fleet or task-context records authorized for its client ID. Folder names never grant provider access automatically.

## Canonical flow
1. Call tools/list — see every tool authorized for your token.
2. Call workspace_projects when it appears in tools/list, then use only an authorized Fleet or task-context ID. A Fleet configured for authenticated MCP membership admits a valid OAuth-connected MCP client automatically; no repository-specific grant is needed. If the list is empty, the current gateway policy does not admit this client, so ask a ROTOXY administrator to check Fleet access and reconnect. Do not assume access or use another client's authorization.
3. Discover current account health and capacity via live discovery tools. Idle sessions and registered accounts do not prove quota or usable capacity.
4. Split the objective into independent bounded tasks; assign explicit file or record scope keys, inputs, acceptance criteria, and an artifact destination to each task.
5. Submit with workspace_dispatch (DAG + ledger) or job_submit (simple jobs). Always use a stable idempotency key.
6. Read job_status, job_results, and job_inbox. Validate all artifacts before reporting completion.
7. Leave an actionable checkpoint in the project ledger before yielding.

## Key invariants
- Backend controls are authoritative. Tool schemas define what is supported; ignore unverified capability claims.
- Discover before acting. Do not infer quota, capacity, or project access from static assumptions.
- Call rotoxy_guide with topic=dispatch, recovery, providers, or collaboration for detailed guidance.`,

  dispatch: `ROTOXY gateway guide v1 — dispatch

## Submitting jobs
Use workspace_dispatch for a bounded job DAG connected to the collaboration ledger. Use job_submit when collaboration overhead is unnecessary. Both require an authorized projectId from workspace_projects.

## Idempotency
Assign one stable idempotency key per intended submission. Reusing the same key on a retry of a prior successful submission returns the existing result without launching a new job. Generating a new key on each retry creates duplicate jobs. Read current status before deciding to retry.

## Model and effort pins
Use model or effort fields only when the advertised tool schema supports them and the job's authorized routing policy permits them. Record requested and provider-reported values separately. Do not assume the provider honored a request or that a listed model is entitled for the account.

## Quota states
quota_unknown — the gateway has not yet observed this account's quota state. It is not depletion, but the configured budget policy may still exclude or limit it.
quota_depleted — the account is confirmed exhausted for the billing period. Exclude it from new submissions until quota resets.
Discover current account states via live discovery tools. Never rely on previously cached or assumed values.

## No blind mutation retry
Do not automatically replay a tools/call whose outcome is ambiguous (network reset, timeout, no confirmation). Read job_status first. If the status is inconclusive, use the documented operator handoff rather than resubmitting. An ambiguous call may have already executed a paid action.

## Scope ownership and budgets
Assign explicit path: or record: scope keys to every task before submission. Distribute comparable work fairly across eligible accounts subject to affinity, capacity, and budget. Reserve high-capability capacity for decisions that require it; do not fill slots with trivial work.`,

  recovery: `ROTOXY gateway guide v1 — recovery

## Idle ≠ completed
A session state of idle does not confirm task completion. Inspect provider errors and retrieve the requested output artifact before marking a task complete. Idle is an intermediate state, not a success state.

## ACP_RELAY_DIED overrides idle
If job_status or job_inbox contains ACP_RELAY_DIED for a session, treat the execution as failed regardless of the session state field. The relay failure is a definitive error and takes precedence over the session's idle label.

## Original-session observation (reconcile_task)
If the discovered job_control schema advertises the reconcile_task action, an authorized task owner may request observation against the original session using the task's jobId, taskId, and current expectedRevision. This does NOT:
  - Resend task instructions to the worker
  - Release or transfer task ownership
  - Change or restart the session
  - Reset the monitoring deadline
Re-read job_status and job_results after queuing the observation; a queued reconcile_task is not a completion signal. Do not use reconcile_task when the gateway does not advertise it — older deployments lack this action. Do not retry automatically on a stale expectedRevision or missing evidence; read the latest status and preserve a handoff for human review.

## Dormant chat
Desktop notifications do not wake a dormant chat session. A workspace message recorded to a dormant participant is a ledger entry, not a wakeup. Do not assume notification delivery equals participant activation.

## Operator handoff
When automatic recovery is not configured and verified, preserve an actionable handoff: objective, all job/task IDs, validated artifacts, outstanding incidents with evidence, and the exact next action for the resuming agent.`,

  providers: `ROTOXY gateway guide v1 — providers

## Ledger messages ≠ native provider delivery
workspace_update messages and job_inbox entries are durable collaboration records inside ROTOXY. They do not themselves deliver instructions to a native provider or launch agents. A provider executes only when a job is submitted with an active session or provider connection.

## Dormant chat notifications ≠ wakeup
Recording a message to a participant's inbox does not wake a dormant provider chat. Wakeup requires the provider's own notification mechanism and a live session.

## Quota states
quota_unknown — the gateway has not observed this account's quota state yet. It is not depletion, but the configured budget policy may still exclude or limit it.
quota_depleted — the account is confirmed exhausted for the billing period. Exclude it from new submissions.
Use live discovery tools for current account states. Do not use cached or assumed quota values.

## Model and effort pins
When the provider supports explicit model or effort selection, use only values permitted by the advertised schema and authorized routing policy. Record the requested value and provider-reported value separately. Do not assume the provider honored a request or that a listed model is entitled.

## Backend controls are authoritative
Gateway enforcement (tool policy, account status, quota, scope) overrides any in-task assumptions. If the gateway rejects a submission or marks an account unavailable, accept that state and route accordingly. Do not bypass gateway decisions based on out-of-band information.`,

  collaboration: `ROTOXY gateway guide v1 — collaboration

## Scope ownership
Assign explicit path: or record: scope keys to every task before submission. Concurrent tasks must not share write scope over the same files or records without explicit coordination. Use isolated branches or sandboxes for parallel edits across accounts.

## Budgets and fair distribution
Distribute comparable tasks fairly across eligible accounts subject to affinity, capacity, and per-account budget. Do not route all work to a single account. Use live discovery to check current account health and capacity; do not rely on stale snapshots for budget estimates.

## Idempotency
Use one stable idempotency key per intended logical operation. Do not generate a new key when retrying a call whose outcome is uncertain — read current status first. Idempotent calls with the same key return the existing result without repeating side effects.

## Review approval ≠ git merge
A review_decide approved decision records the reviewer's artifact approval in the workspace ledger. It does NOT merge a PR, push code, or trigger any external CI or deployment action. External follow-up steps require separate, explicit tool calls.

## Acknowledgement ≠ fix
Acknowledging a job_inbox event (job_inbox_ack) records that the event was received and dispositioned. It does not fix the underlying worker or session issue. Address the root cause separately before relaunching.

## Handoff
Before yielding control, record in the project ledger:
  - Objective and current state
  - All job and task IDs
  - Validated artifact references
  - Outstanding incidents with evidence
  - The exact next action for the resuming agent

An actionable handoff is the only reliable recovery mechanism when automatic resumption is not configured and verified.`,
};

export function callOnboardingTool(args: unknown): string {
  if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
    throw new OnboardingInputError("arguments must be an object");
  }
  const a = (args ?? {}) as Record<string, unknown>;
  const extra = Object.keys(a).filter((k) => k !== "topic");
  if (extra.length) throw new OnboardingInputError(`unknown argument: ${extra[0]}`);
  if (a.topic !== undefined && !TOPICS.includes(a.topic as OnboardingTopic)) {
    throw new OnboardingInputError("topic must be one of: " + TOPICS.join(", "));
  }
  return GUIDE[(a.topic as OnboardingTopic) ?? "start"];
}
