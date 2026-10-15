#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/p5n-n3t/rotoxy.git"
BRANCH="main"
PREFIX="${ROTOXY_PREFIX:-${TOKEN2OAUTH_PREFIX:-$HOME/.local/share/rotoxy}}"
PORT="${ROTOXY_PORT:-${TOKEN2OAUTH_PORT:-2030}}"
PUBLIC_PATH="${ROTOXY_PATH:-${TOKEN2OAUTH_PATH:-/}}"
MODE="${ROTOXY_EXPOSE:-${TOKEN2OAUTH_EXPOSE:-none}}"
PUBLIC_BASE_URL="${ROTOXY_PUBLIC_BASE_URL:-${TOKEN2OAUTH_PUBLIC_BASE_URL:-}}"
UPSTREAM_URL="${ROTOXY_UPSTREAM_URL:-${TOKEN2OAUTH_UPSTREAM_URL:-}}"
INSTALL_TAILSCALE=0
INSTALL_SERVICE=0
ASSUME_YES=0
FORCE_ROOT=0
DRY_RUN=0

usage() {
  cat <<'EOF'
ROTOXY installer

Usage:
  ./install.sh [options]
  curl -fsSL https://raw.githubusercontent.com/p5n-n3t/rotoxy/main/install.sh | bash

Options:
  --prefix PATH            Install directory (default ~/.local/share/rotoxy)
  --port N                 Local gateway port (default 2030)
  --path PATH              Public URL path (default /, only when --mode none)
  --mode MODE              funnel | serve | none (default none)
  --public-base-url URL    Override auto-detected public base URL
  --upstream-url URL       Preconfigure the upstream MCP endpoint
  --branch NAME            Git branch/tag to install (default main)
  --repo URL               Alternate git repository
  --no-tailscale           Do not install or configure Tailscale
  --no-service             Do not create a systemd user service
  --force-root             Allow replacing/claiming the Tailscale root path /
  -y, --yes                Non-interactive confirmation
  --dry-run                Print major actions without changing the machine
  -h, --help               Show this help

The installer is idempotent for the selected prefix. It uses canonical ROTOXY paths and does not start a service or publish a route by default. Existing legacy state is discovered by the application until an operator performs the documented migration.
EOF
}

log(){ printf '\033[1;36m[rotoxy]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[rotoxy]\033[0m %s\n' "$*" >&2; }
die(){ printf '\033[1;31m[rotoxy]\033[0m %s\n' "$*" >&2; exit 1; }
run(){
  if (( DRY_RUN )); then printf '+ '; printf '%q ' "$@"; printf '\n'; else "$@"; fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --path) PUBLIC_PATH="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    --public-base-url) PUBLIC_BASE_URL="$2"; shift 2;;
    --upstream-url) UPSTREAM_URL="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --repo) REPO_URL="$2"; shift 2;;
    --no-tailscale) INSTALL_TAILSCALE=0; shift;;
    --no-service) INSTALL_SERVICE=0; shift;;
    --force-root) FORCE_ROOT=1; shift;;
    -y|--yes) ASSUME_YES=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) usage; exit 0;;
    *) die "Unknown option: $1";;
  esac
done

