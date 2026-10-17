import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, decodePDFRawStream } from 'pdf-lib';
import { onRequest } from '../functions/api/[[path]].js';
import { insertAudit, insertSubmission, request, seededFinancialDb } from './local_financial_db.mjs';

async function call(db, path, token, options = {}) { const response = await onRequest({ request: request(path, token, options), env: { DB: db } }); return { response, body: await response.json().catch(() => null) }; }
async function pdfText(bytes) {
  const document = await PDFDocument.load(bytes); const lines = [];
  for (const page of document.getPages()) {
    const contents = page.node.Contents();
    for (let i = 0; contents && i < contents.size(); i++) {
      const raw = Buffer.from(decodePDFRawStream(document.context.lookup(contents.get(i))).decode()).toString();
      for (const [, hex] of raw.matchAll(/<([A-F0-9]+)> Tj/gi)) lines.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
  }
  return lines.join('\n');
}

test('GET /api/reports is manager-only, validates hostile filters, and counts beyond page 100', async () => {
  const { db, managerToken, userAToken } = await seededFinancialDb();
  for (let i = 0; i < 101; i++) {
    const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`;
    insertSubmission(db, { id, createdBy: 'user-a', type: 'finance_request', date: '2028-02-29', description: `Alpha row ${i}`, amount: 100 + i, createdAt: `2024-02-29T04:${String(i % 60).padStart(2, '0')}:00.000Z` });
  }
  insertSubmission(db, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdBy: 'user-b', type: 'petty_cash', date: '2028-02-29', description: 'Beta row', amount: 999 });
  const listed = await call(db, '/reports?start=2028-02-29&end=2028-02-29&applicant=Alpha&limit=100', managerToken);
  assert.equal(listed.response.status, 200); assert.equal(listed.body.total, 101); assert.equal(listed.body.items.length, 100); assert.equal(listed.body.hasMore, true);
  assert.ok(listed.body.items.every(row => row.createdBy === 'user-a'));
  const page2 = await call(db, '/reports?start=2028-02-29&end=2028-02-29&applicant=Alpha&limit=100&page=2', managerToken);
  assert.equal(page2.body.items.length, 1); assert.notEqual(listed.body.items.at(-1).id, page2.body.items[0].id);
  assert.equal((await call(db, '/reports', userAToken)).response.status, 403);
  assert.equal((await call(db, '/reports', null)).response.status, 401);
  assert.equal((await call(db, '/reports', managerToken, { method: 'POST' })).response.status, 405);
  for (const query of ['?type=%27%20OR%201%3D1', `?q=${'x'.repeat(121)}`, '?start=2028-02-30&end=2028-03-01', '?limit=101']) assert.equal((await call(db, `/reports${query}`, managerToken)).response.status, 400);
});

test('date-only PDF includes preceding opening and selected closing, while applicant filter excludes other ledger/audit rows', async () => {
  const { db, managerToken } = await seededFinancialDb();
  insertSubmission(db, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', createdBy: 'user-a', type: 'petty_cash', date: '2025-02-28', description: 'Alpha selected', amount: 400 });
  insertSubmission(db, { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', createdBy: 'user-b', type: 'finance_request', date: '2025-02-28', description: 'Beta excluded', amount: 700 });
  db.db.prepare(`INSERT INTO cash_ledger (event_type,direction,amount_idr,balance_after_idr,note,created_at,actor_id) VALUES ('opening_balance','credit',5000,5000,'Saldo pembukaan aktual','2025-02-27T16:00:00.000Z','manager-1')`).run();
  db.db.prepare(`INSERT INTO cash_ledger (event_type,direction,amount_idr,balance_after_idr,submission_id,actor_id,note,created_at) VALUES ('petty_cash_approval','debit',400,4600,?,'manager-1','Alpha ledger','2025-02-28T04:00:00.000Z')`).run('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  db.db.prepare(`INSERT INTO cash_ledger (event_type,direction,amount_idr,balance_after_idr,actor_id,note,created_at) VALUES ('cash_topup','credit',700,5300,'manager-1','Beta ledger','2025-02-28T05:00:00.000Z')`).run();
  insertAudit(db, { entityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', actorId: 'user-a', details: {}, createdAt: '2025-02-28T04:00:00.000Z' });
  insertAudit(db, { entityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', actorId: 'user-b', details: {}, createdAt: '2025-02-28T05:00:00.000Z' });
  const response = await onRequest({ request: request('/export.pdf?start=2025-02-28&end=2025-02-28&applicant=User%20Alpha', managerToken), env: { DB: db } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/pdf');
  const text = await pdfText(new Uint8Array(await response.arrayBuffer()));
  assert.match(text, /Periode 2025-02-28/); assert.match(text, /Saldo awal Rp5\.000/); assert.match(text, /Saldo akhir Rp5\.300/);
  assert.match(text, /Alpha selected/); assert.doesNotMatch(text, /Beta excluded/); assert.match(text, /Baris ledger 1 \| Audit 1/);
});

test('filtered PDF export paginates all 101 matching submissions instead of truncating at dashboard page size', async () => {
  const { db, managerToken } = await seededFinancialDb();
  for (let i = 0; i < 101; i++) insertSubmission(db, { id: `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, '0')}`, createdBy: 'user-a', date: '2025-03-01', description: `Bulk exact ${i}`, amount: i + 1, createdAt: `2025-03-01T04:${String(i % 60).padStart(2, '0')}:00.000Z` });
  const response = await onRequest({ request: request('/export.pdf?start=2025-03-01&end=2025-03-01&applicant=Alpha', managerToken), env: { DB: db } });
  assert.equal(response.status, 200);
  const text = await pdfText(new Uint8Array(await response.arrayBuffer()));
  assert.match(text, /Bulk exact 0/); assert.match(text, /Bulk exact 100/);
  assert.match(text, /Petty Cash: 0 pengajuan/); assert.match(text, /Request Finance: 101 pengajuan/);
});
