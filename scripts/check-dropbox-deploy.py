#!/usr/bin/env python3
"""Read-only deployment gate. Never applies schema or prints secret values."""
import json
import os
import urllib.error
import urllib.request

ACCOUNT = '37701bf94ab65e121e453b11a23077e9'
DATABASE = 'be808421-88ce-4a48-9dcd-eb0f39ae0314'
EXPECTED = {
    'receipt_dropbox_metadata_insert_guard', 'receipt_dropbox_identity_immutable',
    'receipt_dropbox_ready_immutable', 'receipt_dropbox_active_owner',
    'receipt_dropbox_ready_audit', 'receipt_dropbox_delete_guard',
}
assert os.environ.get('CLOUDFLARE_ACCOUNT_ID') == ACCOUNT, 'Wrong Cloudflare account'


def api(path, body=None):
    request = urllib.request.Request(
        'https://api.cloudflare.com/client/v4' + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'],
                 'Content-Type': 'application/json'},
        method='POST' if body is not None else 'GET',
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = json.load(response)
    except Exception:
        raise SystemExit('Dropbox deployment preflight API request failed (details suppressed).')
    if not payload.get('success'):
        raise SystemExit('Dropbox deployment preflight API returned failure (details suppressed).')
    return payload['result']


project = api(f'/accounts/{ACCOUNT}/pages/projects/pangsuma-app')
variables = project['deployment_configs']['production']['env_vars']
for name in ('DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN'):
    assert variables.get(name, {}).get('type') == 'secret_text', f'Missing server secret: {name}'
assert variables.get('DROPBOX_RECEIPTS_ENABLED', {}).get('value') == 'true', 'Dropbox feature flag not enabled'
result = api(f'/accounts/{ACCOUNT}/d1/database/{DATABASE}/query', {
    'sql': "SELECT receipt_id,dropbox_path,file_id,public_url,state,created_at,completed_at FROM receipt_dropbox_metadata LIMIT 0; "
           "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='receipt_dropbox_metadata' ORDER BY name LIMIT 20; "
           "SELECT name FROM d1_migrations WHERE name='0009_receipt_dropbox_metadata.sql' LIMIT 1;"
})
assert len(result) == 3 and all(item.get('success') for item in result), 'Dropbox metadata probe failed'
assert {row['name'] for row in result[1]['results']} == EXPECTED, 'Dropbox metadata guard set mismatch'
assert result[2]['results'], 'Approved migration 0009 is not tracked'
print('Dropbox deployment preflight passed: approved schema, six guards, encrypted secrets, feature flag.')
