#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${ROTOXY_CONFIG_DIR:-$HOME/.config/rotoxy}"
TOKEN="$CFG/token"
BIN_DIR="$HOME/.local/bin"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
[[ -n "${NO_COLOR:-}" ]] && RED='' GREEN='' YELLOW='' CYAN='' BOLD='' RESET=''
say(){ printf '%s\n' "$*"; }
ok(){ printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
info(){ printf '%s•%s %s\n' "$CYAN" "$RESET" "$*"; }
warn(){ printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die(){ printf '%sERROR:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1; }

install_linux_deps(){
  need curl || {
    if need apt-get; then sudo apt-get update && sudo apt-get install -y curl
    elif need dnf; then sudo dnf install -y curl
    elif need pacman; then sudo pacman -Sy --noconfirm curl
    else die "curl is required and this package manager is not recognized."; fi
  }
  need git || {
    if need apt-get; then sudo apt-get update && sudo apt-get install -y git
    elif need dnf; then sudo dnf install -y git
    elif need pacman; then sudo pacman -S --noconfirm git
    else die "git is required."; fi
  }
  need openssl || {
    if need apt-get; then sudo apt-get update && sudo apt-get install -y openssl
    elif need dnf; then sudo dnf install -y openssl
    elif need pacman; then sudo pacman -S --noconfirm openssl
    else die "openssl is required."; fi
  }
  if ! need node; then
    if need apt-get; then
      info "Installing Node.js 22 LTS through NodeSource."
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif need dnf; then sudo dnf install -y nodejs npm
    elif need pacman; then sudo pacman -S --noconfirm nodejs npm
    else die "Install Node.js 20+ and rerun the installer."; fi
  fi
}

install_macos_deps(){
  need node && return 0
  need brew || die "Homebrew or Node.js 20+ is required on macOS."
  brew install node
}

ensure_pnpm(){
  need pnpm && return 0
  if need corepack; then
    corepack enable 2>/dev/null || sudo corepack enable
    corepack prepare pnpm@10.25.0 --activate
  else
    npm install -g pnpm@10.25.0
  fi
}

install_tailscale(){
  need tailscale && { ok "Tailscale already installed."; return; }
  say
  read -r -p "Install Tailscale for network exposure? [Y/n]: " yn
  [[ "${yn:-Y}" =~ ^[Yy]$ ]] || { warn "Skipping Tailscale; choose localhost-only in ROTOXY setup."; return; }
  case "$(uname -s)" in
    Linux) curl -fsSL https://tailscale.com/install.sh | sh ;;
    Darwin)
      if need brew; then brew install --cask tailscale-app || brew install tailscale
      else die "Install the Tailscale macOS app, then rerun this installer."; fi
      ;;
    *) die "Automatic Tailscale install is supported on Linux/macOS. Install it manually on this OS." ;;
  esac
}

tailscale_auth(){
  need tailscale || return 0
  local state
  state="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).BackendState||"")}catch{}})' || true)"
  [[ "$state" == "Running" ]] && { ok "Tailscale is already authenticated."; return; }

  say
  say "${BOLD}Tailscale authentication${RESET}"
  say "  1) Paste an auth key"
  say "  2) Open the normal browser/device login flow"
  read -r -p "Choose [2]: " choice
  if [[ "${choice:-2}" == "1" ]]; then
    read -r -s -p "Tailscale auth key: " tskey; echo
    [[ -n "$tskey" ]] || die "No auth key entered."
    sudo tailscale up --auth-key="$tskey"
    unset tskey
  else
    sudo tailscale up
  fi
}

main(){
  say "${BOLD}ROTOXY installer${RESET}"
  say "Providers → accounts → pools → routes. One URL by default; advanced named endpoints are optional."
  say

  case "$(uname -s)" in
    Linux) install_linux_deps ;;
    Darwin) install_macos_deps ;;
    *) need node || die "Node.js 20+ is required." ;;
  esac
  ensure_pnpm

  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  (( major >= 20 )) || die "Node.js 20+ required; found $(node -v)."

  info "Installing JavaScript dependencies."
  (cd "$ROOT" && pnpm install --frozen-lockfile)
  info "Building ROTOXY."
  (cd "$ROOT" && pnpm build)

  mkdir -p "$CFG" "$BIN_DIR"
  chmod 700 "$CFG"
  if [[ ! -s "$TOKEN" ]]; then
    umask 077
    openssl rand -hex 32 > "$TOKEN"
    chmod 600 "$TOKEN"
  fi
  install -m 0755 "$ROOT/bin/rotoxy" "$BIN_DIR/rotoxy"

  install_tailscale
  tailscale_auth

  if [[ ! -f "$CFG/config.json" ]]; then
    node "$ROOT/dist/bootstrap-cli.js"
  else
    ok "Existing ROTOXY v2 configuration found; leaving provider secrets intact."
    read -r -p "Open the configuration menu now? [y/N]: " edit
    [[ "${edit:-N}" =~ ^[Yy]$ ]] && node "$ROOT/dist/admin-cli.js" menu || true
  fi

  "$BIN_DIR/rotoxy" up
  say
  read -r -p "Start ROTOXY automatically after reboot/login? [Y/n]: " auto
  [[ "${auto:-Y}" =~ ^[Yy]$ ]] && "$BIN_DIR/rotoxy" autostart on || true

  say
  ok "ROTOXY installation complete."
  say "  Configure: rotoxy configure"
  say "  Models:    rotoxy models"
  say "  Routing:   rotoxy routes"
  say "  Agents:    rotoxy agents"
  say "  Help:      rotoxy help"
}
main "$@"
