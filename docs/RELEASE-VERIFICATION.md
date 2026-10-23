# Offline release artifact verification

Run both checks from a clean checkout after installing the lockfile-pinned development dependencies in the normal development environment:

```sh
node scripts/verify-release.mjs
node scripts/verify-package-install.mjs
node scripts/verify-fleet-oauth.mjs
```

The Fleet OAuth smoke starts the real Python supervisor with an empty provider
registry in disposable state, performs PKCE registration/consent/token exchange,
and verifies authorized Fleet discovery and a workspace snapshot over MCP. Pass
an absolute installed release directory as its first argument to check that
bundle. It never uses operator credentials or launches inference. This checks
protocol and supervisor wiring, not upstream execution capacity.

The offline audit itself never installs dependencies. Both require Node.js 22+, Python 3.11+, npm, tar, and the local TypeScript compiler. If `node_modules/.bin/tsc` is absent, they exit with a prerequisite message; do not treat a dependency-free `npm pack --ignore-scripts` archive as a complete release. The canonical published package is `rotoxy`, with `rotoxy` (control wrapper) and `rotoxy-cli` (`dist/cli.js`) bins.

The offline audit creates a mode-restricted temporary directory, stages only package/build inputs, runs the existing TypeScript build there with npm network access disabled, packs the built package with lifecycle scripts suppressed, and inspects both npm's inventory and the actual `.tgz`. It verifies canonical package metadata and both declared bin targets, every generated `dist/` file, the `monitor-workforce.mjs` entry and compiled modules it imports, all packaged Snooze Python sources, the Oracle/guidance/credit modules, dashboard assets and notices, absence of development/private-config paths, and consistency between the tarball and npm inventory. It extracts the archive and imports key packaged Python modules with user-site imports disabled. It removes the temporary directory on success or failure.

The install smoke packs the checkout, installs only that tarball into a temporary prefix with lifecycle scripts disabled, invokes both installed bins, and checks the generated install plan still says manual/no boot enable. It sets temporary `HOME`, `TOKEN2OAUTH_CONFIG_DIR`, npm config/cache, and Python user-site settings before importing the installed state store. It then starts only the installed CLI with an explicit ephemeral `127.0.0.1` bind, checks `/healthz`, and terminates that child. It does not run installer scripts, enable/start system services, change Tailscale, or invoke clients/providers.

These checks qualify the local package artifact and an isolated loopback boot only. They do not read operator configuration, call a provider, validate live account/session access, test a deployment or rollback, establish quota/balance, or prove provider concurrency. A passing result supports packaging, imports, installed CLI behavior, and local health only. It is not full-release or all-provider verification; no live deployment or rollback was run for this audit.

## Evidence and remaining gaps

The runtime enables job dispatch only when explicitly configured with `serve --supervisor-config`. The latest verified overlap is **eight simultaneously observed LightSprint sessions across four accounts**, two sessions per account ([2026-10-12 evidence](evidence/2026-10-12-workforce-wave2.json)). This is observed execution, not a provider limit. **24/35-worker concurrency remains untested.** Provider credit balances and per-operation native credit bounds remain unavailable; provisional USD session deltas are not invoices or verified credit debits.

Credit admission is wired into durable dispatch reservations when the private strict config is enabled. Missing config preserves legacy mode. Strict mode denies unknown native operation ceilings; `allowUnknownQuota` does not override this guard. See [integration evidence and remaining limits](implementation/2026-10-12-wave2-integration.md) and [deployment notes](deployment/unified-supervisor.md). Offline package proof remains distinct from the installed/public verification recorded at deployment.
