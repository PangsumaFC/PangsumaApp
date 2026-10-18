import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { onRequest } from '../functions/api/[[path]].js';
import { seededFinancialDb, request } from './local_financial_db.mjs';
test('reconciliation route rejects malformed signed/text amounts without any ledger or account write', async () => {
  const { db, managerToken } = await seededFinancialDb();
  for (const name of ['0006_financial_controls.sql', '0007_submission_receipts.sql', '0008_financial_alert_settings.sql']) db.db.exec(fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const ledgerCount = db.db.prepare('SELECT COUNT(*) AS count FROM cash_ledger').get().count;
  for (const amount of ['12oops', '-12oops', '12.5', '1e3']) {
    const base = request('/cash/reconciliations', managerToken, { method: 'POST' });
    const headers = new Headers(base.headers); headers.set('Content-Type', 'application/json'); headers.set('Idempotency-Key', crypto.randomUUID());
    const response = await onRequest({ request: new Request(base, { headers, body: JSON.stringify({ period: '2025-12', physicalCashIdr: amount, note: 'Fixture validasi', confirmed: true }) }), env: { DB: db } });
    assert.equal(response.status, 400, amount);
  }
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM cash_reconciliations').get().count, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM cash_ledger').get().count, ledgerCount);
  assert.equal(db.db.prepare('SELECT balance_idr FROM cash_accounts').get().balance_idr, 0);
});
