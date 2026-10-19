import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';
import { unifiedReportRows } from '../functions/_lib/pdf-cashflow.js';

const execFileAsync = promisify(execFile);
const RECEIPT = 'https://www.dropbox.com/scl/fi/purpose-only/receipt.pdf';
const SNAPSHOT = '2026-10-18T12:00:00.000Z';

function submission(id, overrides = {}) {
  return {
    id,
    type: 'finance_request',
    status: 'approved',
    amount_idr: 370_000,
    date: '2026-10-10',
    created_at: '2026-10-10T03:00:00Z',
    description: 'Perlengkapan latihan 2 unit @ Rp185.000',
    note: 'Catatan rahasia: jangan tampil',
    created_by_name: 'Pemohon Sintetis',
    ...overrides,
  };
}

async function renderedText(data, filename) {
  const dir = await mkdtemp(join(tmpdir(), 'pangsuma-purpose-only-'));
  const path = join(dir, filename);
  try {
    const bytes = await buildFinancialReport({ snapshotAt: SNAPSHOT, ...data });
    await writeFile(path, bytes);
    const { stdout } = await execFileAsync('pdftotext', ['-layout', path, '-'], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.replace(/Rp[ \t]+(-?)[ \t]*(\d[\d.]*)/g, (_, sign, digits) => `Rp${sign}${digits}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('unifiedReportRows uses submission.description only for linked and unlinked petty cash/finance', () => {
  const source = {
    submissions: [
      submission('linked-petty', { type: 'petty_cash', amount_idr: 125_000, description: 'Keperluan petty linked', note: 'Catatan petty linked', dropbox_receipt_urls: [RECEIPT] }),
      submission('unlinked-petty', { type: 'petty_cash', amount_idr: 90_000, description: 'Keperluan petty unlinked', note: 'Catatan petty unlinked' }),
      submission('unlinked-finance', { amount_idr: 370_000, description: 'Keperluan finance murni', note: 'Catatan finance murni', status: 'sent' }),
      submission('missing-purpose', { type: 'petty_cash', amount_idr: 50_000, description: '', note: 'Catatan fallback terlarang' }),
      submission('empty-purpose', { amount_idr: 60_000, description: '   ', note: 'Catatan kosong terlarang' }),
      submission('pending', { status: 'pending', description: 'Tidak eligible', note: 'Tidak tampil' }),
    ],
    ledger: [
      {
        id: 1,
        submission_id: 'linked-petty',
        event_type: 'expense',
        direction: 'out',
        amount_idr: 125_000,
        balance_after_idr: 875_000,
        created_at: '2026-10-10T04:00:00Z',
        description: 'Ledger description must lose',
        note: 'Ledger Catatan must lose',
      },
    ],
  };
  const before = structuredClone(source);
  const result = unifiedReportRows(source);
  const byKey = new Map(result.rows.map(row => [row.report_key, row]));

  assert.equal(byKey.get('ledger-1').report_description, 'Keperluan petty linked');
  assert.equal(byKey.get('submission-unlinked-petty').report_description, 'Keperluan petty unlinked');
  assert.equal(byKey.get('submission-unlinked-finance').report_description, 'Keperluan finance murni');
  assert.equal(byKey.get('submission-missing-purpose').report_description, '');
  assert.equal(byKey.get('submission-empty-purpose').report_description.trim(), '');
  assert.equal(result.submissionCount, 5);
  assert.equal(result.totalSubmitted, 695_000n);
  assert.deepEqual(source, before, 'projection must not mutate submissions or ledger');
  assert.equal(byKey.get('ledger-1').dropbox_receipt_urls.length, 1, 'linked Lampiran is preserved');
});

test('rendered petty cash PDF has purpose-only Keterangan, no generated status/amount, and correct numeric columns', async () => {
  const text = await renderedText({
    reportType: 'petty_cash',
    submissions: [submission('pc', { type: 'petty_cash', amount_idr: 125_000, description: 'Beli tinta 2 unit @ Rp185.000', note: 'Catatan PC jangan cetak' })],
    ledger: [{ id: 1, submission_id: 'pc', event_type: 'expense', direction: 'out', amount_idr: 125_000, balance_after_idr: 875_000, created_at: '2026-10-10T04:00:00Z', description: 'Ledger must not win', note: 'Ledger Catatan must not win', dropbox_receipt_urls: [RECEIPT] }],
    openingBalanceIdr: 1_000_000,
    closingBalanceIdr: 875_000,
  }, 'petty.pdf');
  assert.match(text, /Beli tinta 2 unit @ Rp185\.000/);
  assert.doesNotMatch(text, /Catatan PC jangan cetak|Ledger must not win|Ledger Catatan/);
  assert.doesNotMatch(text, /Pengajuan Disetujui Rp125\.000/);
  assert.match(text, /Rp125\.000/);
  assert.match(text, /Rp875\.000/);
  assert.match(text, /Total kas keseluruhan\s+Rp0\s+Rp125\.000/);
  assert.match(text, /Lampiran/);
});

test('rendered finance PDF keeps genuine numeric prose, cleans note/status, preserves applicant cleanup, attachment, and total', async () => {
  const text = await renderedText({
    reportType: 'finance_request',
    submissions: [
      submission('f1', { amount_idr: 370_000, description: '2 unit @ Rp185.000 | Finance Disetujui Rp370.000', note: 'Catatan Finance jangan cetak', dropbox_receipt_urls: [RECEIPT] }),
      submission('f2', { amount_idr: 125_000, description: 'Sewa kendaraan 3 hari', note: 'Catatan kedua jangan cetak', status: 'sent' }),
    ],
    ledger: [],
  }, 'finance.pdf');
  assert.match(text, /2 unit @ Rp185\.000 \| Finance Disetujui Rp370\.000/);
  assert.match(text, /Sewa kendaraan 3 hari/);
  assert.doesNotMatch(text, /Catatan Finance jangan cetak|Catatan kedua jangan cetak/);
  assert.doesNotMatch(text, /Pengajuan Disetujui|Pengajuan Terkirim|Pemohon Sintetis/);
  assert.match(text, /Total request disetujui\s+Rp495\.000/);
  assert.match(text, /Rp370\.000/);
  assert.match(text, /Rp125\.000/);
  assert.match(text, /Lampiran/);
});
