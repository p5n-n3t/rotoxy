# Paid-operation credit admission

## Runtime boundary

The durable Snooze job bridge claims an operation before returning it to the
Node worker that performs the upstream session-message call. When strict credit
admission is enabled, `JobRegistry.claim_operation` reserves the operation's
native-unit upper bound in `CreditLedger` before it changes the operation to
`claimed` or returns a provider DTO. The operation ID is the idempotency key.
A reservation failure moves the operation to `rejected`, the task to `blocked`,
and the assignment to `held`; the worker receives no operation to execute.

The bridge looks for `credit-admission.json` inside its private `--state-dir`.
If the file is absent, status reports `legacy` and existing dispatch behavior
continues. If present, it must be an owner-only (`0600` or stricter), regular,
non-symlink JSON file with `schemaVersion: 1` and `enabled: true`. Invalid
present configuration fails bridge startup rather than silently disabling the
guard. Strict status is available from the private admin route
`GET /admin/api/v1/credit-admission`.

Example shape:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "accounts": {
    "stable-provider-account-id": {
      "userId": "JQ",
      "provider": "lightsprint",
      "unit": "credits",
      "cycleId": "provider-reported-cycle-id",
      "costUpperBound": null,
      "boundVerified": false,
      "boundSource": "unknown",
      "verifiedDebitSources": []
    }
  }
}
```

`null` plus `boundVerified: false` represents an unknown operation ceiling.
Such a policy is valid configuration but denies all paid mutations for that
account. An account omitted from the policy is also denied. A verified bound
must be a positive integer, with a source that identifies the provider-enforced
limit and its evidence. Caller-supplied task metadata cannot override it.

Balances are not read from LightSprint at runtime. They must be installed as a
separate verified snapshot through the CLI, which uses the configured native
unit and cycle and refuses refresh when an active/ambiguous reservation exists:

```sh
python3 -m snooze.credit_admission --config /path/to/credit-admission.json \
  --ledger /path/to/credit-reservations.sqlite3 snapshot \
  --account stable-provider-account-id --balance 123456 \
  --snapshot-date 2026-10-12 --source "verified provider usage page" --verified
```

The operator must replace the example values with a current provider-reported
balance, cycle, unit, and source. Startup never imports or refreshes a balance,
so restart cannot restore already consumed quota. A cycle change requires an
explicitly verified new snapshot. Available balance is snapshot balance minus
active reservations and verified settlements.

Create the opt-in file explicitly with owner-only permissions after reviewing
provider evidence. For example, put it at `<state-dir>/credit-admission.json`
and set mode `0600`. The private status endpoint reports `strict` or `legacy`;
the bridge does not choose a mode from balance heuristics.

## Completion and recovery

Ambiguous results and expired worker leases keep their reservation active across
restart. Only the existing explicit pre-execution rejection classes release a
reservation automatically. Generic errors and post-send rejections keep the
hold.

Settlement accepts `creditDebit` evidence only on an accepted session-message
result. The evidence must include an exact unit, integer amount, source, and
`verified: true`; the source must also be listed in that account's
`verifiedDebitSources`. The source, amount, and unit are persisted before
settlement. Existing LightSprint session telemetry reports USD-oriented fields
and does not establish a credits-to-USD conversion or authoritative credits
debit. Those fields are never converted or used as credit settlement evidence.
No such debit source is currently verified for LightSprint, so reservations
remain held until reconciled by a genuinely authoritative same-unit receipt.

The ledger has an explicit manual reconciliation command for an authoritative
receipt:

```sh
python3 -m snooze.credit_admission --config /path/to/credit-admission.json \
  --ledger /path/to/credit-reservations.sqlite3 settle \
  --operation-id OPERATION_ID --unit credits --amount 42 \
  --source "provider debit receipt" --verified
```

The source must be predeclared for that account. Do not enter estimated USD as
credits or attest a debit from inference. An over-bound debit freezes the
account for review.

## Current LightSprint limitation

No verified LightSprint per-operation upper bound in native credits, no
credit-to-USD conversion, and no authoritative same-unit debit receipt are
currently configured or established. Therefore a strict LightSprint account
with an unknown ceiling is intentionally unusable for new paid dispatch until
provider evidence supplies both a verified balance snapshot and an enforceable
positive operation cap. This is stricter than the prior runtime mode, which
remains active when the opt-in file is absent. This module does not change live
gateway configuration or enable strict mode by itself.
