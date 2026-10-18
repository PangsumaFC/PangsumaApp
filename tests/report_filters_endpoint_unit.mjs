import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, decodePDFRawStream } from 'pdf-lib';
import { onRequest } from '../functions/api/[[path]].js';
import { insertSubmission, request, seededFinancialDb } from './local_financial_db.mjs';

async function call(db, path, token, options = {}) { const response = await onRequest({ request: request(path, token, options), env: { DB: db } }); return { response, body: await response.json().catch(() => null) }; }
async function pdfText(bytes) {
  const pdf = await PDFDocument.load(bytes); const chunks = [];
  for (const page of pdf.getPages()) {
    const contents = page.node.Contents();
    for (let i = 0; contents && i < contents.size(); i++) {
      const raw = Buffer.from(decodePDFRawStream(pdf.context.lookup(contents.get(i))).decode()).toString();
      for (const [, hex] of raw.matchAll(/<([A-F0-9]+)> Tj/gi)) chunks.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
  }
  return chunks.join('\n');
}

test('reports endpoint paginates >100 and filters by applicant metadata while rejecting hostile filters', async () => {
  const { db, managerToken, userAToken } = await seededFinancialDb();
  for (let i = 0; i < 101; i++) insertSubmission(db, { id: `40000000-0000-4000-8000-${String(i).padStart(12, '0')}`, createdBy: 'user-a', type: 'finance_request', status: 'approved', date: '2025-02-28', description: `Alpha row ${i}`, amount: 100 + i, createdAt: `2025-02-28T04:${String(i % 60).padStart(2, '0')}:00.000Z` });
  insertSubmission(db, { id: '40000000-0000-4000-8000-000000000999', createdBy: 'user-b', type: 'finance_request', status: 'approved', date: '2025-02-28', description: 'Beta row', amount: 999 });
  const first = await call(db, '/reports?start=2025-02-28&end=2025-02-28&applicant=Alpha&limit=100', managerToken);
  assert.equal(first.response.status, 200); assert.equal(first.body.total, 101); assert.equal(first.body.items.length, 100); assert.equal(first.body.hasMore, true);
  assert.ok(first.body.items.every(row => row.createdBy === 'user-a'));
  const second = await call(db, '/reports?start=2025-02-28&end=2025-02-28&applicant=Alpha&limit=100&page=2', managerToken);
  assert.equal(second.body.items.length, 1); assert.notEqual(first.body.items.at(-1).id, second.body.items[0].id);
  assert.equal((await call(db, '/reports', userAToken)).response.status, 403); assert.equal((await call(db, '/reports', null)).response.status, 401); assert.equal((await call(db, '/reports', managerToken, { method: 'POST' })).response.status, 405);
  for (const query of ['?type=%27%20OR%201%3D1', `?q=${'x'.repeat(121)}`, '?start=2025-02-30&end=2025-03-01', '?limit=101']) assert.equal((await call(db, `/reports${query}`, managerToken)).response.status, 400);
});

test('filtered PDF uses final single financial table and filter metadata without legacy categories or audit sections', async () => {
  const { db, managerToken } = await seededFinancialDb();
  insertSubmission(db, { id: '50000000-0000-4000-8000-000000000001', createdBy: 'user-a', type: 'finance_request', status: 'approved', date: '2025-03-01', description: 'Finance selected', note: 'Finance note', amount: 400 });
  insertSubmission(db, { id: '50000000-0000-4000-8000-000000000002', createdBy: 'user-a', type: 'petty_cash', status: 'approved', date: '2025-03-01', description: 'Petty excluded by type', amount: 700 });
  const response = await onRequest({ request: request('/export.pdf?start=2025-03-01&end=2025-03-01&type=finance_request&status=approved&applicant=Alpha', managerToken), env: { DB: db } });
  assert.equal(response.status, 200); const text = await pdfText(new Uint8Array(await response.arrayBuffer()));
  assert.match(text, /Laporan Petty Cash/); assert.match(text, /Finance selected/); assert.doesNotMatch(text, /Petty excluded by type/);
  assert.equal((text.match(/Finance selected/g) || []).length, 1); assert.match(text, /Finance Disetujui Rp400/); assert.match(text, /Total kas keseluruhan/); assert.match(text, /Lampiran/); assert.doesNotMatch(text, /Baris laporan|Total pengajuan|Subtotal halaman/);
  assert.doesNotMatch(text, /Petty Cash:|Request Finance:|Audit/);
  assert.match(text, /Keterangan/); assert.doesNotMatch(text, /Tanggal.*Keterangan.*Masuk.*Keluar.*Saldo/);
});
