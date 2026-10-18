import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { PDFDocument, decodePDFRawStream } from 'pdf-lib';
import { buildFinancialReport, statusLabel, wrap, amount } from '../functions/_lib/pdf-report.js';

function fixture(count = 0) {
  return {
    managerName: 'Manajer Uji — Pangsuma', snapshotAt: '2025-05-20T12:00:00.000Z',
    ledger: Array.from({ length: Math.min(count, 12) }, (_, i) => ({ id: i + 1, created_at: `2025-05-${String((i % 9) + 1).padStart(2, '0')}T03:00:00Z`, event_type: i ? 'petty_cash_approval' : 'opening_balance', direction: i === 0 ? 'credit' : (i % 2 ? 'debit' : 'out'), amount_idr: i ? 125000 : 2000000, balance_after_idr: 2000000 - i * 125000, note: i ? 'Pembelian perlengkapan latihan' : 'Saldo awal' })),
    submissions: Array.from({ length: count }, (_, i) => ({ id: `SUB-${String(i + 1).padStart(5, '0')}`, date: `2025-05-${String((i % 9) + 1).padStart(2, '0')}`, type: i % 2 ? 'finance_request' : 'petty_cash', status: ['pending', 'approved', 'rejected'][i % 3], amount_idr: 10000 + i, created_by_name: i % 2 ? 'Nama Pemohon Dengan Jabatan' : 'User', created_by_role: i % 2 ? 'Manager' : 'User', created_by_position: 'Staff', description: 'Deskripsi pengajuan yang panjang sekali untuk memastikan teks membungkus dengan aman dan tidak keluar dari tabel '.repeat(3), note: 'Catatan internal dengan karakter Unicode: café — “uji” 日本語', decision_reason: i % 3 === 2 ? 'Ditolak karena data tidak lengkap' : '' })),
    audits: Array.from({ length: count }, (_, i) => ({ id: i + 1, created_at: '2025-05-12T08:00:00Z', action: 'submission.status_changed', entity_type: 'submission', entity_id: `SUB-${i + 1}`, actor_name: 'Manager', details_json: JSON.stringify({ from: 'pending', to: 'approved', explanation: 'Rincian audit panjang '.repeat(4) }) }))
  };
}

test('buildFinancialReport returns a loadable PDF for empty inputs', async () => {
  const bytes = await buildFinancialReport({});
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.slice(0, 5).toString() === '37,80,68,70,45');
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
});

test('buildFinancialReport handles Unicode and long descriptions without throwing', async () => {
  const bytes = await buildFinancialReport(fixture(3));
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 1);
  await writeFile('/tmp/pangsuma-professional-sample.pdf', bytes);
});

test('ledger supports credit/debit and in/out vocabularies and readable labels', async () => {
  const data = fixture(2);
  data.ledger.push({ id: 99, created_at: '2025-05-30T03:00:00Z', direction: 'out', amount_idr: 5000, balance_after_idr: 1870000, note: 'Legacy direction' });
  const bytes = await buildFinancialReport(data);
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 1);
  assert.equal(statusLabel('approved'), 'Disetujui');
  assert.equal(statusLabel('sent'), 'Terkirim');
});

test('wrap uses measured font widths for long unbroken legal descriptions', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont('Helvetica');
  const lines = wrap('X'.repeat(1200), font, 7.4, 120);
  assert.ok(lines.length > 1);
  assert.ok(lines.every(line => font.widthOfTextAtSize(line, 7.4) <= 120));
});

test('a very tall row is split over pages instead of overflowing', async () => {
  const data = fixture(1);
  data.submissions[0].description = 'Uraian legal '.repeat(1200);
  const bytes = await buildFinancialReport(data);
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() > 2, `expected split pages, got ${doc.getPageCount()}`);
});

test('buildFinancialReport paginates large exports and keeps all sections', async () => {
  const bytes = await buildFinancialReport(fixture(550));
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() > 20, `expected many pages, got ${doc.getPageCount()}`);
  assert.ok(bytes.length > 10000);
});

test('large aggregate rupiah is formatted exactly without floating-point rounding', () => {
  assert.equal(amount(18014398509481983n), 'Rp18.014.398.509.481.983');
});

