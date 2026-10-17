# Runner profiles checkpoint

Implemented an owner-session-only `/admin/runners` editor and a private Python registry for local `claude`, `opencode`, and `hermes` command profiles. Profiles hold a working directory, a trusted absolute executable, enablement, and an explicit model allowlist. Empty model lists are shown as unknown. The explicit `--version` and `--help` controls run only executables supplied by trusted server configuration, with a clean temporary `HOME`, no shell, a 5-second deadline, and bounded output; they do not perform authentication or inference. A successful probe indicates CLI responsiveness only, not entitlement, quota, or working inference.

The registry uses owner-only directories/files, an exclusive lock, revision checks, an immutable pre-change backup, and atomic replacement. HTTP requests cannot supply executable allowlists, extra process arguments, environment variables, or arbitrary config paths. Registry integration tests use temporary paths and injected probes.

**Integration seam:** the root integrator must mount `createRunnerAdminRouter(store, sessions, options).router` and add `/admin/runners` navigation. Production must pass trusted absolute executable paths discovered/configured by the server in `options.trustedExecutables`; the empty default intentionally permits no runner executable. Existing tracked CLI research docs can inform operator setup, but this page does not discover commands itself.

**Validation:** TypeScript build was attempted but the isolated checkout has no installed toolchain (`tsc: not found`). No package install or external calls were made. Python registry tests are run separately in the isolated supervisor tree.
