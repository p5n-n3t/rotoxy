# ROTOXY release smoke checkpoint

The package name is `rotoxy`; its installed bins are `rotoxy` (the compatibility/control wrapper) and `rotoxy-cli` (`dist/cli.js`). The release verifier had stale `token2oauth` package/bin assertions; both verifiers now check the canonical identity and packaged bin targets.

`node scripts/verify-release.mjs` builds a staged source copy with npm offline, checks the real archive against npm inventory, confirms generated `dist/`, monitor dependencies, Python modules (including Oracle, guidance, and credit), UI assets/notices, and imports Python from the extracted package. `node scripts/verify-package-install.mjs` installs the packed artifact with lifecycle scripts disabled into isolated temporary `HOME`, config, npm cache/config, and prefix; it invokes both bins, asserts the install plan remains manual with boot disabled, imports the installed Python bridge, and serves `/healthz` only on an ephemeral loopback address before stopping its owned process.

Focused verification on this branch passed:

- `node --check scripts/verify-release.mjs` and `node --check scripts/verify-package-install.mjs`.
- `node --test test/release-contract.test.mjs`: 3 tests passed.
- `node scripts/verify-release.mjs`: `rotoxy@0.2.0`, 431 actual archive files, all 52 packaged Python sources present and 13 key modules imported.
- `node scripts/verify-package-install.mjs`: `rotoxy@0.2.0`, 435 installed archive entries, both bins invoked, manual/boot-off plan verified, Python bridge help passed, isolated state initialized, loopback `/healthz` returned `ok: true`, and the child stopped with SIGTERM.

No full npm suite was run. These checks do not use private operator config, alter services/Tailscale, contact clients or providers, validate remote accounts, or establish production upgrade/rollback behavior. They must not be reported as all-provider or full-release verification.
