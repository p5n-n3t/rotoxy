#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
token_file="${ORACLE_API_TOKEN_FILE:-/home/jq/.config/rotoxy/oracle-api-token}"
remote_root="/opt/jq-worker/oracle-api-extraction-workers"
hosts=(ora1 ora3 ora5 ora6 ora7 ora8)
mode="${1:---dry-run}"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
files=(app.py safe_extraction_worker.py requirements.txt Dockerfile.extraction-worker docker-compose.extraction-worker.yaml deploy-extraction-worker-node.sh)

if [[ "$mode" != "--dry-run" && "$mode" != "--execute" ]]; then
  printf 'usage: %s [--dry-run|--execute]\n' "$0" >&2
  exit 2
fi
if [[ ! -r "$token_file" || ! -s "$token_file" ]]; then
  printf 'private Oracle API token file is unavailable or empty\n' >&2
  exit 1
fi
if [[ "$(stat -c %a "$token_file")" != "600" ]]; then
  printf 'private Oracle API token file must have mode 600\n' >&2
  exit 1
fi

for host in "${hosts[@]}"; do
  printf '%s: %s safe extraction worker on Tailnet port 8878\n' "$host" "$mode"
  if [[ "$mode" == "--dry-run" ]]; then
    continue
  fi

  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$host" 'sudo -n install -d -o root -g root -m 700 /etc/oracle-api && sudo -n install -d -o root -g root -m 755 /opt/jq-worker/oracle-api-extraction-workers/releases'

  token_was_present=true
  token_state="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$host" 'sudo -n sh -c '\''if [ -f /etc/oracle-api/api-token ]; then printf present; else printf absent; fi'\''')"
  if [[ "$token_state" == present ]]; then
    token_metadata="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$host" 'sudo -n stat -c "%a:%U:%G" /etc/oracle-api/api-token')"
    if [[ "$token_metadata" != "600:root:root" ]]; then
      printf '%s: existing token permissions are not root-only mode 600; refusing to change them\n' "$host" >&2
      exit 1
    fi
    set +e
    ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$host" 'sudo -n cmp -s /etc/oracle-api/api-token -' < "$token_file"
    compare_status=$?
    set -e
    if [[ "$compare_status" -ne 0 ]]; then
      printf '%s: existing API token differs; refusing to overwrite it\n' "$host" >&2
      exit 1
    fi
  elif [[ "$token_state" == absent ]]; then
    token_was_present=false
  else
    printf '%s: unable to determine existing API token state; aborting\n' "$host" >&2
    exit 1
  fi

  release_dir="$remote_root/releases/$release_id"
  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$host" "sudo -n install -d -o root -g root -m 755 '$release_dir'"
  tar -C "$root" -czf - "${files[@]}" |
    ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$host" "sudo -n tar -xzf - -C '$release_dir'"

  if [[ "$token_was_present" == false ]]; then
    ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$host" 'sudo -n sh -c '\''umask 077; cat > /etc/oracle-api/api-token.new && chown root:root /etc/oracle-api/api-token.new && chmod 600 /etc/oracle-api/api-token.new && mv /etc/oracle-api/api-token.new /etc/oracle-api/api-token'\''' < "$token_file"
  fi

  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$host" bash "$release_dir/deploy-extraction-worker-node.sh" "$remote_root" "$release_dir" "$release_id" "$token_was_present"
done

if [[ "$mode" == "--execute" ]]; then
  printf 'all safe extraction workers are healthy\n'
fi
