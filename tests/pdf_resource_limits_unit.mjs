import test from 'node:test';
import assert from 'node:assert/strict';
import { seededFinancialDb, insertSubmission, request } from './local_financial_db.mjs';
import { onRequest } from '../functions/api/[[path]].js';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';

test('PDF text budget rejects before pdf-lib and returns actionable no-store error', async () => {
  const { db, managerToken } = await seededFinancialDb();
  for (let i = 0; i < 200; i++) insertSubmission(db, { id: `long-text-${i}`, createdBy: 'user-a', date: '2025-01-01', description: 'x'.repeat(150), note: 'y'.repeat(300) });
  const response = await onRequest({ request: request('/export.pdf', managerToken), env: { DB: db } });
  assert.equal(response.status, 413); assert.match(response.headers.get('cache-control'), /no-store/);
  const body = await response.json(); assert.equal(body.error.code, 'report_too_large');
  assert.match(body.error.message, /karakter teks/); assert.match(body.error.message, /Persempit filter/);
});

test('PDF page guard rejects instead of returning a partially rendered financial report', async () => {
  const submissions = Array.from({ length: 151 }, (_, id) => ({ id, type: 'finance_request', date: '2025-01-01', status: 'pending', amount_idr: 1, description: 'Complete row', note: 'long rendered note '.repeat(500), created_by_name: 'User' }));
  await assert.rejects(buildFinancialReport({ submissions, snapshotAt: '2025-02-01T00:00:00.000Z' }), error => error.status === 413 && error.code === 'report_too_large' && /150 halaman/.test(error.message));
});
