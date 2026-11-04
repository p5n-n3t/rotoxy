# Exact legacy slot retirement — 2026-11-04

Three blocked, dispatched legacy workspace tasks retained local scheduler slots
after their provider was retired. They reduced the global seven-slot ceiling to
two usable positions alongside two unrelated Cloudflare ambiguities. This was
capacity retention, not proof that five provider workers were still executing.

The operator's approved retirement scope was applied through an exact private
manifest. Preview bound job/task/account/generation, body hash, attempt identity
and mutable status into a digest. Every selected row was a retired legacy
existing-session/fresh task, blocked and unreleased, with no queued or claimed
operation. Agent and inference modes are excluded by the utility.

`scripts/retire-legacy-slots.py` defaults to preview. Apply requires its matching
digest and an existing owner-private backup directory. It creates a consistent
SQLite backup and SHA256 journal, revalidates under BEGIN IMMEDIATE, then changes
only selected task/attempt release timestamps and provider_status, and appends
provider_retired audit events. It does not mark tasks successful, change assignment
state/dependencies, erase results/model data, or release unrelated inference work.

Applied result: exactly3 local reservations released; backup hash verified; both
unrelated Cloudflare ambiguity records compared equal before and after. Private
manifest/preview/applied receipts are in the operator configuration and verification
directories. Backup and journal are under
`~/.local/state/rotoxy/releases/retired-legacy-slots-20261104/`.

Five focused utility tests passed, covering private-file/ID guards, preview
nonmutation, stale digests, backup readability/hash, transactional revalidation,
repeat refusal without duplicate events and preservation of mixed Cloudflare work.
This is a reversible reservation retirement, not the full historical-record purge.
Do not restore the entire SQLite backup over newer unrelated work. For recovery,
stop dispatch and compare exact target generations/accounts and provider_retired
markers with the journal before restoring only those rows under a transaction.
A restored reservation must never automatically relaunch the retired provider.
