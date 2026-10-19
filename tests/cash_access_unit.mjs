import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../functions/api/[[path]].js';

const sessionUser = {
  id: 'user-1', name: 'Local User', email: 'user@example.test', position: 'Staff',
  role: 'user', must_change_password: 0, nickname: '', dashboard_position: null,
  quote: '', has_photo: 0, profile_version: 1, expires_at: '2099-01-01T00:00:00.000Z',
  auth_method: 'password'
};

function fakeDb(user = sessionUser) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      const statement = {
        bind() { return statement; },
        async all() {
          if (/FROM submissions/.test(sql)) return { results: [] };
          return { results: [] };
        },
        async first() {
          if (/FROM sessions/.test(sql)) return user;
          if (/COUNT\(\*\).*FROM submissions/.test(sql)) {
            return { total_count: 0, count: 0, pending_count: 0, petty_cash_count: 0 };
          }
          return null;
        },
        async run() { return { meta: { changes: 0 } }; }
      };
      return statement;
    }
  };
}

async function call(path, db, method = 'GET', body) {
  const request = new Request(`https://local.test/api${path}`, {
    method,
    headers: {
      Cookie: '__Host-pangsuma_session=local-test-token',
      ...(body ? { 'Content-Type': 'application/json', Origin: 'https://local.test' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return onRequest({ request, env: { DB: db } });
}

test('User overview tidak memuat atau meng-query saldo kas', async () => {
  const db = fakeDb();
  const response = await call('/overview', db);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(Object.hasOwn(payload, 'cashBalanceIdr'), false);
  assert.equal(Object.hasOwn(payload, 'cashFlow'), false);
  assert.equal(Object.hasOwn(payload, 'cashLedger'), false);
  assert.equal(Object.hasOwn(payload, 'auditEvents'), false);
  assert.equal(db.calls.some(sql => /cash_accounts|cash_ledger|audit_events/.test(sql)), false);
});

test('User ditolak dari ledger kas, opening balance, dan export', async () => {
  for (const [path, method, body] of [
    ['/history/cash-ledger', 'GET'],
    ['/cash/opening-balance', 'POST', { amountIdr: 1, ownerConfirmed: true }],
    ['/export.pdf', 'GET']
  ]) {
    const db = fakeDb();
    const response = await call(path, db, method, body);
    assert.equal(response.status, 403, path);
    const payload = await response.json();
    assert.equal(payload.error.code, 'manager_required', path);
  }
});

test('Akses User ke history submissions tetap tersedia hanya untuk pengajuannya', async () => {
  const db = fakeDb();
  const response = await call('/history/submissions', db);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.submissions, []);
});
