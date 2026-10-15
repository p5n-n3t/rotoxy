#!/usr/bin/env bash
# Unified manual installation. The compatibility installer remains available.
set -euo pipefail
umask 077
PREFIX="${ROTOXY_PREFIX:-${TOKEN2OAUTH_PREFIX:-$HOME/.local/share/rotoxy}}"
REPO="${ROTOXY_REPO:-${TOKEN2OAUTH_REPO:-https://github.com/p5n-n3t/rotoxy.git}}"
if [[ "${1:-}" == --help ]]; then
  echo 'ROTOXY manual installer: ROTOXY_PREFIX / ROTOXY_REPO may override trusted local paths/source.'
  echo 'Installs without starting services or publishing routes. Run rotoxy up explicitly.'
  exit 0
fi
[[ $# == 0 ]] || { echo 'Use --help for supported configuration.' >&2; exit 1; }
# Refuse to replace a launcher still owned by an active or boot-enabled predecessor.
for LEGACY_UNIT in token2oauth.service token2oauth-funnel.service rotoxy.service; do
  if systemctl --user is-active --quiet "$LEGACY_UNIT" 2>/dev/null || systemctl --user is-enabled --quiet "$LEGACY_UNIT" 2>/dev/null; then
    echo "Legacy unit $LEGACY_UNIT still owns startup. Complete the documented migration before installing the unified launcher." >&2
    exit 1
  fi
done
command -v tailscale >/dev/null || { echo 'Install and sign in to Tailscale first.' >&2; exit 1; }
TS_NAME="$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(String(JSON.parse(s).Self?.DNSName||"").replace(/\.$/,"")))')"
[[ -n "$TS_NAME" ]] || { echo 'Tailscale has no authenticated DNS name.' >&2; exit 1; }
if [[ ! -f "$PREFIX/install.sh" ]]; then
  mkdir -p "$(dirname "$PREFIX")"
  git clone --depth 1 "$REPO" "$PREFIX"
fi
bash "$PREFIX/install.sh" --prefix "$PREFIX" --repo "$REPO" --mode none --no-service --no-tailscale --public-base-url "https://$TS_NAME" --yes
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR" "$HOME/.local/bin" "$HOME/.local/lib"
if [[ -e "$HOME/.local/bin/rotoxy" || -L "$HOME/.local/bin/rotoxy" ]]; then
  BACKUP_DIR="$HOME/.local/state/rotoxy/backups/manual-install-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  cp -a "$HOME/.local/bin/rotoxy" "$BACKUP_DIR/rotoxy"
fi
install -m644 "$PREFIX/packaging/rotoxy-gateway.service" "$UNIT_DIR/rotoxy-gateway.service"
install -m644 "$PREFIX/packaging/rotoxy.target" "$UNIT_DIR/rotoxy.target"
install -m644 "$PREFIX/packaging/rotoxy-funnel.service" "$UNIT_DIR/rotoxy-funnel.service"
install -m755 "$PREFIX/scripts/rotoxy-control.mjs" "$HOME/.local/lib/rotoxy-control.mjs"
ln -sfn "$HOME/.local/lib/rotoxy-control.mjs" "$HOME/.local/bin/rotoxy"
systemctl --user daemon-reload
printf '\nROTOXY installed. Services and public routes were not started.\nRun: rotoxy up\nDashboard: https://%s/admin\n' "$TS_NAME"
printf 'Existing public mappings are preserved. Conflicts require an explicit migration; no global reset is performed.\n'
