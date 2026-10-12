# Credit snapshots implementation checkpoint

Branch: `codex/rotoxy-credit-snapshots-20261012`
Base: `a7b7a30545d2fdd90d845a3a2003eaa973926927` from `origin/main`.

## Deliverable

`src/credit-snapshots.ts` exports `CreditSnapshotStore`, `listCreditAccounts`, `summarizeCredits`, and `renderCreditSnapshots`. The configured-account helper accepts the token2oauth state shape (`accounts` with `id`, `label`, and `provider`) and returns all LightSprint and Exa accounts, including dormant ones. LightSprint is denominated in credits with a 10,000,000 monthly allowance; Exa is USD with no inferred allowance.

The store keeps a bounded append-only JSON ledger in `TOKEN2OAUTH_CONFIG_DIR` or `$HOME/.config/token2oauth`, using a private directory/file mode, a cross-process lock, and atomic synced replacement. It validates accounts, units, timestamps, nonnegative values, refresh dates, and renewal evidence. Manual balance snapshots are always shown stale; a yearless `MM-DD` refresh date remains yearless. Only an explicitly recorded verified renewal resets the LightSprint estimate. Same-unit usage stays separated by provider-reported, user-reported, and estimated source. USD spend is never converted to credits; reservations and in-flight holds are separate from debits, and released/captured holds do not count as outstanding. Model/slot debit attribution remains unknown without provider evidence.

## Root integration seams

Root-owned API/admin code must provide the complete configured account list to `listCreditAccounts`, load ledger state through `CreditSnapshotStore`, and pass only actual reported usage, reservation, session-spend, and model/slot observations into `summarizeCredits`. The root integration should persist operator readings as user-reported snapshots and verified renewals only with supporting evidence, then render `renderCreditSnapshots` in the authenticated admin interface. API/admin wiring is outside these three owned files and is not included here.

## Validation

Installed locked dependencies with `npm ci --ignore-scripts --no-audit --no-fund`. `npm run build` passed. `node --test test/credit-snapshots.test.mjs` passed all 7 tests. Tests use temporary `HOME` and `TOKEN2OAUTH_CONFIG_DIR` values set before store construction and cover account enumeration, concurrent atomic writes/private permissions, validation, stale snapshots/correction lineage, verified-only resets, fresh 10M estimates, unit separation, USD/model-slot attribution, and released reservations.
