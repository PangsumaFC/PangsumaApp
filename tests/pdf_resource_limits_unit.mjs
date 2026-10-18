import test from 'node:test';
import assert from 'node:assert/strict';
import { seededFinancialDb, insertAudit, insertSubmission, request } from './local_financial_db.mjs';
import { onRequest } from '../functions/api/[[path]].js';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';

function id(prefix, i) { return `${prefix}-0000-4000-8000-${String(i).padStart(12, '0')}`; }
function addLedger(db, i, submissionId = null) {
  db.db.prepare(`INSERT INTO cash_ledger (event_type,direction,amount_idr,balance_after_idr,submission_id,actor_id,note,created_at)
    VALUES ('petty_cash_approval','debit',1,999999,?,'manager-1','row',?)`).run(submissionId, `2025-01-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`);
}
async function exportResponse(db, token) { return onRequest({ request: request('/export.pdf', token), env: { DB: db } }); }

for (const [label, count, kind] of [['submission section', 601, 'submissions'], ['ledger section', 601, 'ledger']]) {
  test(`PDF rejects more than 600 rows in the ${label} before rendering`, async () => {
    const { db, managerToken } = await seededFinancialDb();
    if (kind === 'submissions') for (let i = 0; i < count; i++) insertSubmission(db, { id: id('60000000', i), createdBy: 'user-a', status: 'approved', date: '2025-01-01', description: `Submission ${i}`, amount: 1 });
    else for (let i = 0; i < count; i++) addLedger(db, i);
    const response = await exportResponse(db, managerToken);
    assert.equal(response.status, 413); assert.equal((await response.json()).error.code, 'report_too_large');
  });
}

test('PDF rejects more than 1000 unified rows even when each section is within 600', async () => {
  const { db, managerToken } = await seededFinancialDb();
  for (let i = 0; i < 500; i++) insertSubmission(db, { id: id('61000000', i), createdBy: 'user-a', status: 'approved', date: '2025-01-01', description: `Submission ${i}`, amount: 1 });
  for (let i = 0; i < 501; i++) addLedger(db, i);
  const response = await exportResponse(db, managerToken);
  assert.equal(response.status, 413); const body = await response.json(); assert.equal(body.error.code, 'report_too_large'); assert.match(body.error.message, /1\.000 baris gabungan/);
});

test('PDF rejects rendered report descriptions over 80000 characters', async () => {
  const { db, managerToken } = await seededFinancialDb();
  for (let i = 0; i < 200; i++) insertSubmission(db, { id: id('62000000', i), createdBy: 'user-a', status: 'approved', date: '2025-01-01', description: `Description ${i} ${'x'.repeat(130)}`, note: 'y'.repeat(300), amount: 1 });
  const response = await exportResponse(db, managerToken);
  assert.equal(response.status, 413); const body = await response.json(); assert.equal(body.error.code, 'report_too_large'); assert.match(body.error.message, /80\.000 karakter/);
});

test('renderer enforces a caller page limit below its 150-page ceiling without partial output', async () => {
  const submissions = Array.from({ length: 8 }, (_, i) => ({ id: id('63000000', i), type: 'finance_request', status: 'approved', amount_idr: 1, date: '2025-01-01', description: `Complete row ${i}`, note: 'long rendered note '.repeat(500), created_by_name: 'User' }));
  await assert.rejects(buildFinancialReport({ submissions, snapshotAt: '2025-02-01T00:00:00.000Z', maxPages: 2 }), error => error.status === 413 && error.code === 'report_too_large' && /2 halaman/.test(error.message));
});

test('large audit history does not contribute to PDF limits or block export', async () => {
  const { db, managerToken } = await seededFinancialDb();
  insertAudit(db, { entityId: 'audit-large', details: { payload: 'z'.repeat(90000) } });
  const response = await exportResponse(db, managerToken);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/pdf');
});
