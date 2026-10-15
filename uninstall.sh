#!/usr/bin/env bash
set -Eeuo pipefail
PREFIX="${ROTOXY_PREFIX:-${TOKEN2OAUTH_PREFIX:-$HOME/.local/share/rotoxy}}"
CONFIG_DIR="${ROTOXY_CONFIG_DIR:-${TOKEN2OAUTH_CONFIG_DIR:-$HOME/.config/rotoxy}}"
PUBLIC_PATH="${ROTOXY_PATH:-${TOKEN2OAUTH_PATH:-/}}"
MODE="${ROTOXY_EXPOSE:-${TOKEN2OAUTH_EXPOSE:-none}}"
PURGE=0
REMOVE_ROUTE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift;;
    --keep-route) REMOVE_ROUTE=0; shift;;
    --path) PUBLIC_PATH="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    -h|--help)
      echo "Usage: ./uninstall.sh [--purge] [--keep-route] [--path /token2oauth] [--mode funnel|serve]"
      exit 0;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done

PUBLIC_PATH="/${PUBLIC_PATH#/}"; PUBLIC_PATH="${PUBLIC_PATH%/}"
if [[ ( -z "$PUBLIC_PATH" || "$PUBLIC_PATH" == "/" ) && "$REMOVE_ROUTE" -eq 1 ]]; then
  echo "Refusing to touch the Tailscale root path '/': it is shared with other services. Use --keep-route." >&2
  exit 1
fi

if (( REMOVE_ROUTE )) && [[ -x "$PREFIX/dist/cli.js" ]] && command -v node >/dev/null 2>&1 && [[ "$PUBLIC_PATH" == "/token2oauth" ]]; then
  # Preferred: the guarded lifecycle removes only the legacy /token2oauth path after checking
  # that every unrelated Serve/Funnel route stays exactly as it was.
  if node "$PREFIX/dist/cli.js" lifecycle down --keep-service --execute; then
    REMOVE_ROUTE=0
  fi
fi

for UNIT in rotoxy-gateway.service rotoxy-oracle-pool.service rotoxy-worker-monitor.service rotoxy-funnel.service rotoxy.target; do systemctl --user disable --now "$UNIT" 2>/dev/null || true; rm -f "$HOME/.config/systemd/user/$UNIT"; done
systemctl --user daemon-reload 2>/dev/null || true

if (( REMOVE_ROUTE )) && command -v tailscale >/dev/null 2>&1; then
  tailscale "$MODE" --https=443 --set-path="$PUBLIC_PATH" off 2>/dev/null ||
    sudo tailscale "$MODE" --https=443 --set-path="$PUBLIC_PATH" off 2>/dev/null || true
fi

rm -f "$HOME/.local/bin/rotoxy" "$HOME/.local/bin/rotoxy-cli"
rm -rf "$PREFIX"
if (( PURGE )); then
  rm -rf "$CONFIG_DIR"
  echo "Removed ROTOXY and encrypted state."
else
  echo "Removed ROTOXY. Encrypted state kept at ~/.config/rotoxy (use --purge to remove it)."
fi
