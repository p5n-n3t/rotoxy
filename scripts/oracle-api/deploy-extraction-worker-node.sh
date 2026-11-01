#!/usr/bin/env bash
set -euo pipefail

root="$1"
release_dir="$2"
release_id="$3"
token_was_present="$4"
container_name=rotoxy-oracle-extraction-worker
compose_file=docker-compose.extraction-worker.yaml
backup="$HOME/.local/state/rotoxy-oracle-extraction-workers/backups/$release_id"
files=(app.py safe_extraction_worker.py requirements.txt Dockerfile.extraction-worker "$compose_file")
rollback_needed=0
had_container=false
old_image_id=""
rollback_tag=""

rollback() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    if [[ "$rollback_needed" == 1 ]]; then
      if [[ "$had_container" != true ]]; then
        (cd "$root" && sudo -n env TS_IP="$(tailscale ip -4)" docker compose -p rotoxy-extraction-worker -f "$compose_file" down --remove-orphans) >/dev/null 2>&1 || true
      fi
      for file in "${files[@]}"; do
        if [[ "$(cat "$backup/$file.present" 2>/dev/null || true)" == yes ]]; then
          sudo -n install -o root -g root -m 644 "$backup/$file" "$root/$file" || true
        else
          sudo -n rm -f "$root/$file" || true
        fi
      done
      if [[ "$had_container" == true ]]; then
        sudo -n docker image tag "$rollback_tag" rotoxy-oracle-extraction-worker:local >/dev/null 2>&1 || true
        (cd "$root" && sudo -n env TS_IP="$(tailscale ip -4)" docker compose -p rotoxy-extraction-worker -f "$compose_file" up -d --no-build extraction-worker) >/dev/null 2>&1 || true
      fi
    fi
    if [[ "$token_was_present" == false && "$had_container" != true ]]; then
      sudo -n rm -f /etc/oracle-api/api-token /etc/oracle-api/api-token.new || true
    fi
    printf 'worker deployment failed; rollback attempted; backup=%s\n' "$backup" >&2
  fi
  exit "$status"
}
trap rollback EXIT

if sudo -n docker inspect "$container_name" >/dev/null 2>&1; then
  had_container=true
  old_image_id="$(sudo -n docker inspect "$container_name" --format '{{.Image}}')"
  rollback_tag="rotoxy-oracle-extraction-worker:rollback-$release_id"
  if [[ ! -f "$root/$compose_file" ]]; then
    printf 'existing worker container has no matching compose file; refusing replacement\n' >&2
    exit 1
  fi
fi

install -d -m 700 "$backup"
for file in "${files[@]}"; do
  if [[ -f "$root/$file" ]]; then
    cp -p "$root/$file" "$backup/$file"
    printf 'yes\n' > "$backup/$file.present"
  else
    printf 'no\n' > "$backup/$file.present"
  fi
  chmod 600 "$backup/$file.present"
  [[ ! -f "$backup/$file" ]] || chmod 600 "$backup/$file"
done
printf '%s\n' "$had_container" > "$backup/had-container"
printf '%s\n' "$old_image_id" > "$backup/old-image-id"
chmod 600 "$backup/had-container" "$backup/old-image-id"
if [[ "$had_container" == true ]]; then
  sudo -n docker image tag "$old_image_id" "$rollback_tag"
fi

rollback_needed=1
for file in "${files[@]}"; do
  sudo -n install -o root -g root -m 644 "$release_dir/$file" "$root/$file"
done
(cd "$root" && sudo -n env TS_IP="$(tailscale ip -4)" docker compose -p rotoxy-extraction-worker -f "$compose_file" build extraction-worker)
(cd "$root" && sudo -n env TS_IP="$(tailscale ip -4)" docker compose -p rotoxy-extraction-worker -f "$compose_file" up -d --no-build extraction-worker)

healthy=false
for attempt in $(seq 1 20); do
  if sudo -n docker inspect "$container_name" --format '{{.State.Health.Status}}' 2>/dev/null | grep -qx healthy; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  printf 'worker container health check timed out\n' >&2
  exit 1
fi

rollback_needed=0
trap - EXIT
printf 'worker healthy; backup=%s\n' "$backup"
