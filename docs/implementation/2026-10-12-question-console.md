# Supervision question and guidance console

The full-width worker view attributes each current row to its configured account and session and keeps requested and observed models separate. A bounded provider question projection, prompt count, optional choices and question kind appear directly beneath the related worker. Inbox events preserve the account/session binding recorded at observation; historical events without these fields remain unknown. Text is escaped or rendered with `textContent`.

Native parked questions, including review and approval items, are explicit provider handoffs. The exposed status/chat operations do not establish native answer or approval semantics, so no approval button or parked-question reply form is provided. The object schema remains experimental until a real parked session verifies it.

Observed idle workers with a known prompt count may show a manual guidance form. It sends a stable request ID, expected prompt count and plain-text message to the mounted admin route with CSRF protection. Polling never sends guidance. The backend rechecks account/session ownership, current provider state, quota eligibility and tool policy. Accepted, rejected and ambiguous receipts are shown distinctly; acceptance does not mean completion. An ambiguous action is not automatically retried under a fresh request ID.

Workers, Inbox, Recovery and Handoffs use keyboard-operable tabs. On mobile, worker rows become two-column cards and guidance spans the available width. The page has a ROTOXY breadcrumb and mark. Desktop and mobile browser fixtures returned HTTP 200, no JavaScript errors and no viewport overflow; the idle form submitted successfully against a synthetic API. This browser fixture does not prove public account authentication or paid delivery. Real LightSprint delivery was verified separately through the backend integration.

See the [integrated checkpoint](2026-10-12-actionable-supervision.md) for evidence and limits.
