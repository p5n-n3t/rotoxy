# Oracle pool live review evidence

Three text-only reviews completed through the durable Oracle pool on 2026-10-11. Each used the live `qwen3.5:9b` model, at most 512 generated tokens, no tool contract, and one attempt. Prompts and full outputs remain in the private SQLite pool; this note contains only compact review findings and local checks.

| Task | Host | Status | Prompt / output tokens | Remote / elapsed seconds |
| --- | --- | --- | ---: | ---: |
| `review:20261011:credit-invariants` (`repo:policy.py`) | ora1 | complete | 222 / 262 | 168.37 / 172.08 |
| `review:20261011:supervisor-failure-cases` (`repo:scheduler.py`) | ora3 | complete | 214 / 165 | 171.66 / 174.70 |
| `review:20261011:ui-operational-hierarchy` (`repo:frontend-navigation`) | ora5 | complete | 207 / 129 | 102.82 / 106.93 |

The hosts were distinct in the same three-job claim; all reported the requested model as the actual model. The task records have `attempts=1`. Live catalogs on all three hosts contained `qwen3.5:9b`, `tev1:0.8b`, and `gpt-oss:20b`.

## Locally checked findings

- **Quota invariant:** the model incorrectly claimed that an expired quota is granted access. `Policy.evaluate` changes an expired quota to unknown, then denies unknown quota unless account or global `allow_unknown_quota` is explicitly enabled. Its separate unit-consistency concern is plausible but unproven: account quota overrides carry a `unit`, while the shown policy comparison uses numeric values and reserves without comparing units. Define whether those units must match before treating this as a defect.
- **Supervisor recovery:** the model's cross-replica/partition and silently-failed persistence claims are unsupported by the supplied code. The durable state update occurs before provider I/O; a failed database write would prevent reaching that I/O. One concrete operator question remains: when an adapter cannot reconcile an ambiguous attempt, `tick` reports `needs_reconciliation` on subsequent cycles. Confirm where operators complete that reconciliation and whether the UI makes the blocked state clear.
- **UI hierarchy:** the model correctly noticed that `App.svelte` renders both `HistoryPage` (bounded analytics) and `History` (legacy records) inside the same History navigation branch. The navigation otherwise separates Watch, Queue, Providers, History, and Settings. Give the two evidence surfaces explicit labels or decide which should be the canonical History page.

These are model-assisted review leads, not proof of a production defect. The false quota assertion and unsupported distributed-systems claims were discarded after checking the named source. No files were changed in response to model output.
