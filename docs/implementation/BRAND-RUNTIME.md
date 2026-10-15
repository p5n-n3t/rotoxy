# ROTOXY canonical runtime checkpoint

New state defaults to `~/.config/rotoxy`; installation and lifecycle files use
`~/.local/share/rotoxy` and `~/.local/state/rotoxy`. `ROTOXY_CONFIG_DIR` wins
when set. `TOKEN2OAUTH_CONFIG_DIR` and the old default directory remain readable
as compatibility fallbacks. If the canonical state file is absent but
`~/.config/token2oauth/state.json` exists, ROTOXY opens that store in place; it
does not create an empty canonical store. New configuration defaults to an
empty public base path and `http://127.0.0.1:2030`.

The CLI and launcher identify as `rotoxy`. The launcher handles only `up`,
`down`, `status`, and `install-plan`; other commands invoke the installed
`dist/cli.js` with `execFileSync` argument arrays and no shell. The three service
units use canonical ROTOXY names and have no boot-install section. The manual
installer writes templates and reloads systemd but does not start or enable a
service or route. Funnel exposure remains an explicit operator action.

## Explicit legacy migration (operator/root-owned)

No state migration is run by these scripts. Before switching to canonical
storage, stop the old gateway and its workers, take a private backup of
`~/.config/token2oauth`, `~/.local/share/token2oauth`, and
`~/.local/state/token2oauth`, then inspect which paths actually contain data.
When the canonical destination is absent, copy the legacy config directory to
`~/.config/rotoxy` with ownership preserved and permissions restricted to the
user (`0700` directories, `0600` secret/state files). Move package/service
paths and client URLs only as a separately reviewed operation. Verify the
copied encrypted state opens with its matching master key before retiring the
legacy paths. Do not run `uninstall.sh --purge` until that verification and
client/service cutover are complete.

The root integration still owns package metadata, application-side `data` and
`state` paths outside `StateStore`, client registrations, and any actual local
machine migration. This checkpoint changes installer templates only; it makes no service, route, or data changes to a
running host.

## Verification and integration seam

Focused evidence on the isolated branch: `npm run build`; 13 tests across
`rotoxy-brand-runtime`, `rotoxy-control`, and `rotoxy-install`; `bash -n` for
all three shell installers; and `node dist/cli.js --help` reports `rotoxy`.
No service, Tailscale route, user data, or live configuration was touched.

The caller-owned integration still needs to rename package metadata/bin aliases
and update runtime modules outside this scope that hard-code Token2OAuth's
share/state directories or legacy HTTP mount. Keep those changes separate from
operator data migration; this patch intentionally leaves the package name and
application-side migration to the root integrator.
