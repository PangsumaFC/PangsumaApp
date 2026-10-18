import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { encode as encodePng } from 'fast-png';
import { onRequest } from '../functions/api/[[path]].js';
import { createSubmissionReceipt } from '../functions/_lib/submission-receipts.js';
import { insertSubmission, request, seededFinancialDb } from './local_financial_db.mjs';

function fixturePng(seed) {
  const data = new Uint8Array(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) {
    data[i * 4] = (i + seed * 29) & 255;
    data[i * 4 + 1] = (i * 3 + seed * 41) & 255;
    data[i * 4 + 2] = (i * 7 + seed * 13) & 255;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(encodePng({ width: 32, height: 32, data })).toString('base64');
}
const PNG_2X3 = fixturePng(1);
const PNG_1X1 = fixturePng(2);
const READY_A = 'https://www.dropbox.com/scl/fi/FILE-A/receipt-a.png?rlkey=a&dl=0';
const READY_B = 'https://www.dropbox.com/scl/fi/FILE-B/receipt-b.png?rlkey=b&dl=0';
const FUTURE = 'https://www.dropbox.com/scl/fi/FUTURE/receipt-future.png?rlkey=f&dl=0';

function migrationFiles() {
  return ['0006_financial_controls.sql', '0007_submission_receipts.sql', '0008_financial_alert_settings.sql', '0009_receipt_dropbox_metadata.sql'];
}
function applyMigrations(db, files = migrationFiles()) {
  for (const file of files) db.db.exec(fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
}
function receiptRequest(key, filename, dataBase64) {
  return new Request('https://local.test/api/submissions/x/receipts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ filename, mimeType: 'image/png', dataBase64 })
  });
}
async function addLegacyReceipt(db, submissionId, n, dataBase64 = PNG_2X3) {
  const response = await createSubmissionReceipt(
    { request: receiptRequest(`123e4567-e89b-12d3-a456-4266141740${String(n).padStart(2, '0')}`, `receipt-${n}.png`, dataBase64) },
    db,
    { id: 'user-a', role: 'user' },
    submissionId
  );
  assert.equal(response.status, 201);
  return response.json();
}
function addLedger(db, submissionId, amount, idAt) {
  db.db.prepare(`INSERT INTO cash_ledger (event_type,direction,amount_idr,balance_after_idr,submission_id,actor_id,note,created_at)
    VALUES ('petty_cash_approval','debit',?,?,?,'manager-1',?,?)`)
    .run(amount, 1_000_000 - amount, submissionId, 'linked cash movement', `2025-02-01T05:00:0${idAt}.000Z`);
}
function annotationUrls(pdf) {
  return pdf.getPages().flatMap(page => {
    const annots = page.node.Annots();
    return annots ? annots.asArray().map(ref => {
      const dict = pdf.context.lookup(ref, PDFDict);
      const action = dict.lookup(PDFName.of('A'), PDFDict);
      return action?.lookup(PDFName.of('URI'))?.decodeText?.() || '';
    }) : [];
  });
}
function pageImageCount(pdf, page) {
  const xObject = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
  if (!xObject) return 0;
  return xObject.entries().filter(([, ref]) => {
    const object = pdf.context.lookup(ref);
    return object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image';
  }).length;
}
async function pdfText(bytes) {
  const pdf = await PDFDocument.load(bytes);
  const chunks = [];
  for (const page of pdf.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFRawStream
      ? [contents]
      : contents?.asArray?.().map(ref => pdf.context.lookup(ref)).filter(Boolean) || [];
    for (const stream of streams) {
      try {
        const raw = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
        for (const [, hex] of raw.matchAll(/<([A-F0-9]+)> Tj/gi)) chunks.push(Buffer.from(hex, 'hex').toString('latin1'));
      } catch { /* malformed streams are not text */ }
    }
  }
  return chunks.join('\n');
}

async function makeDb() {
  const seeded = await seededFinancialDb();
  applyMigrations(seeded.db);
  insertSubmission(seeded.db, { id: '41000000-0000-4000-8000-000000000001', createdBy: 'user-a', type: 'petty_cash', status: 'approved', date: '2025-02-01', description: 'LINKED RECEIPT ROW', amount: 1100, createdAt: '2025-02-01T04:00:00.000Z' });
  insertSubmission(seeded.db, { id: '41000000-0000-4000-8000-000000000002', createdBy: 'user-a', type: 'petty_cash', status: 'approved', date: '2025-02-01', description: 'STANDALONE READY ROW', amount: 2200, createdAt: '2025-02-01T04:01:00.000Z' });
  insertSubmission(seeded.db, { id: '41000000-0000-4000-8000-000000000003', createdBy: 'user-a', type: 'petty_cash', status: 'approved', date: '2025-02-01', description: 'LEGACY BLANK ROW', amount: 3300, createdAt: '2025-02-01T04:02:00.000Z' });
  addLedger(seeded.db, '41000000-0000-4000-8000-000000000001', 1100, 1);
  const first = await addLegacyReceipt(seeded.db, '41000000-0000-4000-8000-000000000001', 1, PNG_2X3);
  const second = await addLegacyReceipt(seeded.db, '41000000-0000-4000-8000-000000000001', 2, PNG_1X1);
  const pending = await addLegacyReceipt(seeded.db, '41000000-0000-4000-8000-000000000002', 3, PNG_2X3);
  const legacy = await addLegacyReceipt(seeded.db, '41000000-0000-4000-8000-000000000003', 4, PNG_2X3);
  for (const row of [first, second, pending]) {
    const receipt = seeded.db.db.prepare('SELECT created_at,mime_type FROM submission_receipts WHERE id=?').get(row.id);
    const ext = receipt.mime_type === 'image/png' ? '.png' : '.jpg';
    seeded.db.db.prepare('INSERT INTO receipt_dropbox_metadata (receipt_id,dropbox_path,state,created_at) VALUES (?,?,?,?)')
      .run(row.id, `/Pengajuan Pangsuma/${row.id}${ext}`, 'pending', receipt.created_at);
  }
  const readyAt = '2025-02-01T06:00:00.000Z';
  seeded.db.db.prepare('UPDATE receipt_dropbox_metadata SET file_id=?,public_url=?,state=\'ready\',completed_at=? WHERE receipt_id=?')
    .run('id:file-a', READY_A, readyAt, first.id);
  seeded.db.db.prepare('UPDATE receipt_dropbox_metadata SET file_id=?,public_url=?,state=\'ready\',completed_at=? WHERE receipt_id=?')
    .run('id:file-b', READY_B, readyAt, second.id);
  seeded.db.db.prepare('UPDATE receipt_dropbox_metadata SET file_id=?,public_url=?,state=\'ready\',completed_at=? WHERE receipt_id=?')
    .run('id:future', FUTURE, '2099-01-01T00:00:00.000Z', pending.id);
  return { ...seeded, ids: { first, second, pending, legacy } };
}

test('manager PDF enriches local receipt metadata at the snapshot and keeps one combined linked row', async () => {
  const { db, managerToken } = await makeDb();
  const response = await onRequest({ request: request('/export.pdf', managerToken), env: { DB: db, DROPBOX_RECEIPTS_ENABLED: 'true' } });
  assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const pdf = await PDFDocument.load(bytes);
  const urls = annotationUrls(pdf);
  assert.deepEqual(urls, [READY_A, READY_B], 'only the two ready URLs completed by the snapshot are linked');
  assert.ok(pdf.getPages().every(page => pageImageCount(pdf, page) === 0) || pdf.getPages().filter(page => pageImageCount(pdf, page)).length === 1, 'receipt images are never embedded');
  assert.equal(pdf.getPages().reduce((sum, page) => sum + pageImageCount(pdf, page), 0), 2, 'only the original signature/stamp assets are embedded');
  const text = await pdfText(bytes);
  assert.doesNotMatch(text, /(?:^|\n)Subtotal halaman|(?:^|\n)Total pengajuan|bluebox/i);
  assert.doesNotMatch(text, /FUTURE/);
  assert.match(text, /LINKED RECEIPT ROW/);
  assert.equal((text.match(/LINKED RECEIPT ROW/g) || []).length, 1, 'linked ledger and submission are merged once');
  assert.match(text, /STANDALONE READY ROW/);
  assert.match(text, /LEGACY BLANK ROW/);
  assert.match(text, /Total kas keseluruhan/);
});

test('PDF export remains manager-only and missing enabled metadata fails closed only for eligible rows', async () => {
  const { db, managerToken, userAToken } = await makeDb();
  assert.equal((await onRequest({ request: request('/export.pdf', userAToken), env: { DB: db, DROPBOX_RECEIPTS_ENABLED: 'true' } })).status, 403);
  const missing = await seededFinancialDb();
  applyMigrations(missing.db, migrationFiles().slice(0, 3));
  insertSubmission(missing.db, { id: '42000000-0000-4000-8000-000000000001', createdBy: 'user-a', type: 'petty_cash', status: 'approved', date: '2025-02-01', description: 'METADATA TABLE REQUIRED', amount: 5, createdAt: '2025-02-01T04:00:00.000Z' });
  const enabled = await onRequest({ request: request('/export.pdf', missing.managerToken), env: { DB: missing.db, DROPBOX_RECEIPTS_ENABLED: 'true' } });
  assert.equal(enabled.status, 503);
  const disabled = await onRequest({ request: request('/export.pdf', missing.managerToken), env: { DB: missing.db, DROPBOX_RECEIPTS_ENABLED: 'false' } });
  assert.equal(disabled.status, 200);
  assert.equal((await onRequest({ request: request('/export.pdf', managerToken), env: { DB: db, DROPBOX_RECEIPTS_ENABLED: 'false' } })).status, 200);
});
