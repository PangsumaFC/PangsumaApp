import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { unifiedReportRows } from '../functions/_lib/pdf-cashflow.js';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';
import { onRequest } from '../functions/api/[[path]].js';
import { insertSubmission, request, seededFinancialDb } from './local_financial_db.mjs';

const forbidden = 'PDF mengikuti periode, pencarian, dan pengaju; kategori mengikuti tombol unduhan dan hanya laporan disetujui. Daftar ditampilkan 5 per halaman.';
const make = (id, created_at, request_number, extras = {}) => ({
  id, created_at, request_number, type: 'finance_request', status: 'approved',
  date: '2026-08-15', amount_idr: 1000, description: `Purpose ${id}`, note: 'PRIVATE NOTE',
  created_by_name: 'PRIVATE APPLICANT', resolved_by: 'manager', ...extras,
});
const project = data => unifiedReportRows({ ...data, reportType: 'finance_request' });
const keys = result => result.rows.map(row => row.report_key);
async function extract(bytes) {
  const dir = await mkdtemp(join(tmpdir(), 'finance-creation-order-'));
  try {
    const file = join(dir, 'synthetic.pdf');
    await writeFile(file, bytes);
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('RF uses immutable creation instants across Oct/Nov/Dec/year, not IDs, transaction, approval, payment or ledger dates', () => {
  const submissions = [
    make('oct', '2026-10-31T16:59:59Z', 'RF102026999999', { date: '2027-07-01', updated_at: '2027-03-01T00:00:00Z' }),
    make('nov', '2026-10-31T17:00:00Z', 'RF112026000001', { date: '2027-06-01', updated_at: '2027-02-01T00:00:00Z' }),
    make('dec', '2026-11-30T17:00:00Z', 'RF122026000001', { date: '2027-05-01', status: 'sent' }),
    make('jan', '2026-12-31T17:00:00Z', 'RF012027000001', { date: '2027-04-01', status: 'sent' }),
    make('chronology-beats-id', '2027-01-02T01:00:00Z', 'RF102025000001'),
  ];
  const ledger = [
    { id: 9, submission_id: 'oct', created_at: '2027-08-01T00:00:00Z', amount_idr: 1000, balance_after_idr: 9000, direction: 'debit' },
    { id: 2, submission_id: 'dec', created_at: '2026-12-01T00:00:00Z', amount_idr: 1000, balance_after_idr: 8000, direction: 'debit' },
  ];
  const data = { submissions: submissions.toReversed(), ledger };
  const before = JSON.stringify(data);
  const result = project(data);
  assert.deepEqual(keys(result), ['ledger-9', 'submission-nov', 'ledger-2', 'submission-jan', 'submission-chronology-beats-id']);
  assert.equal(result.rows[0].report_at, ledger[0].created_at, 'displayed transaction date remains unchanged');
  assert.equal(result.rows[1].report_at, '2027-06-01T00:00:00+07:00');
  assert.equal(result.totalSubmitted, 5000n);
  assert.equal(result.submissionCount, 5);
  assert.equal(JSON.stringify(data), before, 'projection never edits IDs, dates, source amounts or balances');
});

test('RF ties compare canonical YYYY/MM/sequence, then internal ID; missing creation timestamps sort last deterministically', () => {
  const instant = '2027-01-01T00:00:00Z';
  const submissions = [
    make('z-jan', instant, 'RF012027000001'),
    make('a-dec', '2027-01-01T07:00:00+07:00', 'RF122026000002'),
    make('z-dec', instant, 'RF122026000001'),
    make('z-oct', instant, 'RF102026000001'),
    make('a-oct', instant, 'RF102026000001'),
    make('no-number-z', instant, null), make('no-number-a', instant, null),
    make('missing-jan', null, 'RF012027000001'),
    make('missing-dec', '', 'RF122026000001'),
    make('missing-number-z', undefined, null), make('missing-number-a', 'invalid', null),
  ];
  const expected = ['a-oct', 'z-oct', 'z-dec', 'a-dec', 'z-jan', 'no-number-a', 'no-number-z', 'missing-dec', 'missing-jan', 'missing-number-a', 'missing-number-z'].map(id => `submission-${id}`);
  for (let offset = 0; offset < submissions.length; offset++) {
    const shuffled = [...submissions.slice(offset), ...submissions.slice(0, offset)].reverse();
    assert.deepEqual(keys(project({ submissions: shuffled })), expected);
  }
  const linkedMissing = project({ submissions: [submissions[0], submissions[7]], ledger: [{ id: 1, submission_id: 'missing-jan', created_at: '2020-01-01T00:00:00Z' }] });
  assert.deepEqual(keys(linkedMissing), ['submission-z-jan', 'ledger-1'], 'ledger timestamp is never substituted for missing request creation');
});

test('RF creation ordering and continuous No. numbering survive many PDF pages; labels, dates, approvals and total remain intact', async () => {
  const count = 180;
  const submissions = Array.from({ length: count }, (_, i) => {
    const creation = new Date(Date.UTC(2026, 9, 29 + i)).toISOString();
    const month = String(new Date(creation).getUTCMonth() + 1).padStart(2, '0');
    const year = new Date(creation).getUTCFullYear();
    return make(`row-${String(i + 1).padStart(3, '0')}`, creation, `RF${month}${year}${String(count - i).padStart(6, '0')}`, {
      description: `ChronologyRow${String(i + 1).padStart(3, '0')}`,
      date: i % 2 ? '2025-09-02' : '2028-08-03', amount_idr: 1234,
      status: i % 2 ? 'approved' : 'sent', updated_at: new Date(Date.UTC(2028, 1, count - i)).toISOString(),
      dropbox_receipt_url: `https://www.dropbox.com/scl/fi/test${i}/file${i}.pdf?rlkey=synthetic&dl=0`,
    });
  });
  const bytes = await buildFinancialReport({ submissions: submissions.toReversed(), reportType: 'finance_request', snapshotAt: '2028-02-01T00:00:00Z', managerName: 'Synthetic QA', periodLabel: 'Periode QA | Filter QA' });
  const text = await extract(bytes);
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 5, 'fixture crosses many real page breaks');
  const lines = text.split('\n').filter(line => /ChronologyRow\d{3}/.test(line));
  assert.equal(lines.length, count);
  lines.forEach((line, i) => {
    assert.match(line, new RegExp(`^\\s*${i + 1}\\s+`), 'No. follows the global chronological index');
    assert.ok(line.includes(`ChronologyRow${String(i + 1).padStart(3, '0')}`));
    assert.ok(line.includes(i % 2 ? '02/09/2025' : '03/08/2028'), 'transaction date not replaced by created_at');
    assert.ok(line.includes(submissions[i].request_number));
    assert.match(line, /1\.234/);
  });
  const annotations = pdf.getPages().flatMap(page => (page.node.Annots()?.asArray() || []).map(ref => {
    const entry = pdf.context.lookup(ref, PDFDict);
    return { label: entry.lookup(PDFName.of('Contents')).decodeText(), uri: entry.lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI')).decodeText() };
  }));
  assert.equal(annotations.length, count);
  annotations.forEach((entry, i) => {
    assert.equal(entry.label, `Lampiran baris ${i + 1}, berkas 1`);
    assert.equal(entry.uri, submissions[i].dropbox_receipt_url);
  });
  assert.ok(text.includes((1234 * count).toLocaleString('id-ID')));
  assert.match(text, /Laporan Request Finance/);
  assert.match(text, /No\. Pengajuan/); assert.match(text, /Keterangan/);
  assert.match(text, /Periode QA \| Filter QA/);
  assert.match(text, /DATA DEMO/); assert.match(text, /Rahmat Saputro/);
  assert.equal((text.match(/Laporan Request Finance/g) || []).length, 1);
  for (let page = 1; page <= pdf.getPageCount(); page++) assert.ok(text.includes(`Halaman ${page} dari ${pdf.getPageCount()}`));
  assert.doesNotMatch(text, /PRIVATE NOTE|PRIVATE APPLICANT/);
  assert.ok(!text.includes(forbidden));
});

test('RF with truly missing dates still renders deterministically after dated rows', async () => {
  const bytes = await buildFinancialReport({ reportType: 'finance_request', submissions: [
    make('missing', null, 'RF102026000001', { date: null }),
    make('dated', '2026-11-01T01:00:00Z', 'RF112026000001'),
  ] });
  const text = await extract(bytes);
  assert.ok(text.indexOf('Purpose dated') < text.indexOf('Purpose missing'));
});

test('category and approval export rules, manager auto-approval, totals and database state stay unchanged', async () => {
  const { db, managerToken } = await seededFinancialDb();
  insertSubmission(db, { id: 'later', status: 'approved', description: 'IncludedLater', createdAt: '2025-11-01T00:00:00Z', date: '2025-01-01', amount: 1100 });
  insertSubmission(db, { id: 'earlier', status: 'sent', description: 'IncludedEarlier', createdAt: '2025-10-01T00:00:00Z', date: '2026-01-01', amount: 2200, resolvedBy: 'manager-1', sentBy: 'manager-1' });
  insertSubmission(db, { id: 'auto', createdBy: 'manager-1', status: 'approved', description: 'IncludedManagerAuto', createdAt: '2025-12-01T00:00:00Z', date: '2025-01-01', amount: 3300 });
  insertSubmission(db, { id: 'pending', status: 'pending', description: 'ExcludedPending', createdAt: '2025-12-01T00:00:00Z' });
  insertSubmission(db, { id: 'rejected', status: 'rejected', description: 'ExcludedRejected', createdAt: '2025-12-01T00:00:00Z' });
  insertSubmission(db, { id: 'manager-pending', createdBy: 'manager-1', status: 'pending', description: 'ExcludedManagerPending', createdAt: '2025-12-01T00:00:00Z' });
  insertSubmission(db, { id: 'petty', type: 'petty_cash', status: 'approved', description: 'PettyCategoryOnly', createdAt: '2025-12-01T00:00:00Z' });
  const before = JSON.stringify({ rows: db.db.prepare('SELECT * FROM submissions ORDER BY id').all(), ledger: db.db.prepare('SELECT * FROM cash_ledger ORDER BY id').all(), account: db.db.prepare('SELECT * FROM cash_accounts').all() });
  const response = await onRequest({ request: request('/export.pdf?laporan=finance_request&status=pending&jenis=petty_cash', managerToken), env: { DB: db } });
  assert.equal(response.status, 200);
  const text = await extract(new Uint8Array(await response.arrayBuffer()));
  const rows = text.split('\n').filter(line => /Included(?:Earlier|Later|ManagerAuto)/.test(line));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /IncludedEarlier/); assert.match(rows[1], /IncludedLater/); assert.match(rows[2], /IncludedManagerAuto/);
  assert.doesNotMatch(text, /Excluded|PettyCategoryOnly/);
  assert.match(text, /6\.600/);
  assert.ok(!text.includes(forbidden));
  const pettyResponse = await onRequest({ request: request('/export.pdf?laporan=petty_cash', managerToken), env: { DB: db } });
  assert.equal(pettyResponse.status, 200);
  const pettyText = await extract(new Uint8Array(await pettyResponse.arrayBuffer()));
  assert.match(pettyText, /PettyCategoryOnly/); assert.doesNotMatch(pettyText, /IncludedEarlier|IncludedLater|IncludedManagerAuto/);
  assert.ok(!pettyText.includes(forbidden));
  assert.equal(JSON.stringify({ rows: db.db.prepare('SELECT * FROM submissions ORDER BY id').all(), ledger: db.db.prepare('SELECT * FROM cash_ledger ORDER BY id').all(), account: db.db.prepare('SELECT * FROM cash_accounts').all() }), before);
});
