# Manual startup readiness repair — 2026-11-04

Observed `rotoxy up` health failure after reboot. The gateway journal showed clean
stops before its listen banner, rather than crashes. Starting the gateway alone
and polling `/healthz` measured readiness after 25.6 seconds. The old launcher
performed 30 probes with 500ms sleeps: connection refusals exhausted its window
in approximately 15 seconds, triggering owned-unit rollback.

The launcher now permits 90 seconds, using an elapsed-time deadline as well as a
probe-count bound. Slow probes cannot multiply the window into several minutes.
Failures include the exact gateway journal command. Exposure still follows a
successful local health check; failed starts still roll back only newly started
owned units. Boot activation and unrelated services are unchanged.

Verification: 13 launcher tests pass, including a simulated 26-second cold start,
slow failed probes reaching the 90-second deadline, failed-start rollback, and
Tailscale route preservation. No TypeScript/backend change is needed.
