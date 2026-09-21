#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HOME/.config/rotoxy"; CONF="$CFG/config.env"; TOKEN="$CFG/token"
CONFIG_ONLY=0; [[ "${1:-}" == "--configure-only" ]] && CONFIG_ONLY=1
say(){ printf '%s\n' "$*"; }
die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1; }
prompt(){ local var="$1" msg="$2" def="${3:-}" val; read -r -p "$msg${def:+ [$def]}: " val; printf -v "$var" '%s' "${val:-$def}"; }

install_deps_linux(){
  need curl || { sudo apt-get update; sudo apt-get install -y curl; }
  need git || { sudo apt-get update; sudo apt-get install -y git; }
  need openssl || { sudo apt-get update; sudo apt-get install -y openssl; }
  if ! need node; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  if ! need pnpm; then
    corepack enable 2>/dev/null || sudo corepack enable
    corepack prepare pnpm@10.25.0 --activate
  fi
}
install_tailscale(){
  need tailscale && return 0
  read -r -p "Install Tailscale now? [Y/n]: " yn
  [[ "${yn:-Y}" =~ ^[Yy]$ ]] || return 0
  case "$(uname -s)" in
    Linux) curl -fsSL https://tailscale.com/install.sh | sh ;;
    Darwin) die "Install Tailscale for macOS, then rerun." ;;
    *) die "Automatic Tailscale install currently supports Linux only." ;;
  esac
}
tailscale_auth(){
  need tailscale || return 0
  if tailscale status --json 2>/dev/null | grep -q '"BackendState":"Running"'; then say "Tailscale already authenticated."; return 0; fi
  say "Tailscale authentication:"; say "  1) Paste auth key"; say "  2) Browser login"
  read -r -p "Choose [2]: " choice
  if [[ "${choice:-2}" == 1 ]]; then
    read -r -s -p "Tailscale auth key: " tskey; echo
    [[ -n "$tskey" ]] || die "No auth key entered."
    sudo tailscale up --auth-key="$tskey"; unset tskey
  else sudo tailscale up; fi
}
provider_config(){
  STATIC='{}'
  say "Provider:"; say "  1) Ollama Cloud (default)"; say "  2) OpenAI-compatible"; say "  3) Anthropic"; say "  4) OpenRouter"; say "  5) Groq"; say "  6) Together"; say "  7) DeepSeek"; say "  8) Mistral"; say "  9) Generic/custom"
  read -r -p "Choose [1]: " choice
  case "${choice:-1}" in
    1) PROVIDER=ollama; BASE=https://ollama.com; HEADER=Authorization; PREFIX="Bearer " ;;
    2) PROVIDER=openai; BASE=https://api.openai.com; HEADER=Authorization; PREFIX="Bearer " ;;
    3) PROVIDER=anthropic; BASE=https://api.anthropic.com; HEADER=x-api-key; PREFIX=""; STATIC='{"anthropic-version":"2023-06-01"}' ;;
    4) PROVIDER=openrouter; BASE=https://openrouter.ai; HEADER=Authorization; PREFIX="Bearer " ;;
    5) PROVIDER=groq; BASE=https://api.groq.com/openai; HEADER=Authorization; PREFIX="Bearer " ;;
    6) PROVIDER=together; BASE=https://api.together.xyz; HEADER=Authorization; PREFIX="Bearer " ;;
    7) PROVIDER=deepseek; BASE=https://api.deepseek.com; HEADER=Authorization; PREFIX="Bearer " ;;
    8) PROVIDER=mistral; BASE=https://api.mistral.ai; HEADER=Authorization; PREFIX="Bearer " ;;
    9) PROVIDER=generic; prompt BASE "Destination base URL" "https://api.example.com"; prompt HEADER "Authentication header" "Authorization"; prompt PREFIX "Authentication prefix" "Bearer " ;;
    *) die "Invalid provider selection." ;;
  esac
}
collect_keys(){
  KEYS=(); NAMES=(); local i=1 k
  say "Paste provider API keys. Leave an entry blank to finish."
  while :; do
    read -r -s -p "Account $i API key: " k; echo
    [[ -n "$k" ]] || break
    KEYS+=("$k"); NAMES+=("Account $i"); ((i++))
  done
  ((${#KEYS[@]})) || die "At least one API key is required."
}
exposure_config(){
  say "Tailscale exposure:"; say "  1) Serve: tailnet-only HTTPS (recommended)"; say "  2) Funnel: public HTTPS protected by ROTOXY token"; say "  3) Local only"
  read -r -p "Choose [1]: " exposure
  case "${exposure:-1}" in 1) EXPOSURE=serve;; 2) EXPOSURE=funnel;; 3) EXPOSURE=none;; *) die "Invalid exposure selection.";; esac
}
write_env(){
  local key_csv name_csv
  key_csv="$(IFS=,; echo "${KEYS[*]}")"; name_csv="$(IFS=,; echo "${NAMES[*]}")"
  umask 077
  cat > "$ROOT/.env" <<EOF
SERVICE_HOST=127.0.0.1
SERVICE_PORT=2025
ROTOXY_PROVIDER=$PROVIDER
DST_BASE_URL=$BASE
ROTOXY_AUTH_HEADER=$HEADER
ROTOXY_AUTH_PREFIX=$PREFIX
ROTOXY_STATIC_HEADERS_JSON=$STATIC
API_KEYS=$key_csv
ACCOUNT_NAMES=$name_csv
ROTOXY_ROTATION=round-robin
ROTOXY_COOLDOWN_SECONDS=60
ROTOXY_METER_BUDGET_TOKENS=1000000
ROTOXY_CLIENT_TOKEN_FILE=~/.config/rotoxy/token
EOF
  chmod 600 "$ROOT/.env"
}
write_runtime(){
  mkdir -p "$CFG" "$HOME/.local/bin"
  cat > "$CONF" <<EOF
ROTOXY_BACKEND_PORT=2025
ROTOXY_EXPOSURE=$EXPOSURE
ROTOXY_START_CMD=pnpm\ start
EOF
  chmod 600 "$CONF"
  if [[ ! -s "$TOKEN" ]]; then openssl rand -hex 32 >"$TOKEN"; chmod 600 "$TOKEN"; fi
  install -m 0755 "$ROOT/bin/rotoxy" "$HOME/.local/bin/rotoxy"
}
main(){
  say "ROTOXY installer"; say "==============="
  if [[ "$CONFIG_ONLY" == 0 ]]; then
    case "$(uname -s)" in
      Linux) install_deps_linux ;;
      Darwin) need node || die "Node.js 20+ required."; need pnpm || corepack prepare pnpm@10.25.0 --activate ;;
      *) die "Unsupported OS." ;;
    esac
    install_tailscale; tailscale_auth
  fi
  provider_config; collect_keys; exposure_config; write_env; write_runtime
  (cd "$ROOT" && pnpm install && pnpm build)
  say "ROTOXY configured. Run: rotoxy up"
}
main "$@"
