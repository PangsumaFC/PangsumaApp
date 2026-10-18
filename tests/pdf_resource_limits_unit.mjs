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

test('PDF combined row budget rejects mixed sections before collecting export pages', async () => {
  const { db, managerToken } = await seededFinancialDb();
  for (let i = 0; i < 600; i++) insertSubmission(db, { id: `mixed-${i}`, createdBy: 'user-a', date: '2025-01-01', description: 'Row', note: '' });
  for (let i = 0; i < 400; i++) db.db.prepare("INSERT INTO audit_events(actor_id,action,entity_type,entity_id,details_json,created_at) VALUES ('user-a','submission.created','submission',?,'{}','2025-01-01T00:00:00.000Z')").run(`mixed-${i}`);
  const counts = ['submissions','cash_ledger','audit_events'].map(table => db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  assert.ok(counts.every(n => n <= 600)); assert.equal(counts.reduce((a,b) => a+b,0), 1001);
  const original = db.prepare.bind(db); let collected = false;
  db.prepare = sql => { if (/ORDER BY (?:s.created_at DESC, s.id|l.id|a.id) DESC LIMIT 500/.test(sql)) collected = true; return original(sql); };
  const response = await onRequest({ request: request('/export.pdf', managerToken), env: { DB: db } });
  assert.equal(response.status, 413); assert.equal(collected, false);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const body = await response.json(); assert.equal(body.error.code, 'report_too_large');
  assert.match(body.error.message, /1\.000 baris gabungan/);
});

test('generator honors stricter caller page budget without emitting a partial PDF', async () => {
  const submissions = [{ id: 'render-budget', type: 'finance_request', date: '2025-01-01', status: 'pending', amount_idr: 1, description: 'Complete data', note: 'Rendered text '.repeat(1000), created_by_name: 'User' }];
  await assert.rejects(buildFinancialReport({ submissions, maxPages: 2 }), error => error.status === 413 && error.code === 'report_too_large' && /2 halaman/.test(error.message));
});