[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be numeric"
(( PORT >= 1 && PORT <= 65535 )) || die "--port must be between 1 and 65535"
case "$MODE" in funnel|serve|none) ;; *) die "--mode must be funnel, serve, or none";; esac
[[ "$PUBLIC_PATH" == /* ]] || PUBLIC_PATH="/$PUBLIC_PATH"
[[ "$PUBLIC_PATH" == "/" ]] || PUBLIC_PATH="/${PUBLIC_PATH#/}"
PUBLIC_PATH="${PUBLIC_PATH%/}"
[[ -n "$PUBLIC_PATH" ]] || PUBLIC_PATH="/"

if [[ "$PUBLIC_PATH" == "/" && "$MODE" != "none" && "$FORCE_ROOT" -ne 1 ]]; then
  die "Refusing to claim Tailscale root /. Use --mode none for the canonical root URL, or pass --force-root after reviewing route ownership."
fi

if (( ! ASSUME_YES )) && [[ -t 0 ]]; then
  cat <<EOF
ROTOXY will:
  • install/update into: $PREFIX
  • listen on:          127.0.0.1:$PORT
  • exposure mode:      $MODE
  • public path:        $PUBLIC_PATH
  • install Tailscale if missing: $([[ $INSTALL_TAILSCALE -eq 1 ]] && echo yes || echo no)
  • preserve all existing Tailscale routes
EOF
  read -r -p "Continue? [Y/n] " answer
  [[ "${answer:-Y}" =~ ^[Yy]$ ]] || exit 0
fi

need_sudo() {
  if [[ "$(id -u)" -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

install_packages() {
  local pkgs=(curl git ca-certificates)
  if command -v apt-get >/dev/null 2>&1; then
    run need_sudo apt-get update
    run need_sudo apt-get install -y "${pkgs[@]}" nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    run need_sudo dnf install -y "${pkgs[@]}" nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    run need_sudo yum install -y "${pkgs[@]}" nodejs npm
  elif command -v pacman >/dev/null 2>&1; then
    run need_sudo pacman -Sy --needed --noconfirm "${pkgs[@]}" nodejs npm
  else
    die "No supported package manager found. Install Git, curl, Node.js >=22, and npm, then rerun."
  fi
}

if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  log "Installing base dependencies…"
  install_packages
fi

if (( ! DRY_RUN )); then
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
  (( NODE_MAJOR >= 22 )) || die "Node.js >=22 is required; found $(node -v). Upgrade Node and rerun."
fi

if (( INSTALL_TAILSCALE )) && ! command -v tailscale >/dev/null 2>&1; then
  log "Tailscale is not installed; installing from the official Tailscale installer…"
  if (( DRY_RUN )); then
    echo '+ curl -fsSL https://tailscale.com/install.sh | sh'
  else
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
else
  command -v tailscale >/dev/null 2>&1 && log "Tailscale already installed; leaving the installation untouched."
fi

if (( INSTALL_TAILSCALE )) && command -v tailscale >/dev/null 2>&1; then
  if ! tailscale status >/dev/null 2>&1; then
    log "Tailscale is installed but not connected. Starting login…"
    run need_sudo tailscale up
  fi
fi

log "Installing ROTOXY…"
if [[ -d "$PREFIX/.git" ]]; then
  run git -C "$PREFIX" fetch --tags origin
  run git -C "$PREFIX" checkout "$BRANCH"
  run git -C "$PREFIX" pull --ff-only origin "$BRANCH"
else
  run mkdir -p "$(dirname "$PREFIX")"
  run git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$PREFIX"
fi

if (( ! DRY_RUN )); then
  cd "$PREFIX"
  npm ci
  npm run build
  npm prune --omit=dev
  chmod +x dist/cli.js install.sh uninstall.sh
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$PREFIX/dist/cli.js" "$HOME/.local/bin/rotoxy-cli"
  mkdir -p "$HOME/.local/lib"
  install -m755 "$PREFIX/scripts/rotoxy-control.mjs" "$HOME/.local/lib/rotoxy-control.mjs"
  ln -sfn "$HOME/.local/lib/rotoxy-control.mjs" "$HOME/.local/bin/rotoxy"
fi

if [[ -z "$PUBLIC_BASE_URL" ]]; then
  if [[ "$MODE" != "none" ]] && command -v tailscale >/dev/null 2>&1 && (( ! DRY_RUN )); then
    TS_NAME="$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.Self?.DNSName||"").replace(/\.$/,""))})')"
    [[ -n "$TS_NAME" ]] || die "Could not determine the Tailscale DNS name. Pass --public-base-url explicitly."
    PUBLIC_BASE_URL="https://$TS_NAME$([[ "$PUBLIC_PATH" == "/" ]] && echo "" || echo "$PUBLIC_PATH")"
  else
    PUBLIC_BASE_URL="http://127.0.0.1:$PORT$([[ "$PUBLIC_PATH" == "/" ]] && echo "" || echo "$PUBLIC_PATH")"
  fi
fi

if (( ! DRY_RUN )); then
  INIT_ARGS=(init --base-path "$PUBLIC_PATH" --public-base-url "$PUBLIC_BASE_URL")
  [[ -n "$UPSTREAM_URL" ]] && INIT_ARGS+=(--upstream-url "$UPSTREAM_URL")
  "$PREFIX/dist/cli.js" "${INIT_ARGS[@]}"
  "$PREFIX/dist/cli.js" config set basePath "$PUBLIC_PATH"
  "$PREFIX/dist/cli.js" config set publicBaseUrl "$PUBLIC_BASE_URL"
  [[ -n "$UPSTREAM_URL" ]] && "$PREFIX/dist/cli.js" config set upstreamUrl "$UPSTREAM_URL"
fi

if (( INSTALL_SERVICE )); then
  SERVICE_DIR="$HOME/.config/systemd/user"
  SERVICE_FILE="$SERVICE_DIR/rotoxy-gateway.service"
  NODE_BIN="$(command -v node || true)"
  if [[ -n "$NODE_BIN" ]] && command -v systemctl >/dev/null 2>&1; then
    log "Installing systemd user service…"
    if (( ! DRY_RUN )); then
      mkdir -p "$SERVICE_DIR"
      cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=ROTOXY MCP OAuth Gateway
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE_BIN $PREFIX/dist/cli.js serve --host 127.0.0.1 --port $PORT
WorkingDirectory=$PREFIX
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

EOF
      systemctl --user daemon-reload
    else
      echo "+ write $SERVICE_FILE"
      echo "+ install manual unit; no service enabled or started"
    fi
  else
    warn "systemd user services unavailable; run manually: $PREFIX/dist/cli.js serve --port $PORT"
  fi
fi

if [[ "$MODE" != "none" && "$PUBLIC_PATH" == "/" && "$FORCE_ROOT" -ne 1 ]]; then
  die "Refusing to mount ROTOXY at the shared Tailscale root '/'. Review route ownership and pass --force-root deliberately."
fi

if [[ "$MODE" != "none" ]]; then
  command -v tailscale >/dev/null 2>&1 || die "Tailscale is required for --mode $MODE. Remove --no-tailscale or use --mode none."
  log "Adding Tailscale $MODE route at $PUBLIC_PATH (existing routes are not reset)…"
  TS_ARGS=("$MODE" --bg --https=443 --set-path="$PUBLIC_PATH" "http://127.0.0.1:$PORT")
  if (( DRY_RUN )); then
    printf '+ tailscale '; printf '%q ' "${TS_ARGS[@]}"; printf '\n'
  else
    if ! tailscale "${TS_ARGS[@]}"; then
      warn "Direct Tailscale configuration failed; retrying with sudo."
      need_sudo tailscale "${TS_ARGS[@]}"
    fi
  fi
fi

cat <<EOF

╭──────────────────────────────────────────────────────────────╮
│ ROTOXY installed                                       │
╰──────────────────────────────────────────────────────────────╯
Gateway:  $PUBLIC_BASE_URL
MCP URL:  $PUBLIC_BASE_URL/mcp
Admin:    $PUBLIC_BASE_URL/admin

Next:
  1. Open the Admin URL.
  2. Set your upstream MCP URL.
  3. Add each provider account as one encrypted bearer credential.
  4. Add ONLY the MCP URL above to ChatGPT.

Useful commands:
  rotoxy doctor
  rotoxy account add --label "Account 1"
  rotoxy account list
  rotoxy pool status
  rotoxy tailscale status

If ~/.local/bin is not on PATH:
  export PATH="\$HOME/.local/bin:\$PATH"
EOF