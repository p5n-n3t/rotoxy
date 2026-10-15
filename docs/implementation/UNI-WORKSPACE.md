# Unified workspace command centre

This branch adds `createCommandWorkspaceRouter(store, sessions, supervisorBackend?)` in `src/command-workspace.ts`. It provides an authenticated read-only HTML page at `/admin/workspace` and a bounded JSON snapshot at `/admin/api/v1/workspace/snapshot`. The page uses the existing `page()` and `adminNav()` helpers, adds a temporary Workspace item to its local nav when the shared nav does not yet include one, and contains no mutation controls.

The snapshot reads MCP account metadata from `StateStore`/`CredentialPool`, Ollama metadata from `ModelCredentialStore`, Cloudflare metadata from `CloudflareCredentialStore`, and up to 24 configured supervisor projects. Supervisor reads are redacted, bounded, normalized, and reduced to project state and actual worker/job counts. The response does not include prompts, provider tokens, model inference, traffic, or invented usage. Account arrays are capped at 100 per source and the JSON response at 256 KiB. Refresh uses same-origin authenticated fetch every 10 seconds, pauses while the document is hidden, and displays snapshot freshness/errors.

The SVG resource flow distinguishes gateway, pool, and account nodes. The page uses a desktop split canvas/ledger and a stacked mobile layout, native disclosure details, keyboard focus styling, and reduced-motion rules. Inline JavaScript is protected by a per-response nonce; the workspace router sets no-store and standard framing/referrer/content-type protections.

Focused validation: `npm run build` and `node --test test/command-workspace.test.mjs` pass. The test uses isolated temporary `HOME` and `TOKEN2OAUTH_CONFIG_DIR`, checks unauthenticated rejection, real resource counts/labels, safe supervisor projection, prompt/credential redaction, nonce CSP, and rendered SVG/polling semantics.

## Root integration

Mount `createCommandWorkspaceRouter(store, sessions, options.supervisorBackend)` in `server.ts` before the generic admin route. Add `{ key: "workspace", label: "Workspace", href: "/admin/workspace" }` to the shared Command navigation group in `src/html.ts`. This assignment intentionally does not modify server, shared navigation, or existing page/API handlers. Root should run its focused integration checks and browser review after mounting.
