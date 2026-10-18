import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';

const execFileAsync = promisify(execFile);
const evidenceDir = process.env.PANGSUMA_PDF_EVIDENCE_DIR || join(tmpdir(), 'pangsuma-pdf-ledger-evidence');
const fixturePath = `${evidenceDir}/ledger-multipage-synthetic.pdf`;

async function textOf(bytes, persist = true) {
  const inputPath = persist ? fixturePath : '/tmp/pangsuma-ledger-dedup.pdf';
  if (persist) {
    await mkdir(evidenceDir, { recursive: true });
  }
  await writeFile(inputPath, bytes);
  const { stdout } = await execFileAsync('pdftotext', ['-layout', inputPath, '-'], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function syntheticLedger(count = 72) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    event_type: index === 0 ? 'opening_balance' : 'expense',
    direction: index === 0 ? 'in' : 'out',
    amount_idr: index === 0 ? 1000000 : 125000,
    balance_after_idr: index === 0 ? 1000000 : 1000000 - index * 125000,
    created_at: `2026-10-${String((index % 27) + 1).padStart(2, '0')}T0${index % 9}:00:00Z`,
    description: index === 7
      ? `SIMULASI synthetic continuation ${'keterangan panjang '.repeat(140)}`
      : `Transaksi kas ${index + 1}`,
    note: index === 7 ? 'Catatan SIMULASI' : `Nota-${index + 1}`,
  }));
}

test('multipage cashflow ledger has headers only on page one, subtotals, grand total, and mixed-data watermark', async () => {
  const bytes = await buildFinancialReport({
    snapshotAt: '2026-10-18T12:00:00.000Z',
    managerName: 'Manager Uji',
    filterDescription: 'Semua transaksi uji',
    ledger: syntheticLedger(),
    submissions: [{ type: 'petty_cash', status: 'approved', date: '2026-10-01', amount_idr: 1, description: 'Data nyata' }],
  });
  const text = await textOf(bytes);
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  assert.ok(pages > 2, `expected multipage ledger fixture, got ${pages}`);
  for (const label of ['No.', 'Tanggal', 'Keterangan', 'Masuk', 'Keluar', 'Saldo']) assert.ok(text.includes(label), `missing ${label}`);
  const pageTexts = text.split('\f').slice(0, pages);
  assert.match(pageTexts[0], /PANGSUMA FC/);
  assert.match(pageTexts[0], /LAPORAN KEUANGAN/);
  assert.match(pageTexts[0], /No\.\s+Tanggal\s+Keterangan\s+Masuk\s+Keluar\s+Saldo/);
  assert.match(pageTexts[0], /Filter: Semua transaksi uji/);
  assert.equal((text.match(/LAPORAN KEUANGAN/g) || []).length, 1);
  assert.equal((text.match(/No\./g) || []).length, 1);
  for (const [index, pageText] of pageTexts.entries()) {
    assert.match(pageText, new RegExp(`Halaman ${index + 1} dari ${pages}`));
    if (index === 0) continue;
    assert.doesNotMatch(pageText, /PANGSUMA FC|LAPORAN KEUANGAN|Tanggal cetak:|Manager:|Memuat data contoh|Periode |Filter:|Saldo hanya kas tercatat/);
    assert.doesNotMatch(pageText, /No\.|Tanggal\s+Keterangan|Masuk\s+Keluar\s+Saldo/);
  }
  assert.ok((text.match(/Subtotal halaman/g) || []).length >= 2, 'each ledger page needs a labeled subtotal');
  assert.equal((text.match(/Total kas keseluruhan/g) || []).length, 1, 'grand total must be distinct and singular');
  assert.match(text, /Memuat data contoh/);
  assert.match(text, /Tanggal cetak:.*18\/10\/2026/);
  assert.match(text, /Total kas keseluruhan[\s\S]*Rp1\.000\.000[\s\S]*Rp8\.875\.000/);
});

