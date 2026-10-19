"""Explicitly approved 0010/0011 production migration; no deploy or restore."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request

ACCOUNT = '37701bf94ab65e121e453b11a23077e9'
DATABASE = 'be808421-88ce-4a48-9dcd-eb0f39ae0314'
NAMES = {'0010_request_numbers.sql', '0011_request_number_receipts.sql'}
TABLES = ['submissions', 'cash_accounts', 'cash_ledger', 'cash_topups', 'cash_reconciliations', 'submission_receipts', 'receipt_dropbox_metadata', 'financial_alert_settings', 'financial_settings_changes', 'audit_events']
PREFIX = 'pangsuma_reqnum_pause_20261019_'
assert os.environ.get('CLOUDFLARE_ACCOUNT_ID') == ACCOUNT, 'Wrong account'
assert os.environ.get('REQUEST_NUMBER_MIGRATION_APPROVAL') == 'MIGRATE-0010-0011', 'Explicit approval input missing'
ROOT = Path(__file__).resolve().parents[1]

def request(path, body=None):
    req = urllib.request.Request('https://api.cloudflare.com/client/v4' + path, data=None if body is None else json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=90) as response:
        result = json.load(response)
    assert result.get('success'), 'Cloudflare request failed'
    return result['result']

def query(sql):
    result = request(f'/accounts/{ACCOUNT}/d1/database/{DATABASE}/query', {'sql': sql})
    assert all(r.get('success') for r in result), 'D1 query failed'
    return [r['results'] for r in result]

def names():
    return {r['name'] for r in query('SELECT name FROM d1_migrations ORDER BY id LIMIT 100;')[0]}

def fingerprint():
    out = {}
    for table in TABLES:
        columns = [r['name'] for r in query(f'PRAGMA table_info("{table}");')[0] if r['name'] != 'request_number']
        count = query(f'SELECT COUNT(*) n FROM "{table}";')[0][0]['n']
        assert count <= 10000, 'Fingerprint pagination bound exceeded'
        quoted = ','.join('"' + c.replace('"', '""') + '"' for c in columns)
        rows = query(f'SELECT {quoted} FROM "{table}" ORDER BY rowid LIMIT 10001;')[0]
        assert len(rows) == count, 'Fingerprint incomplete'
        digest = hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        out[table] = {'rows': count, 'sha256': digest}
    return out

local = {p.name for p in (ROOT / 'migrations').glob('*.sql')}
assert len(local) == 11 and NAMES <= local, 'Unexpected migration set'
EXPECTED_HASHES = {'0010_request_numbers.sql': '9a19f63bad732b073f1eae8be8349153661192892d98805e5d99f3e4bdd03463', '0011_request_number_receipts.sql': '2053cdb6215b5082c26d559e7b07cbefe7c6320ba0fd7e763a28aa03208c48d5'}
assert all(hashlib.sha256((ROOT/'migrations'/name).read_bytes()).hexdigest() == digest for name,digest in EXPECTED_HASHES.items()), 'Unreviewed migration contents'
applied = names()
assert applied == local - NAMES, 'Expected exactly 0010/0011 pending; refusing any other state'
installed = query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'pangsuma_reqnum_pause_20261019_%' ORDER BY name LIMIT 100;")[0]
expected_guards = {PREFIX + table + '_' + op for table in TABLES for op in ['insert', 'update', 'delete']}
assert {r['name'] for r in installed} == expected_guards, 'Write pause must be installed first'
invalid = query("SELECT COUNT(*) n FROM submissions s LEFT JOIN users u ON u.id=s.created_by WHERE u.id IS NULL OR s.type NOT IN ('petty_cash','finance_request') OR strftime('%Y',s.created_at,'+7 hours') IS NULL OR CAST(strftime('%Y',s.created_at,'+7 hours') AS INTEGER) NOT BETWEEN 2000 AND 9999;")[0][0]['n']
assert invalid == 0, 'Invalid legacy rows; refusing backfill'
duplicates = query('SELECT created_by,idempotency_key FROM submissions GROUP BY created_by,idempotency_key HAVING COUNT(*)>1 LIMIT 1;')[0]
assert not duplicates, 'Legacy reservation key collision'
before = fingerprint()
bookmark = request(f'/accounts/{ACCOUNT}/d1/database/{DATABASE}/time_travel/bookmark')['bookmark']
summary = {'database_id': DATABASE, 'before_bookmark': bookmark, 'before': before, 'approved_migrations': sorted(NAMES)}
Path('request-number-production-migration.json').write_text(json.dumps(summary, indent=2) + '\n')
print('Target and 30 write-pause guards verified. Recovery bookmark captured.', flush=True)
print('Legacy submissions:', before['submissions']['rows'], flush=True)
subprocess.run(['npx', '--yes', 'wrangler@4.151.1', 'd1', 'migrations', 'apply', 'pangsuma-app-prod', '--remote'], cwd=ROOT, input='y\n', text=True, check=True)
assert names() == local, 'Migration bookkeeping mismatch'
after = fingerprint()
assert before == after, 'Existing financial, submission, audit or Dropbox data changed'
checks = query("SELECT COUNT(*) total,COUNT(request_number) numbered,COUNT(DISTINCT request_number) unique_numbers FROM submissions; SELECT COUNT(*) total FROM request_number_reservations; SELECT type,year,month,next_value FROM request_number_sequences ORDER BY type,year,month LIMIT 100; SELECT id,request_number FROM submissions ORDER BY id LIMIT 10001; SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('submissions_request_number_required','submissions_request_number_immutable','request_number_reservations_immutable','request_number_reservations_no_delete','receipt_dropbox_metadata_insert_guard') AND (name <> 'receipt_dropbox_metadata_insert_guard' OR instr(sql,'request_number_reservations')>0) LIMIT 10;")
totals = checks[0][0]
assert totals['total'] == totals['numbered'] == totals['unique_numbers'] == checks[1][0]['total'], 'Incomplete or duplicate backfill'
assert len(checks[4]) == 5, 'Number/receipt guards incomplete'
summary.update({'after': after, 'preservation_verified': True, 'totals': totals, 'sequences': checks[2], 'mapping_sha256': hashlib.sha256(json.dumps(checks[3], separators=(',', ':')).encode()).hexdigest(), 'applied_migrations': sorted(names())})
Path('request-number-production-migration.json').write_text(json.dumps(summary, indent=2) + '\n')
print('0010/0011 applied through official migration runner; all existing data fingerprints identical.', flush=True)
print(json.dumps({'totals': totals, 'sequences': checks[2]}), flush=True)
