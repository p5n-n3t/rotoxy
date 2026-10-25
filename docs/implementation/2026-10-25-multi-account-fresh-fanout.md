# Multi-account fresh LightSprint fan-out

**Date:** 2026-10-25  
**Status:** implemented and locally verified

## Change

A distributed job can now assign its independent fresh tasks across multiple
explicitly verified LightSprint account/workspace/stack bindings. Assignment is
deterministic round-robin within each requested provider category. Every task
carries its own immutable `execution.accountId`, `workspaceId`, `stackId`, and
`provider` into the durable bridge.

The Python scheduler treats that account ID as a hard constraint. It cannot
claim a task on another account, and the operation factory checks the exact
account/workspace/stack/provider tuple again before a provider mutation.

## Boundaries

This does not manufacture remote worker-slot capacity, a model/effort pin, a
live quota value, or task completion evidence. Those values remain provider
reported or unknown. It also does not launch a task by itself: a caller still
submits an authorized, bounded job.

## Verification

- TypeScript compilation succeeded.
- 51 focused Node tests passed, covering runtime submission, worker lifecycle,
  and binding administration.
- 72 Python scheduler tests passed, including distinct fresh task bindings on
  two accounts.
- `git diff --check` passed.

The worker concurrency test now has a bounded five-second wait and always
stops its background worker in `finally`, preventing a failed assertion from
leaving a test process alive on a busy host.

## Multiple provider categories per account

A fresh-binding key is now `(accountId, provider)`, rather than account alone.
The administrative page verifies and removes each provider category separately.
This permits an account to retain independently verified Claude and Codex launch
paths where the upstream supports them. It does not assume that the two paths
are equivalent, and it does not activate an additional path without its own
read-only verification.