test('headerless continuation pages preserve every row, running balance and page subtotal exactly once', async () => {
  let balance = 0;
  const ledger = Array.from({ length: 96 }, (_, index) => {
    const incoming = index % 3 === 0;
    const value = incoming ? 100000 : 10000;
    balance += incoming ? value : -value;
    return { id: index + 1, direction: incoming ? 'in' : 'out', amount_idr: value, balance_after_idr: balance,
      created_at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(), description: `ROW-${String(index + 1).padStart(3, '0')}` };
  });
  const bytes = await buildFinancialReport({ ledger, snapshotAt: '2026-10-18T12:00:00.000Z' });
  const text = await textOf(bytes);
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  assert.ok(pages >= 3);
  const money = value => `${value < 0 ? '-' : ''}Rp${Math.abs(value).toLocaleString('id-ID')}`;
  const rowLines = text.split('\n').filter(line => /ROW-\d{3}/.test(line));
  assert.equal(rowLines.length, ledger.length);
  ledger.forEach((row, index) => {
    const line = rowLines[index];
    assert.match(line, new RegExp(`^\\s*${index + 1}\\s+01/10/2026\\s+${row.description}\\s+`));
    const cells = line.trim().split(/\s+/).slice(-3);
    assert.deepEqual(cells, [row.direction === 'in' ? money(row.amount_idr) : '-', row.direction === 'out' ? money(row.amount_idr) : '-', money(row.balance_after_idr)]);
  });
  let totalIn = 0; let totalOut = 0;
  for (const pageText of text.split('\f').slice(0, pages)) {
    const lines = pageText.split('\n').filter(line => /ROW-\d{3}/.test(line));
    const sums = lines.reduce((sum, line) => {
      const row = ledger[Number(line.match(/ROW-(\d{3})/)[1]) - 1];
      sum[row.direction === 'in' ? 0 : 1] += row.amount_idr;
      return sum;
    }, [0, 0]);
    if (lines.length) {
      const subtotals = [...pageText.matchAll(/Subtotal halaman\s+Rp([\d.]+)\s+Rp([\d.]+)/g)];
      assert.equal(subtotals.length, 1);
      assert.deepEqual(subtotals[0].slice(1).map(value => Number(value.replaceAll('.', ''))), sums);
    }
    totalIn += sums[0]; totalOut += sums[1];
  }
  assert.ok(text.includes(`Saldo akhir ${money(balance)}`));
  const grand = [...text.matchAll(/Total kas keseluruhan\s+Rp([\d.]+)\s+Rp([\d.]+)/g)];
  assert.equal(grand.length, 1);
  assert.deepEqual(grand[0].slice(1).map(value => Number(value.replaceAll('.', ''))), [totalIn, totalOut]);
  assert.equal(totalIn - totalOut, balance);
});

test('split ledger descriptions do not repeat monetary amounts in continuation chunks', async () => {
  const bytes = await buildFinancialReport({
    snapshotAt: '2026-10-18T12:00:00.000Z',
    ledger: [{ id: 1, event_type: 'opening_balance', direction: 'in', amount_idr: 123456, balance_after_idr: 123456, created_at: '2026-10-01T01:00:00Z', description: 'LONG-START ' + 'uraian '.repeat(1100) + ' LONG-END' }],
  });
  const text = await textOf(bytes, false);
  assert.match(text, /LONG-START/);
  assert.match(text, /LONG-END/);
  const firstPage = text.split('\f')[0];
  assert.match(firstPage, /Subtotal halaman\s+Rp123\.456\s+Rp0/, 'subtotal must stay on the page containing its monetary row');
  // Summary contains the same opening/closing value; the ledger row itself must
  // still contribute only one additional occurrence beyond subtotal and grand total.
  assert.equal((text.match(/Rp123\.456/g) || []).length, 6, 'amount is not repeated in continuation chunks');
});

test('caller cannot raise the fixed 150-page ceiling or receive a partial report', async () => {
  const ledger = Array.from({ length: 151 }, (_, index) => ({ id: index + 1, direction: 'credit', amount_idr: 1, balance_after_idr: index + 1, created_at: '2026-10-01T01:00:00Z', description: `Row ${index} ` + 'long complete cash description '.repeat(400) }));
  await assert.rejects(buildFinancialReport({ ledger, maxPages: 999 }), error => error.status === 413 && error.code === 'report_too_large' && /150 halaman/.test(error.message));
});
