import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { onRequest } from '../functions/api/[[path]].js';
import { seededFinancialDb, insertSubmission, request } from './local_financial_db.mjs';

async function insights(db, token, query = '?today=2028-02-29', env = {}) {
  const response = await onRequest({ request: request('/cash/insights', token, { query }), env: { DB: db, ...env } });
  return { status: response.status, data: await response.json() };
}

test('cash insights uses full ledger, exact daily balances, WIB boundaries and nullable minimum', async () => {
  const { db, managerToken } = await seededFinancialDb();
  db.db.prepare("UPDATE cash_accounts SET balance_idr = 500 WHERE id='operational'").run();
  db.db.prepare(`INSERT INTO cash_ledger (event_type,direction,amount_idr,balance_after_idr,actor_id,created_at,note) VALUES ('opening_balance','credit',500,500,'manager-1','2028-02-28T16:59:59.000Z','Saldo awal lokal')`).run();
  const topup = db.db.prepare('INSERT INTO cash_topups (id,manager_id,idempotency_key,payload_hash,amount_idr,note,created_at) VALUES (?,?,?,?,?,?,?)');
  topup.run(randomUUID(), 'manager-1', 'initial-topup', 'a'.repeat(64), 1500, 'Transfer lokal', '2028-02-28T17:00:00.000Z');
  const id = randomUUID();
  insertSubmission(db, { id, type: 'petty_cash', amount: 250, date: '2028-02-29', createdAt: '2028-02-29T03:00:00.000Z' });
  db.db.prepare("UPDATE submissions SET status='approved', resolved_by='manager-1', updated_by='manager-1', updated_at='2028-02-29T04:00:00.000Z' WHERE id=?").run(id);
  db.db.exec('BEGIN');
  for (let i = 0; i < 501; i++) topup.run(randomUUID(), 'manager-1', `extra-${i}`, 'b'.repeat(64), 1, 'Tambahan lokal', '2028-02-29T05:00:00.000Z');
  db.db.exec('COMMIT');
  const result = await insights(db, managerToken);
  assert.equal(result.status, 200);
  const data = result.data;
  const expected = 500 + 1500 + 501 - 250;
  assert.equal(data.account.balanceIdr, String(expected));
  assert.deepEqual(data.totals, { openingIdr: '500', topupsIdr: String(1500 + 501), outgoingIdr: '250' });
  assert.equal(data.accounting.isBalanced, true);
  assert.equal(data.accounting.discrepancyIdr, '0');
  assert.equal(data.minimumIdr, null);
  const day = data.daily.find(row => row.day === '2028-02-29');
  assert.equal(day.openingIdr, '500');
  assert.equal(day.closingIdr, String(expected));
  assert.equal(day.incomingIdr, String(1500 + 501));
  assert.equal(day.outgoingIdr, '250');
  assert.equal(day.rowCount, 501 + 2);
  assert.equal(data.daily.find(row => row.day === '2028-02-28').closingIdr, '500');
  assert.equal(data.trend.days.length, 60);
  assert.equal(data.trend.outgoingIdr, '250');
  assert.equal(data.trend.precedingOutgoingIdr, '0');
  assert.equal((await insights(db, managerToken, '?today=2028-02-29', { CASH_MINIMUM_IDR: '1000' })).data.minimumIdr, '1000');
  db.db.prepare("UPDATE cash_accounts SET balance_idr=balance_idr+1 WHERE id='operational'").run();
  const mismatch = (await insights(db, managerToken)).data.accounting;
  assert.equal(mismatch.isBalanced, false);
  assert.equal(mismatch.discrepancyIdr, '1');
});

test('cash insights denies User and unauthenticated requests and validates calendar dates', async () => {
  const { db, managerToken, userAToken } = await seededFinancialDb();
  assert.equal((await insights(db, userAToken)).status, 403);
  assert.equal((await insights(db, '')).status, 401);
  assert.equal((await insights(db, managerToken, '?today=2027-02-29')).status, 400);
  const response = await onRequest({ request: request('/cash/insights', managerToken, { method: 'POST' }), env: { DB: db } });
  assert.equal(response.status, 405);
});
