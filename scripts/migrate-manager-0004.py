"""Manual, explicitly approved production migration 0004. No application deploy."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request

ACCOUNT = "37701bf94ab65e121e453b11a23077e9"
DATABASE = "be808421-88ce-4a48-9dcd-eb0f39ae0314"
NAME = "0004_manager_submissions.sql"
EXPECTED_SHA256 = "20fcbcbec1b42a87752d22f80c3c83669b8c98021c1e62b924a058fba355e273"
PRIOR = {"0001_initial.sql", "0002_passkey_auth.sql", "0003_user_profiles.sql"}
assert os.environ.get("CLOUDFLARE_ACCOUNT_ID") == ACCOUNT, "Wrong account"
assert hashlib.sha256(Path("migrations", NAME).read_bytes()).hexdigest() == EXPECTED_SHA256, "Unreviewed migration contents"


def query(sql):
    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DATABASE}/query",
        data=json.dumps({"sql": sql}).encode(),
        headers={"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"], "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.load(response)
    assert payload.get("success") and all(row.get("success") for row in payload["result"]), "D1 query failed"
    return payload["result"][0]["results"]


def verify():
    rows = query("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name IN ('submissions_user_only', 'submissions_active_account_only')")
    assert len(rows) == 1 and rows[0]["name"] == "submissions_active_account_only", "Unexpected submission triggers"
    sql = rows[0]["sql"]
    assert "role IN ('user', 'manager')" in sql and "is_active = 1" in sql and "active_account_required_to_submit" in sql, "Trigger definition mismatch"
    print("Verified: active User/Manager trigger installed; legacy trigger absent.", flush=True)


applied = {row["name"] for row in query("SELECT name FROM d1_migrations ORDER BY id")}
assert PRIOR <= applied, "Prior migrations missing; refusing to apply unrelated migrations"
assert applied <= PRIOR | {NAME}, "Unexpected migration history"
assert {p.name for p in Path("migrations").glob("*.sql")} == PRIOR | {NAME}, "Unexpected local migration files"
print("Target verified: pangsuma-app-prod / " + DATABASE, flush=True)
print("Applied migrations: " + ", ".join(sorted(applied)), flush=True)
if NAME in applied:
    verify()
    print("0004 already applied; no mutation needed.", flush=True)
else:
    old = query("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('submissions_user_only', 'submissions_active_account_only')")
    assert [r["name"] for r in old] == ["submissions_user_only"], "Unexpected pre-migration trigger state"
    # Capture a recovery point before changing schema; never restore automatically.
    subprocess.run(["npx", "--yes", "wrangler@4.151.1", "d1", "time-travel", "info", "pangsuma-app-prod", "--json"], check=True)
    subprocess.run(["npx", "--yes", "wrangler@4.151.1", "d1", "migrations", "apply", "pangsuma-app-prod", "--remote"], input="y\n", text=True, check=True)
    assert {r["name"] for r in query("SELECT name FROM d1_migrations ORDER BY id")} == PRIOR | {NAME}, "Migration tracking mismatch"
    verify()
    print("Migration 0004 completed. No application deploy performed.", flush=True)
