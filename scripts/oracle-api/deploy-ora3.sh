#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
remote="ora3"
app_stage="/tmp/oracle-api-app.py.$$"
compose_stage="/tmp/oracle-api-compose.yaml.$$"
dockerfile_stage="/tmp/oracle-api-Dockerfile.$$"
requirements_stage="/tmp/oracle-api-requirements.txt.$$"
dockerignore_stage="/tmp/oracle-api-dockerignore.$$"
searx_settings_stage="/tmp/oracle-api-searx-settings.$$"

ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$remote" "cat > '$app_stage'" < "$root/app.py"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$remote" "cat > '$compose_stage'" < "$root/docker-compose.yaml"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$remote" "cat > '$dockerfile_stage'" < "$root/Dockerfile"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$remote" "cat > '$requirements_stage'" < "$root/requirements.txt"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$remote" "cat > '$dockerignore_stage'" < "$root/.dockerignore"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$remote" "cat > '$searx_settings_stage'" < "$root/searxng/settings.yml"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$remote" bash -s -- "$app_stage" "$compose_stage" "$dockerfile_stage" "$requirements_stage" "$dockerignore_stage" "$searx_settings_stage" <<'REMOTE'
set -euo pipefail
app_stage="$1"
compose_stage="$2"
dockerfile_stage="$3"
requirements_stage="$4"
dockerignore_stage="$5"
searx_settings_stage="$6"
root=/opt/jq-worker/oracle-api
cd "$root"
install -d -m 700 searxng
if [ ! -f .env ]; then
  printf 'ORACLE_API_TOKEN=%s\n' "$(cat /etc/oracle-api/api-token)" > .env
  printf 'TS_IP=%s\n' "$(tailscale ip -4)" >> .env
  chmod 600 .env
fi
if ! grep -q '^SEARXNG_SECRET=' .env; then
  printf 'SEARXNG_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
  chmod 600 .env
fi
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$root/backups/oracle-api-$stamp"
install -d -m 700 "$backup"
cp -p app.py "$backup/app.py"
cp -p docker-compose.yaml "$backup/docker-compose.yaml"
cp -p Dockerfile "$backup/Dockerfile"
cp -p .env "$backup/.env"
if [ -f searxng/settings.yml ]; then cp -p searxng/settings.yml "$backup/searxng-settings.yml"; fi
if [ -f requirements.txt ]; then
  cp -p requirements.txt "$backup/requirements.txt"
  printf 'present\n' > "$backup/requirements-state"
else
  printf 'absent\n' > "$backup/requirements-state"
fi
if [ -f .dockerignore ]; then
  cp -p .dockerignore "$backup/.dockerignore"
  printf 'present\n' > "$backup/dockerignore-state"
else
  printf 'absent\n' > "$backup/dockerignore-state"
fi
chmod 600 "$backup/app.py" "$backup/docker-compose.yaml" "$backup/Dockerfile" "$backup/.env" "$backup/requirements-state"
[ ! -f "$backup/requirements.txt" ] || chmod 600 "$backup/requirements.txt"
[ ! -f "$backup/.dockerignore" ] || chmod 600 "$backup/.dockerignore"
[ ! -f "$backup/searxng-settings.yml" ] || chmod 600 "$backup/searxng-settings.yml"
chmod 600 "$backup/dockerignore-state"
previous_image="$(docker image inspect oracle-api:local --format '{{.Id}}')"
rollback_tag="oracle-api:rollback-$stamp"
docker image tag "$previous_image" "$rollback_tag"
printf '%s\n' "$previous_image" > "$backup/previous-image-id"
printf '%s\n' "$rollback_tag" > "$backup/rollback-image-tag"
chmod 600 "$backup/previous-image-id" "$backup/rollback-image-tag"
install -m 644 "$app_stage" "$root/app.py"
install -m 644 "$compose_stage" "$root/docker-compose.yaml"
install -m 644 "$dockerfile_stage" "$root/Dockerfile"
install -m 644 "$requirements_stage" "$root/requirements.txt"
install -m 644 "$dockerignore_stage" "$root/.dockerignore"
install -m 644 "$searx_settings_stage" "$root/searxng/settings.yml"
rm -f "$app_stage" "$compose_stage" "$dockerfile_stage" "$requirements_stage" "$dockerignore_stage" "$searx_settings_stage"
rollback() {
  status=$?
  if [ "$status" -ne 0 ]; then
    cp -p "$backup/app.py" "$root/app.py"
    cp -p "$backup/docker-compose.yaml" "$root/docker-compose.yaml"
    cp -p "$backup/Dockerfile" "$root/Dockerfile"
    cp -p "$backup/.env" "$root/.env"
    if [ -f "$backup/searxng-settings.yml" ]; then cp -p "$backup/searxng-settings.yml" "$root/searxng/settings.yml"; fi
    if [ "$(cat "$backup/requirements-state")" = "present" ]; then
      cp -p "$backup/requirements.txt" "$root/requirements.txt"
    else
      rm -f "$root/requirements.txt"
    fi
    if [ "$(cat "$backup/dockerignore-state")" = "present" ]; then
      cp -p "$backup/.dockerignore" "$root/.dockerignore"
    else
      rm -f "$root/.dockerignore"
    fi
    docker image tag "$rollback_tag" oracle-api:local
    docker compose up -d --no-deps oracle-api searxng >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap rollback EXIT
docker compose build oracle-api
docker compose up -d --no-deps searxng oracle-api
for attempt in $(seq 1 30); do
  if curl --silent --show-error --fail http://127.0.0.1:8877/health >/dev/null && docker inspect oracle-searxng --format '{{.State.Health.Status}}' 2>/dev/null | grep -qx healthy; then
    printf 'oracle-api healthy; backup=%s\n' "$backup"
    trap - EXIT
    exit 0
  fi
  sleep 2
done
printf 'oracle-api health check timed out; automatic rollback started\n' >&2
exit 1
REMOTE
