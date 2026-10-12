# Worker question observations checkpoint

Assignment: `RS-OBSERVE`, branch `codex/rotoxy-recovery-observe-20261012`, based on `e1d51cb24fd2ae00b3b111e40dd36462e4642f70`.

The read-only workforce monitor now retains a bounded projection of `parkedQuestion` from the observed LightSprint agent-session status field. The question object schema has not been verified with a live parked session. Recognized text, optional ID/choices, and an explicit question/review/approval kind are normalized as an experimental projection; unknown or oversized shapes keep `needsInput` true while their content stays unknown. Both the TypeScript monitor boundary and Python SQLite boundary redact credential-like strings and cap serialized question data at 2 KiB. Status reads are streamed with a 1 MiB cap. Prompt count and question snapshots are persisted on each heartbeat. An additive SQLite migration keeps existing databases usable; unchanged questions deduplicate, changed questions create durable events, and cleared questions remove the current worker snapshot. Owner and project filters remain applied to worker and inbox projections.

## Evidence and limits

The provider read used is `GET /api/agent-sessions/{sessionId}/status`, through the published LightSprint MCP surface documented at <https://app.lightsprint.ai/docs/mcp/>. The monitor still verifies the returned session ID and owner before persisting data. This work does not establish a provider reply, approval, or resume endpoint. It makes no chat call and does not authorize any action. Approval/review labels are carried only when explicitly present in a recognized provider question; they are informational labels, not verified provider workflows. If the provider changes its parked-question shape, the monitor stores only the needs-input state until the shape is explicitly normalized.

## Root integration seam

This branch intentionally does not modify runtime or UI files. `supervisor/snooze/guidance.py` now returns optional `question` and `promptCount` fields on `project_workers`, inbox events, and `project-snapshot` events. Root integrated these optional fields through `src/supervisor-runtime.ts` (`inboxEvent` and `readAdmin` worker/event projections), the `SupervisorWorker`/event types and normalizers in `src/supervisor-ui.ts`, and displays question text using escaped HTML or DOM `textContent` in the worker console and inbox. Keep the existing authenticated project route, owner scope, CSRF boundary, and read-only behavior; do not add a reply or approval control without official provider API evidence.

## Validation

Focused tests cover normalization, unknown/oversized shapes, credential redaction, SQLite migration, heartbeat persistence, question dedup/change/clear, and project ownership. Tests must continue to use temporary SQLite paths. No operator database, StateStore, provider session, paid action, or live service was used.
