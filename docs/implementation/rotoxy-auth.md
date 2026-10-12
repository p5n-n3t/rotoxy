# ROTOXY OAuth compatibility checkpoint

Assignment: `RX-AUTH`; branch `codex/rotoxy-auth-20261012`, based on fetched `origin/main` at `a7b7a30545d2fdd90d845a3a2003eaa973926927`.

## Implementation

`OAuthService` now accepts Claude Code 2.1.286's `/register`, `/authorize`, and `/token` endpoint spellings by routing them to the existing registration, consent, and token handlers. The server already mounts this router at both the configured base path and root, so both forms share the same DCR policy, consent security headers, PKCE S256 validation, issuer/resource binding, redirect checks, and refresh rotation. Standard `/oauth/*` routes and metadata remain intact.

The public OAuth doctor collector now treats metadata as observed only when both well-known endpoints return successful HTTP responses and valid JSON. Transport, HTTP, or parse failures leave the stage unverified and omit advertised values. Funnel observation remains unverified if the read-only runtime commands fail; errors are not copied into the snapshot.

## Evidence and seams

`test/oauth-compat.test.mjs` isolates `TOKEN2OAUTH_CONFIG_DIR` and `HOME` before constructing `StateStore`. It exercises DCR, authorization-code PKCE, token issuance and refresh rotation through root and `/token2oauth` routes, checks both well-known route mounts, rejects the admin password as an MCP bearer token, and verifies that doctor snapshots do not trust HTTP error JSON or expose command error text.

The doctor snapshot schema in `src/doctor.ts` has no public error-detail field, so failed OAuth/Funnel observations intentionally remain unverified without a surfaced error string. Runtime collection does not probe external Claude services or change any route configuration. Provider compatibility is covered by local mock HTTP behavior only; no live Claude/provider execution was performed.

Compatibility documentation reference: [Claude Code MCP](https://code.claude.com/docs/en/mcp). The short `/register`, `/authorize`, and `/token` paths are the explicitly supplied 2.1.286 client behavior this patch accommodates.

## Validation

`npm run build` passed. `node --test test/oauth-compat.test.mjs` passed (1 test covering root/prefix flows and doctor collection). The full `npm test` suite passed: 295 tests, 0 failures. The final focused run was repeated after adding explicit bad-PKCE rejection and consent-header assertions. Dependencies were reused from the shared checkout's `node_modules`; the isolated worktree itself did not run an install.

Commit and push identifiers are recorded in the assignment response after publication.
