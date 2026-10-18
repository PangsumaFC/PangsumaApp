import test from 'node:test';
import assert from 'node:assert/strict';
import { unifiedReportRows } from '../functions/_lib/pdf-cashflow.js';
const date = '2026-10-10';
const make = (id, extras = {}) => ({ id, date, created_at: `${date}T03:00:00Z`, description: `Request ${id}`, type: 'finance_request', status: 'approved', amount_idr: 1000, created_by_role: 'user', ...extras });
test('one chronological projection includes approved users, sent Finance and every manager state, never pending/rejected users', () => {
  const submissions = [make('pending', { status: 'pending' }), make('rejected', { status: 'rejected' }), make('approved'), make('sent', { status: 'sent', amount_idr: 2000 }), make('manager', { status: 'pending', created_by_role: 'manager', amount_idr: 3000 })];
  const result = unifiedReportRows({ submissions });
  assert.equal(result.rows.length, 3);
  assert.equal(result.totalSubmitted, 6000n);
  assert.equal(result.rows.filter(row => row.is_cash).length, 0);
  assert.ok(result.rows.every(row => row.amount_idr === 0 && row.balance_after_idr === null));
  assert.match(result.rows.find(row => row.report_key === 'submission-sent').report_description, /Finance Terkirim Rp2\.000/);
});
test('linked petty cash appears once, while cash credit and non-cash Finance remain independent', () => {
  const submissions = [make('petty', { type: 'petty_cash', amount_idr: 2500 }), make('finance', { amount_idr: 5000 })];
  const ledger = [{ id: 1, created_at: '2026-10-09T01:00:00Z', direction: 'credit', amount_idr: 10000, balance_after_idr: 10000, event_type: 'cash_topup' }, { id: 2, submission_id: 'petty', created_at: '2026-10-10T01:00:00Z', direction: 'debit', amount_idr: 2500, balance_after_idr: 7500, note: 'Request petty' }];
  const result = unifiedReportRows({ submissions, ledger });
  assert.equal(result.rows.length, 3);
  assert.equal(result.totalSubmitted, 7500n);
  assert.deepEqual(result.rows.map(row => row.report_key), ['ledger-1', 'submission-finance', 'ledger-2']);
  assert.equal(result.rows.filter(row => /Request petty/.test(row.report_description)).length, 1);
  assert.equal(result.rows.filter(row => row.direction === 'debit').reduce((sum, row) => sum + row.amount_idr, 0), 2500);
});
test('report-level example marker replaces repeated words without editing source records or amounts', () => {
  const source = { submissions: [make('demo', { description: 'SIMULASI | Perlengkapan latihan', note: 'SIMULASI: catatan', status: 'sent' })], ledger: [] };
  const before = JSON.stringify(source);
  const result = unifiedReportRows(source);
  assert.equal(result.hasSimulation, true);
  assert.doesNotMatch(result.rows[0].report_description, /simulasi/i);
  assert.match(result.rows[0].report_description, /Perlengkapan latihan/);
  assert.equal(JSON.stringify(source), before);
  assert.equal(result.totalSubmitted, 1000n);
});
