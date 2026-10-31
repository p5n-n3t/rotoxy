# Persistent monitor release repair

The workforce monitor remained on release `c8bd0e0` while the gateway and Oracle
pool had moved to `5b91dd7`. Its provider observations succeeded, but every
five-minute cycle reported `recovery_service_failed`. The recovery policy loads
the Oracle pool configuration even in notify mode when Oracle advice is enabled;
the old runtime did not accept the new model configuration.

Running the same configured recovery command with the `5b91dd7` supervisor
completed successfully. The monitor's user-systemd release drop-in was backed up
to `/home/jq/.local/state/rotoxy/backups/release-20261031-5b91dd7/monitor.conf`
and changed to the same release, then only the monitor was restarted.

The subsequent live cycle reported nine checked sessions, zero status errors,
and `recoveryStatus: completed`. Desktop notifications remain unconfigured;
this repair does not claim that a dormant conversation can be awakened.
The 16 focused monitor lifecycle, observation and credit-renewal tests passed.

Future release promotion must move all three runtime consumers together:
gateway, Oracle pool, and workforce monitor. Preserve their private state paths
and restore the backed-up drop-in for rollback. Do not replay provider jobs
as part of a runtime rollback.
