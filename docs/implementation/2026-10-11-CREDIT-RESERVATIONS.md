# Numeric credit reservation ledger

`supervisor/snooze/credit_ledger.py` provides a standalone, fail-closed SQLite API for account-scoped credit reservations. It is not connected to task admission or provider dispatch. Until that hook exists, this is an implementation component and does not prevent spending.

## Accounting contract

- Each verified snapshot is scoped by `user_id`, `provider`, `account_id`, opaque `unit`, and explicit `cycle_id`. Snapshot date and source are retained. A new month or a later date never creates a balance; a caller must submit a verified snapshot and cycle explicitly.
- Credits and USD cents are separate integer units. The module performs no conversions or estimates. A task is admitted only with a verified positive integer upper bound and its source; an unknown or unverified bound is denied.
- `reserve` takes `BEGIN IMMEDIATE`, checks the account snapshot and cycle, then computes available funds as snapshot balance less post-snapshot active reservations and settlements. Its operation ID is globally unique and replay returns the existing reservation only if its identifying fields match.
- Active reservations survive ambiguous outcomes and prevent replacing the account snapshot, including on a cycle change. Only a known preexecution refusal can release a reservation. Settled usage replaces its hold with the actual integer amount. Usage above the reserved bound records a violation and freezes the account. Exhaustion also freezes it; a verified snapshot can renew a depleted account. A violation freeze requires explicit `acknowledge_violation=True` on a verified snapshot to clear.
- Writers serialize in SQLite, so competing reservations cannot jointly exceed the recorded balance. A local ledger cannot enforce a provider-side maximum if the upstream provider accepts work beyond the submitted bound.

## Python API for the runtime hook

```python
from snooze.credit_ledger import CreditDenied, CreditLedger

ledger = CreditLedger(state_dir / "credit-ledger.sqlite")
ledger.set_snapshot(
    user_id="...", provider="...", account_id="...", unit="credits",
    cycle_id="provider-reported-cycle-id", balance=1234,
    snapshot_date="2026-10-11T12:00:00Z", source="exact verified provider field",
    verified=True,
)
reservation = ledger.reserve(
    user_id="...", provider="...", account_id="...", unit="credits",
    cycle_id="provider-reported-cycle-id", operation_id="stable-operation-id",
    cost_upper_bound=25, bound_verified=True, bound_source="verified task cost contract",
)
```

On a known preexecution refusal call `release_refused(operation_id, known_preexecution_refusal=True)`. For uncertainty, retain the row with `mark_ambiguous(operation_id)`; do not release it. Once usage is reported in the same unit, call `settle(operation_id, actual_usage=...)`. `CreditDenied` must block dispatch. Callers must use a stable operation ID across retries and must not invent a `bound_source` or treat prompt counts, `budgetUsed`, entitlement, or session cost as credits.

The module is Python-only. A Node supervisor integration requires a reviewed, durable bridge to this API (or an equivalent Node SQLite implementation); none is supplied here. No LightSprint numeric debit or task maximum was available to establish a provider hard ceiling. Therefore neither this module nor its tests claim final hard spending prevention.

## Verification

Run from `supervisor/`:

```sh
python3 -m unittest tests.test_credit_ledger -v
```

The focused suite covers serialized concurrent writers, reservation replay, fail-closed bounds/snapshots, ambiguous holds, safe refusal release, settlement violations, depletion/renewal, snapshot rebasing, and unit isolation.
