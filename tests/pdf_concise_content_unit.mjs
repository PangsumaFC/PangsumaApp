import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';

const execFileAsync = promisify(execFile);

async function extractPdf(bytes) {
  const dir = await mkdtemp(join(tmpdir(), 'pangsuma-pdf-'));
  const input = join(dir, 'report.pdf');
  try {
    await writeFile(input, bytes);
    const { stdout } = await execFileAsync('pdftotext', ['-layout', input, '-'], { maxBuffer: 4 * 1024 * 1024 });
    const { stdout: bounds } = await execFileAsync('pdftotext', ['-bbox', input, '-'], { maxBuffer: 8 * 1024 * 1024 });
    const words = [...bounds.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/g)];
    assert.ok(words.length > 0, 'PDF must contain extractable text');
    for (const word of words) {
      const [left, top, right, bottom] = word.slice(1).map(Number);
      assert.ok(left >= 29 && right <= 566 && top >= 8 && bottom <= 837, `Text outside page margins: ${word[0]}`);
    }
    // Normalize accounting-style spacing only for legacy semantic assertions;
  // pdf_approval_layout_unit.mjs separately verifies actual currency coordinates.
  return stdout.replace(/Rp[ \t]+(-?)[ \t]*(\d[\d.]*)/g, (_, sign, digits) => `${sign}Rp${digits}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function render(data) {
  const bytes = await buildFinancialReport({ snapshotAt: '2026-10-18T12:00:00.000Z', ...data });
  return { bytes, text: await extractPdf(bytes), pages: (await PDFDocument.load(bytes)).getPageCount() };
}

const ledger = [
  { id: 1, event_type: 'opening_balance', direction: 'in', amount_idr: 1000000, balance_after_idr: 1000000, created_at: '2026-10-01T01:00:00.000Z', description: 'Saldo awal kas', actor_name: 'Sari' },
  { id: 2, event_type: 'topup', direction: 'in', amount_idr: 500000, balance_after_idr: 1500000, created_at: '2026-10-04T02:00:00.000Z', description: 'Top up kas Oktober', note: 'Bukti bank TOPUP-42', created_by_name: 'Budi', actor_name: 'Sari', submission_id: 'PC-101' },
  { id: 3, event_type: 'expense', direction: 'out', amount_idr: 125000, balance_after_idr: 1375000, created_at: '2026-10-06T03:00:00.000Z', description: 'Beli tinta printer', note: 'Nota TINTA-7', created_by_name: 'Dina', actor_name: 'Sari', submission_id: 'PC-101' },
];

const submissions = [
  { id: 'PC-101', type: 'petty_cash', date: '2026-10-04', status: 'approved', amount_idr: 125000, description: 'Tinta printer', note: 'Catatan nyata: simpan nota TINTA-7', decision_reason: 'Keputusan nyata: setujui pembelian', created_by_name: 'Dina', created_by_role: 'user', created_by_position: 'Bendahara' },
  { id: 'RF-201', type: 'finance', date: '2026-10-05', status: 'rejected', amount_idr: 300000, description: 'Sewa kendaraan', note: 'Catatan nyata: vendor penuh', decision_reason: 'Keputusan nyata: tolak, di luar anggaran', created_by_name: 'Raka', created_by_role: 'manager', created_by_position: 'Ketua' },
];

const audits = [{ id: 77, created_at: '2026-10-06T04:00:00.000Z', action: 'submission.rejected', actor_name: 'Raka', entity_type: 'finance_request', entity_id: 'RF-201', details_json: { audit_sentinel: 'AUDIT-KEPT-77', reason: 'anggaran' } }];

test('cashflow report keeps filters, totals and ledger notes but excludes submission and audit dumps', async () => {
  const { text } = await render({ submissions, ledger, audits, filterDescription: 'Status: disetujui; Pemohon: Dina', periodLabel: '01-06 Oktober 2026' });
  assert.match(text, /Tanggal cetak/);
  assert.doesNotMatch(text, /Filter:|Status: disetujui; Pemohon: Dina/);
  assert.doesNotMatch(text, /Saldo hanya kas tercatat|Tanggal: pencatatan kas/);
  assert.doesNotMatch(text, /Tanggal cetak:.*\d{2}:\d{2}/);
  assert.match(text, /Top up kas Oktober/);
  assert.match(text, /Beli tinta printer/);
  assert.match(text, /Rp500\.000/);
  assert.match(text, /Total kas keseluruhan\s+Rp1\.500\.000\s+Rp125\.000/);
  assert.doesNotMatch(text, /Saldo awal\s+Rp|Saldo akhir\s+Rp|Masuk\s+Rp|Keluar\s+Rp/);
  assert.match(text, /Total kas keseluruhan\s+Rp1\.500\.000\s+Rp125\.000/);
  assert.match(text, /Catatan nyata:/);
  assert.match(text, /Pengaju:\s+Dina/);
  for (const excluded of ['Keputusan nyata', 'AUDIT-KEPT-77', 'Lampiran Audit', 'Finance disetujui']) assert.ok(!text.includes(excluded), excluded);
  assert.match(text, /Halaman 1 dari \d+/);
});

test('does not print headings for empty irrelevant sections', async () => {
  const { text } = await render({ ledger, submissions: [], audits: [] });
  assert.match(text, /Laporan Petty Cash/);
  assert.doesNotMatch(text, /Pengajuan Petty Cash/);
  assert.doesNotMatch(text, /Request Finance\s+No\./);
  assert.doesNotMatch(text, /Lampiran Audit/);
});

test('empty filtered report is one page with the explicit empty-report message', async () => {
  const { text, pages } = await render({ submissions: [], ledger: [], audits: [], filterDescription: 'Tanggal: 31-12-2099' });
  assert.equal(pages, 1);
  assert.match(text, /Tidak ada transaksi pada filter ini\./);
  assert.match(text, /Tanggal cetak/);
  assert.doesNotMatch(text, /Petty Cash - Buku Kas/);
  assert.doesNotMatch(text, /Request Finance - User & Manager/);
  assert.doesNotMatch(text, /Lampiran Audit/);
});

test('long descriptions paginate without dropping unique beginning and ending sentinels', async () => {
  const longDescription = `LONG-START-9 ${'deskripsi panjang transaksi '.repeat(180)} LONG-END-9`;
  const { text, pages } = await render({
    submissions: [],
    ledger: [{ id: 1, created_at: '2026-10-07T03:00:00Z', direction: 'in', amount_idr: 99000, balance_after_idr: 99000, description: longDescription, note: 'LONG-NOTE-9', created_by_name: 'Dina' }],
    audits: [],
  });
  assert.ok(pages > 1, `expected pagination, got ${pages} page(s)`);
  assert.match(text, /LONG-START-9/);
  assert.match(text, /LONG-END-9/);
  assert.match(text, /LONG-NOTE-9/);
  assert.doesNotMatch(text, /LONG-DECISION-9/);
  assert.match(text, /Rp99\.000/);
  assert.match(text, /Halaman \d+ dari \d+/);
});
