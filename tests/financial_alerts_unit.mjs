import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { seededFinancialDb, insertSubmission } from './local_financial_db.mjs';
import { getFinancialSettings, updateFinancialSettings, getFinancialAlerts, findPotentialDuplicates } from '../functions/_lib/financial-alerts.js';

async function fixture() {
  const f = await seededFinancialDb();
  f.db.db.exec(fs.readFileSync(new URL('../migrations/0008_financial_alert_settings.sql', import.meta.url), 'utf8'));
  return f;
}
const manager = { id: 'manager-1', role: 'manager' };
const alpha = { id: 'user-a', role: 'user' };
const key = '123e4567-e89b-12d3-a456-426614174000';

test('settings start unset and update exactly one audited version', async () => {
  const { db } = await fixture();
  const initial = await getFinancialSettings({}, db, manager);
  assert.equal(initial.minimumCashIdr, null);
  assert.equal(initial.pendingMaxDays, null);
  assert.equal(initial.version, 0);
  assert.equal(initial.updatedBy, null);
  assert.match(initial.updatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(initial.scope, 'organization');
  const changed = await updateFinancialSettings({ body: { minimumCashIdr: '5000', pendingMaxDays: 7, expectedVersion: 0 }, idempotencyKey: key, nowISO: '2028-01-20T00:00:00.000Z' }, db, manager);
  assert.equal(changed.version, 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM financial_settings_changes').get().n, 1);
  const same = await updateFinancialSettings({ body: { minimumCashIdr: '5000', pendingMaxDays: 7, expectedVersion: 0 } }, db, manager);
  assert.equal(same.version, 1);
  await assert.rejects(() => updateFinancialSettings({ body: { minimumCashIdr: '9000', pendingMaxDays: 7, expectedVersion: 0 }, idempotencyKey: key }, db, manager), error => error.code === 'idempotency_conflict');
});

test('alerts are scoped, use actual created_at age, and do not invent null thresholds', async () => {
  const { db } = await fixture();
  insertSubmission(db, { id: 'a-old', createdBy: 'user-a', type: 'finance_request', date: '2028-01-01', createdAt: '2028-01-10T00:00:00.000Z', amount: 100, description: 'Pembelian perlengkapan' });
  const result = await getFinancialAlerts({ nowISO: '2028-01-20T00:00:00.000Z' }, db, alpha);
  assert.equal(result.cash.isLow, null);
  assert.equal(result.pending.overdueCount, 0);
  assert.deepEqual(result.pending.items, []);
  await updateFinancialSettings({ body: { minimumCashIdr: null, pendingMaxDays: 7, expectedVersion: 0 }, idempotencyKey: '223e4567-e89b-12d3-a456-426614174000', nowISO: '2028-01-20T00:00:00.000Z' }, db, manager);
  const owned = await getFinancialAlerts({ nowISO: '2028-01-20T00:00:00.000Z' }, db, alpha);
  assert.equal(owned.pending.items[0].waitingDays, 10);
  assert.equal(owned.cash.balanceIdr, null);
});

test('duplicate check is read-only and finds normalized Indonesian descriptions', async () => {
  const { db } = await fixture();
  insertSubmission(db, { id: 'dup', createdBy: 'user-a', type: 'finance_request', amount: 1000, date: '2028-02-28', description: 'Pembelian bola latihan' });
  const result = await findPotentialDuplicates({ body: { type: 'finance_request', amountIdr: 1000, date: '2028-03-01', description: 'Bola untuk latihan' } }, db, alpha);
  assert.equal(result.matches[0].id, 'dup');
  assert.equal(result.matches[0].dateDistanceDays, 2);
  insertSubmission(db, { id: 'allowed', createdBy: 'user-a', type: 'finance_request', amount: 1000, date: '2028-03-01', description: 'Bola untuk latihan' });
  assert.ok(db.db.prepare("SELECT id FROM submissions WHERE id='allowed'").get());
});

test('other users cannot see another owner’s duplicate candidates', async () => {
  const { db } = await fixture();
  insertSubmission(db, { id: 'private', createdBy: 'user-b', type: 'finance_request', amount: 1000, date: '2028-02-28', description: 'Pembelian bola latihan' });
  const result = await findPotentialDuplicates({ body: { type: 'finance_request', amountIdr: 1000, date: '2028-03-01', description: 'Bola untuk latihan' } }, db, alpha);
  assert.equal(result.matches.length, 0);
});
