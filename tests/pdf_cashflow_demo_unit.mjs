import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';
import { onRequest } from '../functions/api/[[path]].js';
import { insertAudit, insertSubmission, request, seededFinancialDb } from './local_financial_db.mjs';

const execFileAsync = promisify(execFile);
const evidenceDir = process.env.PANGSUMA_PDF_EVIDENCE_DIR || join(tmpdir(), 'pangsuma-pdf-main-fix-evidence');

async function pdftotext(bytes, name = 'cashflow.pdf') {
  await mkdir(evidenceDir, { recursive: true });
  const path = `${evidenceDir}/${name}`;
  await writeFile(path, bytes);
  const { stdout } = await execFileAsync('pdftotext', ['-layout', path, '-'], { maxBuffer: 32 * 1024 * 1024 });
  // Normalize accounting-style spacing only for legacy semantic assertions;
  // pdf_approval_layout_unit.mjs separately verifies actual currency coordinates.
  return stdout.replace(/Rp[ \t]+(-?)[ \t]*(\d[\d.]*)/g, (_, sign, digits) => `${sign}Rp${digits}`);
}

function ledgerFixture(count = 48) {
  let balance = 0;
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    const incoming = index < 2 || (index > 2 && index % 2 === 0);
    const amount = index === 0 ? 0 : index === 1 ? 1_000_000 : index === 2 ? 125_000 : incoming ? 25_000 + index : 10_000 + index;
    balance += incoming ? amount : -amount;
    return {
      id, event_type: index < 2 ? 'opening_balance' : incoming ? 'cash_topup' : 'petty_cash_approval', direction: incoming ? 'credit' : 'debit', amount_idr: amount,
      balance_after_idr: balance, created_at: new Date(Date.UTC(2026, 9, 1, 1, index)).toISOString(),
      description: index < 3 ? `ORIGINAL-LEDGER-${id}` : `DEMO-LEDGER-${String(id).padStart(3, '0')}`,
      note: `Unique row sentinel ${id}`,
    };
  });
}

const financeSent = 'FINANCE-SENT-WITHOUT-LEDGER';
const auditSent = 'AUDIT-SHOULD-BE-IGNORED';

function assertPortraitA4(bytes) {
  const pages = PDFDocument.load(bytes);
  return pages.then(document => {
    for (const page of document.getPages()) {
      assert.ok(Math.abs(page.getWidth() - 595.28) < 1, `expected portrait A4 width, got ${page.getWidth()}`);
      assert.ok(Math.abs(page.getHeight() - 841.89) < 1, `expected portrait A4 height, got ${page.getHeight()}`);
    }
    return document.getPageCount();
  });
}

test('direct renderer merges eligible submissions with 48 ledger rows and preserves authoritative balances', async () => {
  const ledger = ledgerFixture();
  const incoming = ledger.filter(row => ['in', 'credit'].includes(row.direction)).reduce((sum, row) => sum + row.amount_idr, 0);
  const outgoing = ledger.filter(row => ['out', 'debit'].includes(row.direction)).reduce((sum, row) => sum + row.amount_idr, 0);
  const opening = 0;
  const closing = ledger.at(-1).balance_after_idr;
  // Opening is a credit row and is included in total Masuk; the range movement
  // relation therefore removes that opening credit before applying it again.
  assert.equal(opening + incoming - outgoing, closing);

  const bytes = await buildFinancialReport({
    snapshotAt: '2026-10-18T12:00:00.000Z', ledger, openingBalanceIdr: opening, closingBalanceIdr: closing,
    submissions: [
      { id: 'finance-sent', type: 'finance_request', status: 'sent', amount_idr: 999_999_999, description: financeSent, created_by_role: 'user', date: '2026-10-10' },
      { id: 'manager-finance', type: 'finance_request', status: 'approved', amount_idr: 777_000, description: 'MANAGER-FINANCE-ELIGIBLE', created_by_role: 'manager', date: '2026-10-11' },
      { id: 'user-pending', type: 'finance_request', status: 'pending', amount_idr: 888_000, description: 'USER-PENDING-EXCLUDED', created_by_role: 'user', date: '2026-10-10' },
      { id: 'user-rejected', type: 'finance_request', status: 'rejected', amount_idr: 666_000, description: 'USER-REJECTED-EXCLUDED', created_by_role: 'user' }
    ],
    audits: [{ id: 9, created_at: '2026-10-18T04:00:00.000Z', action: 'audit.noise', details_json: `${auditSent} ${'x'.repeat(90_000)}` }],
    maxPages: 150
  });
  const text = await pdftotext(bytes, 'unified-50.pdf');
  const pages = await assertPortraitA4(bytes);
  assert.ok(pages >= 1 && pages <= 150);
  assert.match(text, /LAPORAN KEUANGAN/);
  assert.match(text, /No\.\s+Tanggal\s+Keterangan\s+Masuk\s+Keluar\s+Saldo\s+Lampiran/);
  assert.match(text, /Total kas keseluruhan\s+Rp[\d.]+\s+Rp[\d.]+/);
  assert.doesNotMatch(text, /Saldo akun awal|Saldo akun akhir|Masuk terpilih|Keluar terpilih|Total pengajuan|Baris laporan/);
  assert.match(text, /FINANCE-SENT-WITHOUT/);
  assert.match(text, /MANAGER-FINANCE-ELIGIBLE/);
  assert.match(text, /Total kas keseluruhan\s+Rp1\.550\.550\s+Rp355\.575/);
  for (const row of ledger) assert.ok(text.includes(row.description), `missing ${row.description}`);
  assert.doesNotMatch(text, /Lampiran Audit|USER-PENDING-EXCLUDED|USER-REJECTED-EXCLUDED/);
  assert.doesNotMatch(text, new RegExp(auditSent));
  assert.doesNotMatch(text, /Subtotal halaman/);
  const grand = [...text.matchAll(/Total kas keseluruhan\s+Rp([\d.]+)\s+Rp([\d.]+)/g)];
  assert.equal(grand.length, 1);
  assert.equal(BigInt(grand[0][1].replaceAll('.', '')), BigInt(incoming));
  assert.equal(BigInt(grand[0][2].replaceAll('.', '')), BigInt(outgoing));
  await writeFile(`${evidenceDir}/unified-50.txt`, text);
  await writeFile(`${evidenceDir}/unified-50.json`, JSON.stringify({ rows: 50, ledgerRows: ledger.length, opening, incoming, outgoing, closing, pages }, null, 2));
});