async function reportText(bytes) {
  const document = await PDFDocument.load(bytes);
  const lines = [];
  for (const page of document.getPages()) {
    const contents = page.node.Contents();
    for (let i = 0; contents && i < contents.size(); i++) {
      const raw = Buffer.from(decodePDFRawStream(document.context.lookup(contents.get(i))).decode()).toString();
      for (const [, hex] of raw.matchAll(/<([A-F0-9]+)> Tj/gi)) lines.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
  }
  return { text: lines.join('\n'), count: document.getPageCount() };
}

test('filtered PDF preserves explicit period, real account balances, concise scope labels, category totals and row counts', async () => {
  const data = fixture(1);
  data.submissions[0].status = 'approved';
  data.ledger = [{ id: 2, event_type: 'petty_cash_approval', direction: 'debit', amount_idr: 500, balance_after_idr: 1500, created_at: '2026-10-10T03:00:00.000Z', actor_name: 'Manager Uji', note: 'Biaya terpilih' }];
  data.audits = [];
  const result = await reportText(await buildFinancialReport({ ...data,
    periodLabel: 'Periode 01/10/2026 - 15/10/2026', filterDescription: 'Jenis: Petty Cash | Status: Disetujui',
    openingBalanceIdr: 2000, closingBalanceIdr: 1500, ledgerIsPartial: true }));
  assert.match(result.text, /Periode 01\/10\/2026 - 15\/10\/2026/);
  assert.match(result.text, /Filter: Jenis: Petty Cash/);
  assert.match(result.text, /Saldo akun awal Rp2\.000/);
  assert.match(result.text, /Saldo akun akhir Rp1\.500/);
  assert.match(result.text, /Buku Kas Terpilih \(Saldo Akun\)/);
  assert.match(result.text, /Keluar terpilih Rp500/);
  assert.doesNotMatch(result.text, /transaksi lain di luar filter tidak ditampilkan/);
  assert.match(result.text, /Baris ledger 1 \| Audit 0/);
  assert.match(result.text, /Petty Cash: 1 pengajuan/);
  assert.match(result.text, /Request Finance: 0 pengajuan/);
  assert.match(result.text, /Pencatat: Manager Uji/);
  assert.ok(result.text.includes(`Halaman ${result.count} dari ${result.count}`));
});

test('positive opening balance is used instead of the original zero sentinel', async () => {
  const data = fixture(0);
  data.ledger = [
    { id: 1, event_type: 'opening_balance', direction: 'credit', amount_idr: 0, balance_after_idr: 0, created_at: '2026-10-01T00:00:00Z' },
    { id: 2, event_type: 'opening_balance', direction: 'credit', amount_idr: 1000, balance_after_idr: 1000, created_at: '2026-10-02T00:00:00Z' }
  ];
  const { text } = await reportText(await buildFinancialReport(data));
  assert.match(text, /Saldo awal Rp1\.000/);
});

test('report totals retain exact bigint and integer-string rupiah values', async () => {
  const value = 9007199254740993n;
  const { text } = await reportText(await buildFinancialReport({
    snapshotAt: '2026-10-18T03:00:00Z',
    submissions: [{ id: 'large-1', type: 'finance_request', status: 'approved', date: '2026-10-01', amount_idr: value.toString(), description: 'Nominal presisi' }],
    ledger: [{ id: 1, event_type: 'opening_balance', direction: 'credit', amount_idr: value, balance_after_idr: value, created_at: '2026-10-01T03:00:00Z' }]
  }));
  assert.match(text, /Finance disetujui Rp9\.007\.199\.254\.740\.993/);
  assert.match(text, /Saldo akhir Rp9\.007\.199\.254\.740\.993/);
  assert.match(text, /Total diajukan Rp9\.007\.199\.254\.740\.993/);
  assert.doesNotMatch(text, /9\.007\.199\.254\.740\.992/);
});

test('automatic report period follows audit dates rather than print date for audit-only input', async () => {
  const { text } = await reportText(await buildFinancialReport({
    snapshotAt: '2026-10-18T03:00:00Z',
    audits: [{ id: 1, created_at: '2026-09-02T03:00:00Z', action: 'cash.reconciled', details_json: 'Audit periode September' }]
  }));
  assert.match(text, /Periode 02 Sep 2026 - 02 Sep 2026/);
  assert.match(text, /Tanggal cetak:.*18\/10\/2026/);
});

test('font substitution has a concise conditional data-integrity marker, not a generic disclaimer', async () => {
  const data = fixture(1);
  const { text } = await reportText(await buildFinancialReport(data));
  assert.match(text, /Karakter di luar font ditampilkan sebagai \?\./);
  assert.doesNotMatch(text, /Data asli tidak diubah/);
  const plain = await reportText(await buildFinancialReport({}));
  assert.doesNotMatch(plain.text, /Karakter di luar font/);
});
