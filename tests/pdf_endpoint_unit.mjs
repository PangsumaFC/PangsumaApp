import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, decodePDFRawStream } from 'pdf-lib';
import { onRequest } from '../functions/api/[[path]].js';
import { insertAudit, insertSubmission, request, seededFinancialDb } from './local_financial_db.mjs';

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
function ledger(db, { submissionId = null, amount = 10, note = 'Kas', at = '2025-02-01T04:00:00.000Z' } = {}) {
  db.db.prepare(`INSERT INTO cash_ledger (event_type,direction,amount_idr,balance_after_idr,submission_id,actor_id,note,created_at)
    VALUES ('petty_cash_approval','debit',?,?,?,'manager-1',?,?)`).run(amount, 1000000 - amount, submissionId, note, at);
}

 test('manager PDF collects >500 eligible submissions and ledger rows, merges linked rows, and ignores audit', async () => {
  const { db, managerToken } = await seededFinancialDb();
  for (let i = 0; i < 501; i++) {
    const id = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    insertSubmission(db, { id, createdBy: i % 3 === 0 ? 'manager-1' : 'user-a', type: 'finance_request', status: i % 3 === 0 ? 'pending' : 'approved', date: '2025-02-01', description: `Eligible ${i}`, note: `Note ${i}`, amount: 10 + i, createdAt: `2025-02-01T04:${String(Math.floor(i / 10)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` });
    ledger(db, { submissionId: id, amount: 10 + i, note: `Ledger ${i}`, at: `2025-02-01T05:${String(Math.floor(i / 10)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` });
  }
  insertSubmission(db, { id: '20000000-0000-4000-8000-000000000001', createdBy: 'user-b', type: 'finance_request', status: 'pending', date: '2025-02-01', description: 'Ineligible pending', amount: 999 });
  insertAudit(db, { entityId: 'audit-only', details: { marker: 'AUDIT MUST NOT APPEAR' } });
  const response = await onRequest({ request: request('/export.pdf', managerToken), env: { DB: db } });
  assert.equal(response.status, 200);
  const text = await pdfText(new Uint8Array(await response.arrayBuffer()));
  assert.match(text, /LAPORAN KEUANGAN/);
  assert.match(text, /Eligible 0/); assert.match(text, /Eligible 500/);
  assert.doesNotMatch(text, /Ineligible pending/); assert.doesNotMatch(text, /AUDIT MUST NOT APPEAR/);
  assert.equal((text.match(/Eligible \d+/g) || []).length, 501); assert.match(text, /Total kas keseluruhan/); assert.match(text, /Lampiran/); assert.doesNotMatch(text, /Baris laporan|Total pengajuan|Subtotal halaman/);
  assert.doesNotMatch(text, /Audit/); assert.doesNotMatch(text, /Kategori/);
});

test('period uses ledger timestamps and includes linked current cash for an old submission; specific filters use metadata', async () => {
  const { db, managerToken } = await seededFinancialDb();
  insertSubmission(db, { id: '30000000-0000-4000-8000-000000000001', createdBy: 'user-a', type: 'petty_cash', status: 'approved', date: '2027-01-01', description: 'Old date current cash', amount: 400 });
  insertSubmission(db, { id: '30000000-0000-4000-8000-000000000002', createdBy: 'user-a', type: 'petty_cash', status: 'rejected', date: '2025-02-01', description: 'Rejected metadata', amount: 700 });
  ledger(db, { submissionId: '30000000-0000-4000-8000-000000000001', amount: 400, note: 'Current period cash', at: '2025-02-01T04:00:00.000Z' });
  ledger(db, { submissionId: '30000000-0000-4000-8000-000000000002', amount: 700, note: 'Rejected cash', at: '2025-02-01T05:00:00.000Z' });
  const response = await onRequest({ request: request('/export.pdf?start=2025-02-01&end=2025-02-01&type=petty_cash&status=approved&applicant=Alpha', managerToken), env: { DB: db } });
  assert.equal(response.status, 200);
  const text = await pdfText(new Uint8Array(await response.arrayBuffer()));
  assert.match(text, /Old date current cash/); assert.doesNotMatch(text, /Rejected metadata|Rejected cash/);
  assert.match(text, /Periode 2025-02-01/); assert.equal((text.match(/Old date current cash/g) || []).length, 1); assert.match(text, /Lampiran/);
});

test('export remains manager-only, authenticated, and GET-only', async () => {
  const { db, managerToken, userAToken } = await seededFinancialDb();
  assert.equal((await onRequest({ request: request('/export.pdf', userAToken), env: { DB: db } })).status, 403);
  assert.equal((await onRequest({ request: request('/export.pdf', null), env: { DB: db } })).status, 401);
  assert.equal((await onRequest({ request: request('/export.pdf', managerToken, { method: 'POST' }), env: { DB: db } })).status, 405);
});
