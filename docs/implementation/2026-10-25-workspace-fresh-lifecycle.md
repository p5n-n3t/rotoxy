# Workspace-scoped fresh LightSprint lifecycle checkpoint — 2026-10-25

## Objective

Make a fresh LightSprint worker launch use the provider's currently documented
workspace-scoped API, while preserving durable Snooze scheduling and the
no-replay rule for ambiguous provider mutations.

## Source state

Commit `51dc5d6` adds a closure-bound workspace adapter. A fresh binding now
requires all four operator-supplied identifiers:

- account ID
- workspace ID
- stack ID
- provider selector

The scheduler persists that binding through task creation, instruction patch
and read-back, session launch, and subsequent observation. The worker obtains
the provider task reference from `task.ref` when present, accepts a returned
session ID only after format validation, and records the upstream-reported
model as metadata. It does not infer a selected model or reasoning level.

Each claimed operation has an exact internal workspace permit. It permits only
the known request sequence for that operation and account/workspace pair.
An explicit policy denial still wins. The current path has no legacy root-route
fallback.

## Safety boundary

A launch response without a usable session ID becomes an ambiguous operation;
it is not retried. A task is not considered complete from an idle state alone.
Provider errors such as `ACP_RELAY_DIED` and native approval states remain
non-completion outcomes handled by the supervisor.

No production configuration was edited. No service was restarted. No provider
credential, paid task, or account quota was touched.

## Verification

- TypeScript build: passed.
- Focused Node worker, workspace adapter, and supervisor-runtime suites:
  58 passed.
- Focused Python durable scheduler suite: 71 passed.
- Full Node suite: 618 passed.
- `git diff --check`: passed before commit.

## Release status and next action

The local main branch contains `51dc5d6`. The installed gateway remains on
the earlier immutable release and is not evidence that this source change is
active. GitHub HTTPS reset twice while pushing; the remote ref was not
verifiable at this checkpoint.

Before enabling live fresh dispatch, configure each desired account with a
verified workspace ID and stack ID, then conduct one controlled launch whose
returned provider session ID can be retrieved and observed. Do not bulk fan out
until that exact end-to-end receipt is verified.
