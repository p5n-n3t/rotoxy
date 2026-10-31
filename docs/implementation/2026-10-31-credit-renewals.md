# LightSprint credit readings and renewal schedule — 2026-10-31

## Recorded readings

User-reported used credits were compared with the 10,000,000-credit allowance; remaining is `max(0, allowance - used)`.

| Account | Used | Remaining | User-scheduled refresh |
| --- | ---: | ---: | --- |
| p0y50n | 20,680,000 | 0 | 2026-11-05 |
| itscommmena | 11,110,000 | 0 | 2026-11-11 |
| niandran | 11,220,000 | 0 | 2026-11-06 |
| ngilfordz | 10,370,000 | 0 | 2026-11-02 |
| jqleq | 10,860,000 | 0 | 2026-11-03 |
| jqthefoo | 124,173 | 9,875,827 | 2026-11-16 |
| l2thepete | 2,390,000 | 7,610,000 | 2026-11-03 |
| chupalopez | 2,240,000 | 7,760,000 | 2026-11-03 |
| maryjoebake | 36,204 | 9,963,796 | 2026-11-11 |
| elleparker (ell3) | 1,710,000 | 8,290,000 | 2026-11-03 |
| zhaddads | 1,690,000 | 8,310,000 | 2026-11-03 |
| joeyqleq | 1,960,000 | 8,040,000 | 2026-12-29 |

`ecummi16` was omitted and its prior reading and refresh date were left unchanged. The 5 depleted accounts are quota-paused. `joeyqleq` had only the legacy quota-depleted disable marker and a new positive reported balance, so its routing-enabled state was restored; the existing live supervisor view showed no dispatch binding for it.

These are user-reported readings and user-scheduled estimates. They are not provider-verified balances or renewals.

## Renewal policy

The private credit ledger stores each scheduled date as `user-scheduled-estimate`. The initialization pass, one-minute timer, and credits-page read reconcile dates in UTC. A date becoming due moves to `due-pending-verification`; it does not create a 10M snapshot, reset the strict credit ledger, or enable the account. The currently running service was not restarted, so the new timer takes effect when the parent integrates and deploys this code.

The admin page can record evidence for a due renewal. That transaction marks the schedule verified and records the verified-renewal audit entry. It re-enables routing only when the account carries `quotaDisabledBy=quota-policy`. A manual disable has no such marker and stays disabled. The supervisor's strict cost-bound admission remains unchanged.

This check remains verification-gated because strict supervisor job admission does not cover every generic LightSprint MCP gateway call. Automatically enabling all such calls from an estimated date would not prove that spending stays within the reported allowance. No jobs are replayed when a renewal becomes due or verified.

## Private state and rollback

Active private state is under `/home/jq/.config/rotoxy`:

- `credit-snapshots.json` — user-reported balance snapshots and scheduled renewal audit rows.
- `state.json` — account quota metadata and enabled state.

Both active files are owner-only. Before the first mutation, backups were created with mode `0600` in `/home/jq/.config/rotoxy/backups/credit-renewals-2026-10-31/`. `state.json` is the pre-reading backup; `state-before-joey-restore.json` captures the state after the new readings/pauses but before restoring joeyqleq. `credit-snapshots.json` is the pre-reading ledger backup; `credit-snapshots-before-schedules.json` captures the ledger after the 12 balance readings but before adding scheduled dates.

To fully roll back the live data, restore both original backups while the service is quiescent:

```sh
cp -p /home/jq/.config/rotoxy/backups/credit-renewals-2026-10-31/state.json /home/jq/.config/rotoxy/state.json
cp -p /home/jq/.config/rotoxy/backups/credit-renewals-2026-10-31/credit-snapshots.json /home/jq/.config/rotoxy/credit-snapshots.json
chmod 600 /home/jq/.config/rotoxy/state.json /home/jq/.config/rotoxy/credit-snapshots.json
```

Restoring `state-before-joey-restore.json` alone reverses only the joeyqleq enabled-state change while retaining the new readings and depleted-account pauses. To roll back code, revert the implementation commit separately.

## Verification

`node --test test/credit-snapshots.test.mjs test/credit-scheduled-renewals.test.mjs` passed all 11 tests, including UTC date boundaries, future dates, duplicate schedule/snapshot IDs, overage clamping, and preserving manual disables. The focused `npm run build` surfaced three `TS18048` narrowing errors in the admin restore guard; the guard was corrected afterward. A final build must confirm that correction. No paid provider calls, service restart, credential read/write, or job launch was performed.
