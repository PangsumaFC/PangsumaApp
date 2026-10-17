#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

vars_file="$repo_root/tests/.dev.vars"
created_vars=0
state_dir="$(mktemp -d /tmp/pangsuma-passkeys-local.XXXXXX)"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill -- "-$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ "$created_vars" == "1" ]]; then rm -f "$vars_file"; fi
  rm -rf "$state_dir"
}
trap cleanup EXIT INT TERM

if [[ ! -f "$vars_file" ]]; then
  python3 - <<'PY' > "$vars_file"
import secrets, base64
for name in (
    "BOOTSTRAP_TOKEN",
    "LOCAL_MANAGER_PASSWORD",
    "LOCAL_USER_TEMP_PASSWORD",
    "LOCAL_USER_NEW_PASSWORD",
    "LOCAL_SECOND_TEMP_PASSWORD",
    "LOCAL_SECOND_NEW_PASSWORD",
    "MANAGER_ENROLLMENT_SECRET",
    "PASSWORD_PEPPER",
):
    print(name + "=" + (base64.b64encode(secrets.token_bytes(32)).decode() if name == "PASSWORD_PEPPER" else secrets.token_urlsafe(48)))
PY
  chmod 600 "$vars_file"
  created_vars=1
fi
if ! grep -q '^PASSWORD_PEPPER=' "$vars_file"; then
  python3 - <<'PY' >> "$vars_file"
import secrets, base64
print("PASSWORD_PEPPER=" + base64.b64encode(secrets.token_bytes(32)).decode())
PY
fi
if ! grep -q '^BOOTSTRAP_TOKEN=' "$vars_file" || ! grep -q '^MANAGER_ENROLLMENT_SECRET=' "$vars_file"; then
  echo "tests/.dev.vars must contain local BOOTSTRAP_TOKEN and MANAGER_ENROLLMENT_SECRET values." >&2
  exit 1
fi

project_dir="$state_dir/project"
mkdir -p "$project_dir"
cp -a "$repo_root/functions" "$project_dir/functions"
cp -a "$repo_root/site" "$project_dir/site"
ln -s "$repo_root/node_modules" "$project_dir/node_modules"
ln -s "$repo_root/migrations" "$project_dir/migrations"
ln -s "$vars_file" "$project_dir/.dev.vars"
port="$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
)"
base_url="http://localhost:$port"
cat > "$project_dir/wrangler.jsonc" <<JSON
{
  "name": "pangsuma-app-local-test",
  "compatibility_date": "2026-10-17",
  "pages_build_output_dir": "site",
  "d1_databases": [{
    "binding": "DB",
    "database_name": "pangsuma-app-local-test",
    "database_id": "00000000-0000-4000-8000-000000000001",
    "migrations_dir": "migrations"
  }],
  "vars": {
    "PASSKEY_AUTH_ENABLED": "true",
    "WEBAUTHN_PROFILE": "test",
    "WEBAUTHN_ORIGIN": "$base_url",
    "WEBAUTHN_RP_ID": "localhost",
    "PASSKEY_MANAGER_ID": "00000000-0000-4000-8000-000000000002"
  }
}
JSON

CI=1 npx wrangler d1 migrations apply pangsuma-app-local-test \
  --local --config tests/wrangler.local.toml --persist-to "$state_dir"

(
  cd "$project_dir"
  exec setsid npx wrangler pages dev --port "$port" --ip 127.0.0.1 --persist-to "$state_dir"
) > "$state_dir/wrangler.log" 2>&1 &
server_pid=$!
ready=0
for _ in $(seq 1 60); do
  if curl --connect-timeout 1 --max-time 3 --silent --fail "$base_url/api/health" >/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  cat "$state_dir/wrangler.log" >&2
  echo "Isolated local Pages Functions server did not become ready." >&2
  exit 1
fi

export PANGSUMA_LOCAL_URL="$base_url"
export PANGSUMA_LOCAL_STATE_DIR="$state_dir"
export PROFILE_REVIEW_DIR="${PROFILE_REVIEW_DIR:-$state_dir/screenshots}"
set -a
source "$vars_file"
set +a
export PYTHONDONTWRITEBYTECODE=1
node tests/webauthn_unit.mjs
node tests/passkey_rollout_unit.mjs
if [[ "${1:-}" == "--dashboard-design" ]]; then
  node tests/dashboard_design_unit.mjs
  timeout -k 5s 150s python3 -B tests/dashboard_design_e2e.py
elif [[ "${1:-}" == "--manager-only" ]]; then
  python3 -B tests/manager_passkey_e2e.py
else
  if [[ "${1:-}" != "--passkeys-only" ]]; then python3 -B tests/e2e_local.py; fi
  python3 -B tests/manager_passkey_e2e.py
fi
