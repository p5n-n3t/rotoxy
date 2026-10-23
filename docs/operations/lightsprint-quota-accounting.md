# LightSprint quota accounting

The monthly denominator is 10,000,000 credits. Credits are not assumed to equal
tokens. The current official pricing page confirms 10M credits per Pro seat and
includes sandbox use; it does not establish a fixed credits-per-USD conversion.
Source checked 2026-10-23: https://lightsprint.ai/pricing . The FAQ contains a
different tier schedule, so it is not used as a conversion table.

User readings are stored in the existing owner-private credit snapshot ledger,
with observation time, refresh date and source. Four user-declared depleted
accounts were disabled on 2026-10-23 regardless of the provider allowing overage.
A zero usage reading for jqthefoo is a full 10M balance, not depletion.
The user confirmed on 2026-10-23 that the seven other readings are credits used.
Their remaining balances are calculated as 10M minus used credits, retaining the
original observation times. The additional maryjoebake reading is zero usage,
with a November 11 renewal date. Exact per-account readings remain private.
These are manual account snapshots, not provider-verified live balances.

## Session cost monitoring

The workforce monitor reads `status.aiGatewaySessionCostUsd` only after session
ownership and identity verification. The first cost read establishes a baseline.
Later increases are saved once per account/session in the existing private ledger.
Identical polls do not add spend; stale reads and decreasing counters do not
create negative debits. A restart retains the high-water mark. Idle, failure,
and completion labels do not themselves cause a debit or erase a cost reading.
A late cost increase can be recorded while a completed session is still monitored.
The monitor makes no extra upstream call to collect this field.

The credits page shows tracked USD increases and model-at-observation details.
An interval spanning a model change is not proof of exact per-model attribution.
Only monitored sessions are covered. Direct dashboard tasks, unregistered
sessions, planning and sandbox charges may be absent. No historical total is
subtracted from a newly supplied account balance merely because a session is
first discovered.

USD and credits remain separate until a trustworthy conversion is established.
Manufacturer model token prices do not establish LightSprint credit pricing.
A later conversion must retain source/date, mark estimates, deduplicate debits,
and reconcile fresh account readings. Refresh dates alone do not prove renewal
or automatically re-enable an exhausted account.
