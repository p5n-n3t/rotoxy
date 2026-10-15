# Trusted OAuth client attribution

ROTOXY MCP request and upstream-attempt telemetry now carries an optional
`clientId` copied from `res.locals.oauthClaims.client_id`. That context is set
by `OAuthService.authenticateMcp` only after access-token signature, issuer,
audience, scope, and revocation checks. The proxy does not read a client ID
from request JSON, query parameters, or caller-controlled headers. The label
is trimmed/control-character-stripped and capped at 128 characters; events
remain in the existing bounded telemetry ring and summaries cap each
dimension's cardinality. Telemetry records no prompt/body or bearer token.

The admin analytics `client` filter applies to request counts, outcomes,
latencies, and buckets only when a recorded client association matches. Events
without `clientId` are excluded from that filtered result and counted in
`filters.excludedUnknownClientRecords`; without a client filter, they remain
in aggregate gateway totals. Older snapshots and all job/task records remain
unknown: this change does not infer job/task ownership or retroactively tag
events. The existing unsupported-dimension reporting remains for provider,
model, and job filters on gateway requests. Provider usage and supervisor
records still report client filtering unavailable because they have no
trusted client association.

## Telemetry module PR3 integration

The proxy already receives the verified OAuth claims at its authenticated
boundary. Keep `clientId?: string` optional in the telemetry event contract so
non-OAuth probes, older persisted records, and other producers remain valid.
If PR3 moves request/attempt recording into a shared telemetry module, pass
the verified `client_id` explicitly from this boundary and preserve `undefined`
when absent. Do not derive it from payloads, headers, provider responses, or
job/task identifiers. Keep the 128-character bound and bounded summary
dimension; consumers must surface missing attribution instead of inventing a
client label.

## Verification

Focused tests cover bounded event labels, trusted claim propagation on both
request and attempt records despite spoofed JSON/header fields, direct
analytics client filtering with unknown exclusions, and the authenticated
admin analytics route. No external provider calls or user-facing UI changes
are involved.
