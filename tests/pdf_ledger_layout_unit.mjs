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

test('multipage cashflow ledger has exact spreadsheet labels, repeated headers, subtotals, grand total, and mixed-data watermark', async () => {
  const bytes = await buildFinancialReport({
    snapshotAt: '2026-10-18T12:00:00.000Z',
    managerName: 'Manager Uji',
    ledger: syntheticLedger(),
    submissions: [{ type: 'petty_cash', status: 'approved', date: '2026-10-01', amount_idr: 1, description: 'Data nyata' }],
  });
  const text = await textOf(bytes);
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  assert.ok(pages > 2, `expected multipage ledger fixture, got ${pages}`);
  for (const label of ['No.', 'Tanggal', 'Keterangan', 'Masuk', 'Keluar', 'Saldo']) assert.ok(text.includes(label), `missing ${label}`);
  assert.ok((text.match(/No\./g) || []).length > 2, 'ledger header should repeat on continuation pages');
  assert.ok((text.match(/Subtotal halaman/g) || []).length >= 2, 'each ledger page needs a labeled subtotal');
  assert.equal((text.match(/Total kas keseluruhan/g) || []).length, 1, 'grand total must be distinct and singular');
  assert.match(text, /Memuat data contoh/);
  assert.match(text, /Tanggal cetak:.*18\/10\/2026/);
  assert.match(text, /Total kas keseluruhan[\s\S]*Rp1\.000\.000[\s\S]*Rp8\.875\.000/);
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
