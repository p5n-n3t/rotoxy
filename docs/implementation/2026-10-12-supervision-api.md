# Project-scoped supervision API

The configured `SupervisorRuntime` persists each explicitly registered project session into the local supervision database, keyed by project and OAuth client. The long-running monitor reads these registrations on each cycle, merges them with any operator-maintained private monitor entries, and performs the same read-only owned-session status check. It never launches, messages, or cancels a cloud worker.

The authenticated admin API provides:

- `GET /admin/api/v1/supervisor/:projectId/inbox?after=0&limit=20` for the durable project inbox and related local Oracle review metadata/results.
- `POST /admin/api/v1/supervisor/:projectId/inbox/:eventId/ack` to acknowledge an event; the existing admin session and CSRF checks apply.

Inbox events are filtered by both the configured project and the exact `oauth-client:<clientId>` owners bound to that project. Oracle result text is included only for local advisory jobs referenced by those filtered events. Cached Oracle model catalogs are descriptive metadata and are not refreshed by a read request. Pages are limited to 20 entries; summaries/results are redacted and subject to the existing 512 KiB admin response bound.

The ordinary project snapshot also includes a bounded `supervision` summary for initial UI rendering. If the local supervisor database or Oracle queue cannot be read, the snapshot reports supervision unavailable without hiding the core job snapshot. An inbox acknowledgment does not imply that an incident is resolved. Automatic delivery of local recommendations back to LightSprint workers is intentionally not part of this interface.

This implementation requires the gateway runtime to have started with a private supervisor configuration containing registered project sessions. Manual entries in the monitor's private configuration remain supported. No provider capability or credit balance is inferred from the local queue.

## Rollback

The schema addition is additive. Reverting the runtime and monitor code stops creating and consuming project registrations; existing rows are inert and can remain in the private SQLite database. To stop observation immediately, stop the `token2oauth-worker-monitor.service` user unit. Restore the prior application release to return to the earlier dashboard/API behavior. Do not delete the shared supervision database, because it also contains previously collected events and acknowledgments.
