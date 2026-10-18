# ROTOXY recovery checkpoint — 2026-10-18

## Runtime recovery

Launch failed because an unclean shutdown left a private supervisor Unix socket that refused connections. The bridge previously rejected every existing pathname. Recovery now checks socket type, ownership, mode, connection refusal, and inode identity before removing a stale socket; active or untrusted paths remain protected. The production stale socket was preserved as a private backup before startup. Gateway, pool, monitor, and root Funnel started successfully. Public `/healthz` reports 13 accounts, 12 selectable.

## Agent conversation

Conversation feed merges persisted messages and activity, offers task filtering and pause, and preserves drafts during refresh. Send-time sender metadata is persisted as participant-reported provenance; legacy messages remain unknown. Numeric backend timestamps and recipient field aliases are supported. Saved workspace messages remain ledger records, not evidence of native provider delivery. Live guidance remains a separate supervised operation.

SQLite-consistent and module backups were created before installation under the private release-backup directory. Startup and conversation modules are installed; browser visual verification remains outstanding because browser control was unavailable in this session.

## Workforce

ORA7 was added through the configurable host registry with the same three downloaded models, verified by SSH: qwen3.5:9b, gpt-oss:20b, tev1:0.8b. Five hosts are configured; global dispatch cap increased from three to five, one task per host. Catalog refresh encountered transport timeouts on four hosts; do not treat configuration as execution proof.

All 12 enabled LightSprint accounts passed authenticated repository enumeration. Eleven returned workspace boards; one read timed out. Existing supervisor configuration limits monitoring to four account IDs and maxWorkers=4. Expanding that requires verified session mappings rather than merely raising a number. Four existing owned gpt-6-luna sessions accepted independent read-only reviews and were observed running concurrently. Durable private batch records are in `~/.local/state/rotoxy/batches/20261018/`. Do not launch duplicate reviews on resume; inspect their receipts/results first. No purchases or top-ups.

## Verification and next actions

TypeScript build passed. Local focused Node suite passed 30 tests; workspace Python suite passed 9. Remote suite exposed a test assertion that incorrectly assumed socket inode numbers cannot be reused; assertion corrected and bridge rerun pending at checkpoint creation.

Next: inspect bounded cloud review results, finish Oracle transport checks, expand verified session mappings and safe useful fanout, validate conversation visually when browser control is available. ACP research is optional integration guidance, not implemented capability. Keep at most two native agents including coordinator.
