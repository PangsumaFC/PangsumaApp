import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';
import { createSession, sha256Hex } from '../functions/_lib/auth.js';
import { seededFinancialDb, insertSubmission, request } from './local_financial_db.mjs';

const env = { PASSWORD_PEPPER: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };

test('description shorter than three characters returns clean 400 validation', async () => {
  const { db, userAToken } = await seededFinancialDb();
  const req = new Request('https://local.test/api/submissions', {
    method: 'POST',
    headers: { Origin: 'https://local.test', Cookie: `__Host-pangsuma_session=${userAToken}`, 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'petty_cash', amountIdr: 1, date: '2028-01-01', description: 'ab' })
  });
  const response = await onRequest({ request: req, env: { DB: db, ...env } });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_description');
});

test('users endpoint exposes bounded pagination and total', async () => {
  const { db, managerToken } = await seededFinancialDb();
  const response = await onRequest({ request: request('/users', managerToken, { query: '?page=2&limit=1' }), env: { DB: db } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.page, 2); assert.equal(body.limit, 1); assert.equal(body.total, 3);
  assert.equal(body.hasMore, true); assert.equal(body.users.length, 1);
});

test('submissions endpoint applies q/status/kind/date filters server-side', async () => {
  const { db, managerToken } = await seededFinancialDb();
  insertSubmission(db, { id: crypto.randomUUID(), description: 'Target Alpha', status: 'approved', type: 'finance_request', date: '2028-02-01' });
  insertSubmission(db, { id: crypto.randomUUID(), description: 'Other', status: 'pending', type: 'petty_cash', date: '2028-01-01' });
  const response = await onRequest({ request: request('/submissions', managerToken, { query: '?q=Target&status=approved&kind=finance_request&date=2028-02-01' }), env: { DB: db } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.submissions.length, 1);
  assert.equal(body.submissions[0].description, 'Target Alpha');
});

test('conditional session insert refuses a session after password rotation', async () => {
  const { db } = await seededFinancialDb();
  const oldHash = 'old-password-hash';
  db.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(oldHash, 'user-a');
  db.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run('new-password-hash', 'user-a');
  const session = await createSession(db, 'user-a', { expectedPasswordHash: oldHash });
  assert.equal(session, null);
  const row = db.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get('user-a');
  assert.equal(row.count, 1);
});
