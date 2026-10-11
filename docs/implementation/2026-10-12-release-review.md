# Release/security/integration review — T2O-W2

Target: `origin/main` at `00e6e8f91564b7e4706b8dab3b36221c8bdfb4a2`. Production code unchanged; documented claims are distinguished from verified behavior.

## Top five release gaps

1. **Paid dispatch is unguarded by default.** `supervisor/snooze/bridge.py:22-36` selects legacy mode without `credit-admission.json`; `jobs.py:767-782` reserves only in strict mode. Repro: `cd supervisor && python3 -m unittest tests.test_credit_admission.CreditAdmissionIntegrationTests.test_missing_config_keeps_legacy_mode_explicit -v` (proves mode selection, not provider spend). Documented behavior; deployment must not claim spend admission by default. Require an explicit preflight acknowledgement or keep paid dispatch off pending evidence.
2. **Strict LightSprint admission is unusable with current evidence.** `docs/implementation/2026-10-12-CREDIT-ADMISSION.md:101-110` records no verified native-credit cap or same-unit debit source. Unknown-bound accounts are denied; accepted operations retain holds. Reservation/settlement tests pass, but no provider evidence exists. Obtain an enforceable cap and authoritative receipt; do not convert provisional USD telemetry.
3. **Live upgrade/rollback is unproven.** `docs/deployment/unified-supervisor.md:19-43` says no live deployment, backup, or rollback; checkpoint `:7` says client-helper backup is redacted/non-restorable. Plan: clean stop; stage mode-0700 backup of exact tarball, service command, supervisor config, and full Token2OAuth config/state; checksum and atomically rename; install tested tarball. Accept on a disposable host with restart, OAuth/CSRF, bounded job/result, and restore smoke checks. No deployment attempted.
4. **Recovery and Oracle completion lack end-to-end proof.** Checkpoint `:13,19` records no authenticated gateway-to-VM test, incomplete cloud instruction delivery/headless resume, and advisory Oracle recommendations. Gateway queues work; separate `snooze.oracle_pool serve` consumes it (`docs/ORACLE-MCP.md:5`). Acceptance: scoped OAuth submit, observed worker completion, result read after restart, and supported headless-resume test. No VM/provider execution verified.
5. **Operator documentation contradicts code.** `docs/ORACLE-MCP.md:3,13` says gateway wiring is required; line 15 and `src/server.ts:74-80` show `serve --oracle-pool` is wired. `docs/verification/distributed-job.md:47` says generic legacy accounts fail, but `src/supervisor-runtime.ts:97-99,235-242` accepts canonical native LightSprint targets. Correct those paragraphs; docs outside owned paths were not edited.

## Verified surfaces and checks

Primary `/` is the Token2OAuth UI; Snooze dashboard is a separate packaged, supervisor-opt-in surface. No bypass reproduced in OAuth scopes, admin CSRF, or owner/client/project inbox isolation (`test/job-submit`, `test/supervisor-api`, `supervisor/tests/test_job_inbox.py`). Oracle is opt-in/scoped (`src/cli.ts:99-100`; `test/job-submit.test.mjs`). New `test/release-contract.test.mjs` covers CLI opt-ins and package/operator artifacts.

Checks: TypeScript build; 21 Node and 17 credit-admission/inbox Python tests passed. No full suite, provider call, install, or deployment. Exact documentation fixes above are the integration patch; unowned docs stayed read-only.
