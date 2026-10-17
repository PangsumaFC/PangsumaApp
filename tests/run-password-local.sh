#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
wrangler="/home/ubuntu/.npm/_npx/32026684e21afda6/node_modules/.bin/wrangler"
state_dir="$(mktemp -d /tmp/pangsuma-password-local.XXXXXX)"
project_dir="$state_dir/project"
server_pid=""
cleanup() { [[ -n "$server_pid" ]] && kill -- "-$server_pid" 2>/dev/null || true; [[ -n "$server_pid" ]] && wait "$server_pid" 2>/dev/null || true; rm -rf "$state_dir"; }
trap cleanup EXIT INT TERM
mkdir -p "$project_dir"
ln -s "$repo_root/functions" "$project_dir/functions"
ln -s "$repo_root/site" "$project_dir/site"
ln -s "$repo_root/migrations" "$project_dir/migrations"
pepper="$(python3 - <<'PY'
import base64,secrets
print(base64.b64encode(secrets.token_bytes(32)).decode())
PY
)"
export BOOTSTRAP_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export LOCAL_MANAGER_PASSWORD="Mgr-bootstrap-local-$(python3 -c 'import secrets; print(secrets.token_urlsafe(10))')"
cat > "$project_dir/.dev.vars" <<VARS
BOOTSTRAP_TOKEN=$BOOTSTRAP_TOKEN
PASSWORD_PEPPER=$pepper
VARS
port="$(python3 - <<'PY'
import socket
with socket.socket() as s:
 s.bind(('127.0.0.1',0)); print(s.getsockname()[1])
PY
)"
base="http://localhost:$port"
cat > "$project_dir/wrangler.jsonc" <<JSON
{"name":"pangsuma-password-local","compatibility_date":"2026-10-17","pages_build_output_dir":"site","d1_databases":[{"binding":"DB","database_name":"pangsuma-password-local","database_id":"00000000-0000-4000-8000-000000000001","migrations_dir":"migrations"}],"vars":{"PASSKEY_AUTH_ENABLED":"false","WEBAUTHN_PROFILE":"test","WEBAUTHN_ORIGIN":"$base","WEBAUTHN_RP_ID":"localhost","PASSKEY_MANAGER_ID":"00000000-0000-4000-8000-000000000002"}}
JSON
CI=1 "$wrangler" d1 migrations apply pangsuma-password-local --local --config "$project_dir/wrangler.jsonc" --persist-to "$state_dir" >/dev/null
(cd "$project_dir" && exec setsid "$wrangler" pages dev --port "$port" --ip 127.0.0.1 --persist-to "$state_dir") >"$state_dir/wrangler.log" 2>&1 & server_pid=$!
for _ in $(seq 1 60); do curl -fsS "$base/api/health" >/dev/null 2>&1 && break; kill -0 "$server_pid" 2>/dev/null || { cat "$state_dir/wrangler.log" >&2; exit 1; }; sleep 1; done
curl -fsS "$base/api/health" >/dev/null || { cat "$state_dir/wrangler.log" >&2; exit 1; }
export PANGSUMA_LOCAL_URL="$base"
export PYTHONDONTWRITEBYTECODE=1
python3 -B tests/password_flow_e2e.py
