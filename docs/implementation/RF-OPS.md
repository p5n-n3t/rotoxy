# Oracle operations page

The Oracle snapshot boundary now accepts bounded configured and historical host IDs and model IDs rather than a compiled host/model enum. It rejects malformed host/model values and oversized host/model/task/event collections before rendering. The page lists all snapshot hosts in a wide, scrollable fleet table, shows exact catalog names, catalog check time/state, configured/enabled state, and explicit `Provider: Unknown` where the snapshot has no provider field. Task rows show requested and reported model independently.

The fleet table reports persisted assigned/completed/running counts. Per-host completion and error counts are computed only from the currently visible task page and labeled as a page sample. Current `snooze.oracle_ops` output has no per-host slot-capacity denominator, so capacity utilization is explicitly unknown; no percentage or SSH health is inferred. Assignment shares keep their existing persisted denominator semantics.

The renderer keeps the active sidebar navigation unchanged and provides contextual links to `/admin/oracle/fleet`, `/admin/oracle/models`, and `/admin/services`. Server and global navigation wiring remain root-owned. No Python changes or live catalog, SSH, or inference calls are part of this branch.

Verification: `npm run build` and `node --test test/oracle-ops.test.mjs` pass (7/7), including a fourth custom host/model, malformed snapshot rejection, unknown provider/capacity labels, model attribution, escaping, and responsive wide-table markup.
