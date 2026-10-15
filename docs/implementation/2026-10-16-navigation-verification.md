# ROTOXY navigation verification — 2026-10-16

The desktop sidebar previously rendered the mobile navigation container after a later CSS rule overrode its desktop hide rule. It now renders one desktop navigation container, with contextual Resources and Settings disclosures. Short desktop viewports omit the redundant workspace identity block rather than shrink navigation targets. Jobs links to the authenticated jobs view. Unavailable destinations are omitted.

The workspace resource ledger starts collapsed, and the resource map no longer stretches to match expanded ledger height. The shared console uses slate-white surfaces and a dark teal rail.

Authenticated local Chromium rendering passed at 1280×720, 1280×900 and 390×844 for Workspace, Models and Cloudflare. Desktop navigation and footer fit without sidebar scrolling; pages had no horizontal overflow; mobile menu and Resources expansion worked. Screenshots were inspected and retained privately because they contain account metadata. Impeccable layout detection returned no findings.

ChatGPT's in-app browser rejected the public Tailscale URL with ERR_BLOCKED_BY_CLIENT. These results establish local rendered behavior, not successful cloud-browser access.

Regression validation: TypeScript build passed. Full Node run passed 384 of 385; the sole failure expected the retired serverInfo name. After updating the assertion to ROTOXY, all four tests in that affected file passed. Focused UI, provider, jobs and runtime checks passed 16 of 16.

Canonical repository: https://github.com/p5n-n3t/rotoxy. Public MCP now uses the root /mcp route. Internal legacy storage paths remain pending a coordinated migration; they are not evidence of a completed runtime-path migration.
