# Agent workspace first-screen hierarchy — 2026-10-16

The task board now follows the compact project metrics immediately. Review, working/blocked, and queued work are the active board states; with at most two populated active states, a four-state count bar and two-column card layout replace empty columns. Completed and cancelled tasks remain available under a closed “Completed & cancelled” archive, with real records and actions intact.

Participant roster, configured LightSprint resources, and execution summaries are closed secondary disclosures after the board. Empty or absent execution rows reduce to one closed summary line. Resource configuration remains distinct from active work. Task assignee cards show participant provider and any reported model/account values; absent model/account values are omitted. The hidden refresh control has a scoped `display:none!important` rule so global button styling cannot reveal it before a newer revision is detected.

CSRF/revision/idempotency forms, workspace/execution revision attributes, nonce polling, and unsaved-draft protection remain in place. Validation is the focused renderer suite plus the TypeScript build. Root will verify the 1280×720 and narrow-screen rendering and draft-preserving refresh behavior in the browser.
