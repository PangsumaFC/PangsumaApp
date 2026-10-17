import assert from 'node:assert/strict';
import test from 'node:test';
import { getCashInsights, cashTrendWindow, toBigIntAmount } from '../functions/_lib/cash-insights.js';

function fakeDb(rows, balance = '0') {
  return { prepare(sql) {
    const statement = { bind() { return statement; }, async all() { return { results: sql.includes('GROUP BY') ? [] : rows }; }, async first() { return sql.includes('cash_accounts') ? { balance_idr: balance } : null; } };
    return statement;
  } };
}

test('cash trend uses today plus 29 prior WIB days and the preceding full 30 days', () => {
  assert.deepEqual(cashTrendWindow('2028-03-01'), {
    start: '2028-02-01', end: '2028-03-01', previousStart: '2028-01-02', previousEnd: '2028-01-31', timezone: 'Asia/Jakarta'
  });
});

test('cash insights ignores zero opening sentinel and keeps integer totals as strings', async () => {
  const rows = [
    { id: 3, event_type: 'petty_cash_approval', direction: 'debit', amount_idr: '9007199254740000', created_at: '2028-03-01T00:00:00.000Z' },
    { id: 2, event_type: 'cash_topup', direction: 'credit', amount_idr: '1000', created_at: '2028-02-28T17:00:00.000Z' },
    { id: 1, event_type: 'opening_balance', direction: 'credit', amount_idr: '0', created_at: '2026-01-01T00:00:00.000Z' }
  ];
  const result = await getCashInsights(fakeDb(rows, '1000'), {}, { today: '2028-03-01' });
  assert.equal(result.totals.openingIdr, '0');
  assert.equal(result.totals.topupsIdr, '1000');
  assert.equal(result.totals.outgoingIdr, '9007199254740000');
  assert.equal(result.accounting.discrepancyIdr, '9007199254740000');
  assert.equal(result.minimumIdr, null);
  assert.equal(result.trend.outgoingIdr, '9007199254740000');
  assert.ok(result.daily.every(row => row.day !== '2026-01-01'));
});

test('integer parser rejects approximated decimal amounts', () => {
  assert.equal(toBigIntAmount('9007199254740991'), 9007199254740991n);
  assert.throws(() => toBigIntAmount(1.5), /invalid_integer_amount/);
});
