# Separate-account Codex delegation proof

One bounded read-only review ran through the official Codex CLI using an existing
isolated ROTOXY profile, separate from the operator-declared native account.
No credential file was inspected, copied or replayed. An official App Server
metadata refresh first reported Plus sign-in, a supported `gpt-6-luna` catalog
entry, and non-exhausted quota (59% used in the five-hour window, 11% weekly).
Earlier readings from the same profile were lower, demonstrating that other
clients can consume its quota between checks.

The task reviewed three source modules, with a read-only sandbox, a three-minute
process deadline and a bounded private event log. It completed with exit code 0
and produced a concrete review of the policy and execution boundary. The CLI
reported 65,548 input tokens, including 46,080 cached input tokens, and 1,078
output tokens. These token measurements are not a subscription-quota debit or
monetary charge. Profile startup context still needs trimming for economical
worker execution.

The retrieved result correctly identified missing durable capacity reservations,
origin binding, execution and uncertain-turn recovery. Those findings were
checked against source and incorporated in the transition document. No service,
source file or provider credential was changed by the worker. No other agents
were launched by it.

This proves a manual bootstrap delegation using another signed-in account.
It does **not** prove ROTOXY scheduler dispatch, automatic quota failover, task
fan-out or automatic supervision of Codex workers. The runtime pool policy stays
disabled until those integrations have their own end-to-end acceptance evidence.
