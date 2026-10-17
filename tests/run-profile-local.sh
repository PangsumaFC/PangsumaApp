#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
wrangler="/home/ubuntu/.npm/_npx/32026684e21afda6/node_modules/.bin/wrangler"
[[ -x "$wrangler" ]] || wrangler="$(command -v wrangler || true)"
[[ -n "$wrangler" ]] || { echo "wrangler is required" >&2; exit 1; }
state_dir="$(mktemp -d /tmp/pangsuma-profile-local.XXXXXX)"
project_dir="$state_dir/project"
server_pid=""
cleanup() { [[ -n "$server_pid" ]] && kill -- "-$server_pid" 2>/dev/null || true; [[ -n "$server_pid" ]] && wait "$server_pid" 2>/dev/null || true; rm -rf "$state_dir"; }
trap cleanup EXIT INT TERM
mkdir -p "$project_dir"
ln -s "$repo_root/functions" "$project_dir/functions"
cp -R "$repo_root/site" "$project_dir/site"
# pages dev's implicit Functions build loses external WASM on its second bundle.
# An explicit Worker directory keeps index.js and the collected WASM together.
timeout -k 3s 30s "$wrangler" pages functions build "$repo_root/functions" \
  --project-directory "$project_dir" --build-output-directory "$project_dir/site" \
  --outdir "$project_dir/site/_worker.js" >/dev/null
test -s "$project_dir/site/_worker.js/index.js"
find "$project_dir/site/_worker.js" -name '*webp_dec.wasm' -size +0c | grep -q .
mkdir -p "$project_dir/migrations"
cp "$repo_root/migrations/0001_initial.sql" "$repo_root/migrations/0002_passkey_auth.sql" "$project_dir/migrations/"
pepper="$(python3 - <<'PY'
import base64, secrets
print(base64.b64encode(secrets.token_bytes(32)).decode())
PY
)"
export BOOTSTRAP_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export LOCAL_MANAGER_PASSWORD="Profile-bootstrap-local-$(python3 -c 'import secrets; print(secrets.token_urlsafe(10))')"
cat > "$project_dir/.dev.vars" <<VARS
BOOTSTRAP_TOKEN=$BOOTSTRAP_TOKEN
PASSWORD_PEPPER=$pepper
VARS
port="$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    print(s.getsockname()[1])
PY
)"
protocol="http"
server_tls=()
if [[ "${PANGSUMA_LOCAL_HTTPS:-0}" == "1" ]]; then
  protocol="https"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -keyout "$project_dir/localhost.key" -out "$project_dir/localhost.crt" \
    -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' >/dev/null 2>&1
  export SSL_CERT_FILE="$project_dir/localhost.crt"
  export CURL_CA_BUNDLE="$project_dir/localhost.crt"
  server_tls=(--local-protocol https --https-key-path "$project_dir/localhost.key" --https-cert-path "$project_dir/localhost.crt")
fi
base="$protocol://localhost:$port"
cat > "$project_dir/wrangler.jsonc" <<JSON
{
  "name": "pangsuma-profile-local",
  "compatibility_date": "2026-10-17",
  "pages_build_output_dir": "site",
  "d1_databases": [{"binding":"DB","database_name":"pangsuma-profile-local","database_id":"00000000-0000-4000-8000-000000000001","migrations_dir":"migrations"}],
  "vars": {"PASSKEY_AUTH_ENABLED":"false","WEBAUTHN_PROFILE":"test","WEBAUTHN_ORIGIN":"$base","WEBAUTHN_RP_ID":"localhost","PASSKEY_MANAGER_ID":"00000000-0000-4000-8000-000000000002"}
}
JSON
if [[ "${1:-}" != "--smoke" ]]; then
  CI=1 timeout -k 3s 30s "$wrangler" d1 migrations apply pangsuma-profile-local --local --config "$project_dir/wrangler.jsonc" --persist-to "$state_dir" >/dev/null
fi
(cd "$project_dir" && exec setsid "$wrangler" pages dev --port "$port" --inspector-port 0 --ip 127.0.0.1 --persist-to "$state_dir" "${server_tls[@]}") >"$state_dir/wrangler.log" 2>&1 & server_pid=$!
for _ in $(seq 1 25); do
  response_code="$(curl --connect-timeout 1 --max-time 2 -s -o "$state_dir/health.json" -w '%{http_code}' "$base/api/health" || true)"
  [[ "$response_code" == "503" ]] && break
  kill -0 "$server_pid" 2>/dev/null || { cat "$state_dir/wrangler.log" >&2; exit 1; }
  sleep 1
done
[[ "$response_code" == "503" ]] || { cat "$state_dir/wrangler.log" >&2; exit 1; }
if [[ "${1:-}" == "--smoke" ]]; then
  python3 - "$state_dir/health.json" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
assert body['error']['code'] == 'migration_required', body
PY
  curl --connect-timeout 1 --max-time 3 -fsS "$base/" >"$state_dir/index.html"
  grep -q 'loginIdentifier' "$state_dir/index.html"
  echo 'PROFILE_WASM_SMOKE_PASS worker_started=1 wasm_packaged=1 health=503_fail_closed static=200 migrations_applied=0'
  exit 0
fi
python3 - "$base" "$state_dir/health.json" <<'PY'
import json, sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen
base, health = sys.argv[1:]
assert json.load(open(health))['error']['code'] == 'migration_required'
for path in ('/api/login', '/api/session', '/api/overview', '/api/users', '/api/profile'):
    req = Request(base + path, method='POST' if path.endswith('/login') else 'GET')
    try:
        urlopen(req, timeout=5)
        raise AssertionError('pre-migration route must fail closed: ' + path)
    except HTTPError as e:
        body = json.load(e)
        assert e.code == 503 and body['error']['code'] == 'migration_required', (path, e.code, body)
print('PROFILE_MIGRATION_PRE_PASS health=503 login=503 session=503 overview=503 users=503 profile=503 raw_sql_errors=0')
PY
cp "$repo_root/migrations/0003_user_profiles.sql" "$repo_root/migrations/0004_manager_submissions.sql" "$project_dir/migrations/"
CI=1 timeout -k 3s 30s "$wrangler" d1 migrations apply pangsuma-profile-local --local --config "$project_dir/wrangler.jsonc" --persist-to "$state_dir" >/dev/null
curl --connect-timeout 1 --max-time 5 -fsS "$base/api/health" >/dev/null || { cat "$state_dir/wrangler.log" >&2; exit 1; }
echo 'PROFILE_MIGRATION_POST_PASS health=200 same_server_recovered=1'
export PANGSUMA_LOCAL_URL="$base"
export PROFILE_REVIEW_DIR="$(mktemp -d /workspace/pangsuma-profile-review.XXXXXX)"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONUNBUFFERED=1
echo "PROFILE_REVIEW_DIR=$PROFILE_REVIEW_DIR"
if [[ "${1:-}" == "--manager-sync" ]]; then
  shift
  timeout -k 5s 150s python3 -B tests/manager_sync_e2e.py "$@"
elif [[ "${1:-}" == "--image-upload" ]]; then
  shift
  timeout -k 5s 90s python3 -B tests/profile_image_e2e.py "$@"
elif [[ "${1:-}" == "--manager-actions" ]]; then
  shift
  timeout -k 5s 120s python3 -B tests/manager_actions_e2e.py "$@"
elif [[ "${1:-}" == "--mobile-download" ]]; then
  shift
  timeout -k 5s 120s python3 -B tests/mobile_download_e2e.py "$@"
else
  timeout -k 5s 180s python3 -B tests/profile_flow_e2e.py "$@"
fi
