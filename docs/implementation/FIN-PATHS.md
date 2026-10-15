# Canonical ROTOXY supervision and Oracle state paths

New supervision, recovery, and Oracle state uses `~/.local/state/rotoxy`. The
runtime checks known persisted files under both that root and the former
`~/.local/state/token2oauth` root. If only legacy state exists, it continues
using that root; if canonical state already exists it wins; if neither exists,
new state is created only at the canonical root. Explicit TypeScript and
Python paths are preserved exactly. No data is copied, moved, deleted, or
opened outside temporary test directories during this change.

`runtimeStatePath()` is the Node path selector used by the supervisor runtime,
Oracle MCP tools, command workspace snapshot, and admin Oracle page. The
standalone Python `OraclePool` applies the same known-state preference for its
implicit paths. Its explicit `config_path` / `db_path` arguments remain exact.

## Rollout

The root integrator should stop the relevant services, back up both state
roots, inspect which databases are authoritative, and schedule a separately
reviewed migration. This branch deliberately preserves legacy files in place;
remove old state only after the new location is verified and all workers have
reopened successfully. Do not start production services as part of code review.

Focused checks: TypeScript build, path migration tests, workspace path assertions,
and `supervisor.tests.test_oracle_pool` (including isolated HOME cases). No
provider calls or real state directories are used by these tests.
