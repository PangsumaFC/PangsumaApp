import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../functions/api/[[path]].js';
import { seededFinancialDb, insertSubmission, request } from './local_financial_db.mjs';

async function get(db, path, token) {
  const response = await onRequest({ request: request(path, token), env: { DB: db } });
  return { status: response.status, body: await response.json() };
}
async function create(db, token, key, body) {
  const response = await onRequest({ request: new Request('https://local.test/api/submissions', {
    method: 'POST', headers: { Origin: 'https://local.test', Cookie: `__Host-pangsuma_session=${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body)
  }), env: { DB: db } });
  return { status: response.status, body: await response.json() };
}
const payload = { type: 'finance_request', amountIdr: 1500, date: '2020-02-01', description: 'Keperluan sintetis' };

test('request number uses creation WIB month, not transaction date, and remains stable on replay/status change', async () => {
  const { db, managerToken, userAToken } = await seededFinancialDb();
  const key = 'ba000000-0000-4000-8000-000000000001';
  const before = db.db.prepare('SELECT balance_idr FROM cash_accounts LIMIT 1').get().balance_idr;
  const ledgerCount = db.db.prepare('SELECT COUNT(*) n FROM cash_ledger').get().n;
  const result = await create(db, userAToken, key, payload);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const number = result.body.submission.requestNumber;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', month: '2-digit', year: 'numeric' }).formatToParts(new Date(result.body.submission.createdAt));
  assert.equal(number, `RF${parts.find(p => p.type === 'month').value}${parts.find(p => p.type === 'year').value}000001`);
  const replay = await create(db, userAToken, key, payload);
  assert.equal(replay.status, 200); assert.equal(replay.body.submission.requestNumber, number); assert.equal(replay.body.submission.id, result.body.submission.id);
  const conflict = await create(db, userAToken, key, { ...payload, amountIdr: 2000 });
  assert.equal(conflict.status, 409);
  const approval = await onRequest({ request: new Request(`https://local.test/api/submissions/${result.body.submission.id}/approve`, { method: 'POST', headers: { Origin: 'https://local.test', Cookie: `__Host-pangsuma_session=${managerToken}`, 'Content-Type': 'application/json' }, body: '{}' }), env: { DB: db } });
  assert.equal(approval.status, 200); assert.equal((await approval.json()).submission.requestNumber, number);
  assert.equal(db.db.prepare('SELECT balance_idr FROM cash_accounts LIMIT 1').get().balance_idr, before);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM cash_ledger').get().n, ledgerCount);
});

test('server request-number search covers all pages while retaining ownership, filters, and manager permission', async () => {
  const { db, managerToken, userAToken, userBToken } = await seededFinancialDb();
  for (let i = 1; i <= 13; i++) insertSubmission(db, { id: `ab000000-0000-4000-8000-${String(i).padStart(12, '0')}`, createdBy: i === 13 ? 'user-b' : 'user-a', date: '2025-11-01', createdAt: `2025-11-01T00:00:${String(i).padStart(2, '0')}.000Z`, description: `Synthetic ${i}` });
  const target = db.db.prepare('SELECT request_number FROM submissions WHERE id=?').get('ab000000-0000-4000-8000-000000000001').request_number;
  const first = await get(db, '/submissions', userAToken); assert.equal(first.body.items.length, 5); assert.ok(!first.body.items.some(x => x.requestNumber === target));
  const path = `/submissions?q=${encodeURIComponent(target)}`;
  const owner = await get(db, path, userAToken); assert.equal(owner.status, 200); assert.equal(owner.body.total, 1); assert.equal(owner.body.items[0].requestNumber, target);
  const other = await get(db, path, userBToken); assert.equal(other.status, 200); assert.equal(other.body.total, 0); assert.equal(other.body.items.length, 0);
  const manager = await get(db, `/reports?q=${encodeURIComponent(target)}&type=finance_request&status=pending&start=2025-11-01&end=2025-11-01`, managerToken);
  assert.equal(manager.status, 200); assert.equal(manager.body.total, 1); assert.equal(manager.body.items[0].requestNumber, target);
  const mismatch = await get(db, `${path}&type=petty_cash`, userAToken); assert.equal(mismatch.body.total, 0);
  assert.equal((await get(db, '/reports?q=RF', userAToken)).status, 403);
  assert.equal((await get(db, path, null)).status, 401);
});

test('client-supplied human IDs cannot override server allocation or internal UUID', async () => {
  const { db, userAToken } = await seededFinancialDb();
  const result = await create(db, userAToken, 'ba000000-0000-4000-8000-000000000002', { ...payload, requestNumber: 'RF011900999999', request_number: 'RF011900999999', id: 'chosen-id' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.notEqual(result.body.submission.requestNumber, 'RF011900999999');
  assert.match(result.body.submission.id, /^[0-9a-f-]{36}$/); assert.notEqual(result.body.submission.id, 'chosen-id');
});

test('failed manager cash approval retains its reserved number and retries without duplicate financial rows', async () => {
  const { db, managerToken, userAToken } = await seededFinancialDb();
  const key = 'ba000000-0000-4000-8000-000000000003';
  const cashPayload = { ...payload, type: 'petty_cash' };
  const balance = db.db.prepare('SELECT balance_idr FROM cash_accounts LIMIT 1').get().balance_idr;
  const ledger = db.db.prepare('SELECT COUNT(*) n FROM cash_ledger').get().n;
  const failed = await create(db, managerToken, key, cashPayload);
  assert.equal(failed.status, 409); assert.equal(failed.body.error.code, 'insufficient_petty_cash');
  const reserved = db.db.prepare('SELECT submission_id,request_number FROM request_number_reservations WHERE idempotency_key=?').get(key);
  assert.match(reserved.request_number, /000001$/);
  const retry = await create(db, managerToken, key, cashPayload); assert.equal(retry.status, 409);
  assert.deepEqual(db.db.prepare('SELECT submission_id,request_number FROM request_number_reservations WHERE idempotency_key=?').get(key), reserved);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM submissions').get().n, 0);
  const next = await create(db, userAToken, 'ba000000-0000-4000-8000-000000000004', cashPayload);
  assert.equal(next.status, 201); assert.match(next.body.submission.requestNumber, /000002$/);
  assert.equal(db.db.prepare('SELECT balance_idr FROM cash_accounts LIMIT 1').get().balance_idr, balance);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM cash_ledger').get().n, ledger);
});
