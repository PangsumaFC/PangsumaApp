#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
wrangler="/home/ubuntu/.npm/_npx/32026684e21afda6/node_modules/.bin/wrangler"
[[ -x "$wrangler" ]] || wrangler="$(command -v wrangler || true)"
[[ -n "$wrangler" ]] || { echo "wrangler is required" >&2; exit 1; }
state_dir="$(mktemp -d /tmp/pangsuma-pwa-local.XXXXXX)"
project_dir="$state_dir/project"
server_pid=""
cleanup() { [[ -n "$server_pid" ]] && kill -- "-$server_pid" 2>/dev/null || true; [[ -n "$server_pid" ]] && wait "$server_pid" 2>/dev/null || true; rm -rf "$state_dir"; }
trap cleanup EXIT INT TERM
mkdir -p "$project_dir"
ln -s "$repo_root/functions" "$project_dir/functions"
cp -R "$repo_root/site" "$project_dir/site"
timeout -k 3s 30s "$wrangler" pages functions build "$repo_root/functions" \
  --project-directory "$project_dir" --build-output-directory "$project_dir/site" \
  --outdir "$project_dir/site/_worker.js" >/dev/null
test -s "$project_dir/site/_worker.js/index.js"
find "$project_dir/site/_worker.js" -name '*webp_dec.wasm' -size +0c | grep -q .
mkdir -p "$project_dir/migrations"
cp "$repo_root"/migrations/*.sql "$project_dir/migrations/"
pepper="$(python3 - <<'PY'
import base64, secrets
print(base64.b64encode(secrets.token_bytes(32)).decode())
PY
)"
export BOOTSTRAP_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export LOCAL_MANAGER_PASSWORD="PWA-bootstrap-local-$(python3 -c 'import secrets; print(secrets.token_urlsafe(10))')"
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
  export SSL_CERT_FILE="$project_dir/localhost.crt" CURL_CA_BUNDLE="$project_dir/localhost.crt"
  server_tls=(--local-protocol https --https-key-path "$project_dir/localhost.key" --https-cert-path "$project_dir/localhost.crt")
fi
base="$protocol://localhost:$port"
cat > "$project_dir/wrangler.jsonc" <<JSON
{
  "name": "pangsuma-pwa-local",
  "compatibility_date": "2026-10-17",
  "pages_build_output_dir": "site",
  "d1_databases": [{"binding":"DB","database_name":"pangsuma-pwa-local","database_id":"00000000-0000-4000-8000-000000000001","migrations_dir":"migrations"}],
  "vars": {"PASSKEY_AUTH_ENABLED":"false","WEBAUTHN_PROFILE":"test","WEBAUTHN_ORIGIN":"$base","WEBAUTHN_RP_ID":"localhost","PASSKEY_MANAGER_ID":"00000000-0000-4000-8000-000000000002"}
}
JSON
CI=1 timeout -k 3s 30s "$wrangler" d1 migrations apply pangsuma-pwa-local --local --config "$project_dir/wrangler.jsonc" --persist-to "$state_dir" >/dev/null
(cd "$project_dir" && exec setsid "$wrangler" pages dev --port "$port" --inspector-port 0 --ip 127.0.0.1 --persist-to "$state_dir" "${server_tls[@]}") >"$state_dir/wrangler.log" 2>&1 & server_pid=$!
for _ in $(seq 1 30); do
  code="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' "$base/api/health" || true)"
  [[ "$code" == "200" ]] && break
  kill -0 "$server_pid" 2>/dev/null || { cat "$state_dir/wrangler.log" >&2; exit 1; }
  sleep 1
done
[[ "$code" == "200" ]] || { cat "$state_dir/wrangler.log" >&2; exit 1; }
export PANGSUMA_LOCAL_URL="$base"
export PROFILE_REVIEW_DIR="/workspace/PangsumaApp-artifacts/pwa-20261018"
mkdir -p "$PROFILE_REVIEW_DIR"
export PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Native Android/installed-PWA claims are deliberately not made by this Chromium simulation.
timeout -k 5s 180s python3 -B tests/pwa_standalone_e2e.py "$@"