test('partial ledger scope labels account balances and does not pretend selected sums reconcile all account', async () => {
  const ledger = ledgerFixture(4).slice(0, 4);
  const bytes = await buildFinancialReport({ ledger: [ledger[2]], openingBalanceIdr: 1_000_000, closingBalanceIdr: ledger[3].balance_after_idr, ledgerIsPartial: true, snapshotAt: '2026-10-18T12:00:00.000Z' });
  const text = await pdftotext(bytes, 'ledger-partial.pdf');
  assert.match(text, /Total kas keseluruhan\s+Rp0\s+Rp[\d.]+/);
  assert.match(text, /Lampiran/);
  assert.doesNotMatch(text, /Saldo akun awal|Saldo akun akhir|Masuk terpilih|Keluar terpilih|Baris laporan/);
});

test('renderer directly accepts more than 550 rows while retaining sentinels and page cap', async () => {
  const ledger = ledgerFixture(551).map((row, index) => ({ ...row, description: index === 0 ? 'DIRECT-550-START' : index === 550 ? 'DIRECT-550-END' : row.description }));
  const bytes = await buildFinancialReport({ ledger, snapshotAt: '2026-10-18T12:00:00.000Z', maxPages: 150 });
  const text = await pdftotext(bytes, 'ledger-direct-551.pdf');
  const pages = await assertPortraitA4(bytes);
  assert.ok(pages <= 150);
  assert.match(text, /DIRECT-550-START/);
  assert.match(text, /DIRECT-550-START/);
  assert.match(text, /DIRECT-550-END/);
  for (const row of ledger) assert.ok(text.includes(row.description), `missing ${row.description}`);
});

test('PDF endpoint merges eligible submissions with ledger and ignores excluded submissions plus oversized audit text', async () => {
  const { db, managerToken } = await seededFinancialDb();
  const ledger = ledgerFixture();
  const seededAt = db.db.prepare('SELECT created_at FROM cash_ledger WHERE id=1').get().created_at;
  // local_financial_db seeds the canonical zero opening row at id=1; retain it
  // and add 47 rows so the endpoint sees exactly 48 ledger rows in total.
  for (const row of ledger.slice(1, 48)) db.db.prepare(`INSERT INTO cash_ledger (id,event_type,direction,amount_idr,balance_after_idr,note,created_at,actor_id) VALUES (?,?,?,?,?,?,?,?)`).run(row.id, row.event_type, row.direction, row.amount_idr, row.balance_after_idr, `${row.description} | ${row.note || ''}`, seededAt, 'manager-1');
  insertSubmission(db, { id: '99999999-9999-4999-8999-999999999999', type: 'finance_request', status: 'sent', amount: 999999999, description: `SIMULASI ${financeSent}`, date: '2026-10-10' });
  insertSubmission(db, { id: '88888888-8888-4888-8888-888888888888', type: 'finance_request', status: 'approved', amount: 777000, description: 'MANAGER-FINANCE-ELIGIBLE', createdBy: 'manager-1', date: '2026-10-11' });
  insertSubmission(db, { id: '77777777-7777-4777-8777-777777777777', type: 'finance_request', status: 'pending', amount: 666000, description: 'USER-PENDING-EXCLUDED', date: '2026-10-12' });
  insertSubmission(db, { id: '66666666-6666-4666-8666-666666666666', type: 'finance_request', status: 'rejected', amount: 555000, description: 'USER-REJECTED-EXCLUDED', date: '2026-10-13' });
  insertAudit(db, { entityId: '99999999-9999-4999-8999-999999999999', details: { text: `${auditSent} ${'z'.repeat(90_000)}` }, createdAt: '2026-10-10T04:00:00.000Z' });
  const response = await onRequest({ request: request('/export.pdf?opening=0&fullhistory=0', managerToken), env: { DB: db } });
  assert.equal(response.status, 200, await response.clone().text());
  const text = await pdftotext(new Uint8Array(await response.arrayBuffer()), 'endpoint-unified.pdf');
  assert.match(text, /LAPORAN KEUANGAN/);
  const incoming = ledger.filter(row => row.direction === 'credit').reduce((sum, row) => sum + row.amount_idr, 0);
  const outgoing = ledger.filter(row => row.direction === 'debit').reduce((sum, row) => sum + row.amount_idr, 0);
  assert.equal(incoming - outgoing, ledger.at(-1).balance_after_idr);
  assert.ok(text.includes(`Total kas keseluruhan`));
  assert.ok(text.includes(`Rp${ledger.at(-1).balance_after_idr.toLocaleString('id-ID')}`));
  assert.match(text, /FINANCE-SENT-WITHOUT-LEDGER|MANAGER-FINANCE-ELIGIBLE/);
  assert.match(text, /DATA DEMO/);
  assert.doesNotMatch(text, /Lampiran Audit|USER-PENDING-EXCLUDED|USER-REJECTED-EXCLUDED|AUDIT-SHOULD-BE-IGNORED/);
});
