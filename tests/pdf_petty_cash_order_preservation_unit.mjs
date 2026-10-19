import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';

const execFileAsync = promisify(execFile);
const evidenceDir = join(tmpdir(), 'pangsuma-petty-cash-order-preservation');

async function pdfText(bytes) {
  await mkdir(evidenceDir, { recursive: true });
  const path = join(evidenceDir, 'petty-cash-order-preservation.pdf');
  await writeFile(path, bytes);
  const { stdout } = await execFileAsync('pdftotext', ['-layout', path, '-'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

test('Petty Cash keeps transaction chronology and running balances, not request creation order', async () => {
  const bytes = await buildFinancialReport({
    reportType: 'petty_cash',
    snapshotAt: '2026-01-31T12:00:00.000Z',
    managerName: 'Manager Synthetic',
    periodLabel: 'Synthetic chronology regression',
    submissions: [
      {
        id: 'request-created-late',
        type: 'petty_cash',
        status: 'approved',
        request_number: 'PC012026000001',
        date: '2026-01-10',
        created_at: '2026-01-10T08:00:00Z',
        created_by_name: 'Synthetic A',
        description: 'Transaksi A - dibuat belakangan',
        amount_idr: 125000,
      },
      {
        id: 'request-created-early',
        type: 'petty_cash',
        status: 'approved',
        request_number: 'PC012026000002',
        date: '2026-01-01',
        created_at: '2026-01-01T08:00:00Z',
        created_by_name: 'Synthetic B',
        description: 'Transaksi B - dibuat lebih awal',
        amount_idr: 50000,
      },
    ],
    ledger: [
      {
        id: 99,
        event_type: 'opening_balance',
        created_at: '2026-01-01T01:00:00Z',
        direction: 'in',
        amount_idr: 1000000,
        balance_after_idr: 1000000,
        description: 'Saldo awal sintetis',
      },
      {
        id: 20,
        submission_id: 'request-created-late',
        event_type: 'petty_cash_approval',
        created_at: '2026-01-02T01:00:00Z',
        direction: 'out',
        amount_idr: 125000,
        balance_after_idr: 875000,
      },
      {
        id: 10,
        submission_id: 'request-created-early',
        event_type: 'petty_cash_approval',
        created_at: '2026-01-03T01:00:00Z',
        direction: 'in',
        amount_idr: 50000,
        balance_after_idr: 925000,
      },
    ],
  });

  const text = await pdfText(bytes);
  const rowA = text.indexOf('Transaksi A - dibuat belakangan');
  const rowB = text.indexOf('Transaksi B - dibuat lebih awal');
  assert.ok(rowA >= 0, 'row A is present in the PDF');
  assert.ok(rowB >= 0, 'row B is present in the PDF');
  assert.ok(rowA < rowB, 'ledger rows follow transaction chronology despite request timestamps');

  // pdftotext may split a narrow money cell (for example "Rp 1.\n000.000").
  // Removing whitespace keeps these checks about PDF values, not extraction wrapping.
  const tableText = text.replace(/\s+/g, '');
  assert.match(tableText, /1.*?01\/01\/2026.*?Saldoawalsintetis.*?Rp1\.000\.000.*?Rp1\.000\.000/);
  assert.match(tableText, /2.*?02\/01\/2026.*?TransaksiA-dibuatbelakangan.*?Rp125\.000.*?Rp875\.000/);
  assert.match(tableText, /3.*?03\/01\/2026.*?TransaksiB-dibuatlebihawal.*?Rp50\.000.*?Rp925\.000/);
  assert.match(tableText, /Totalkaskeseluruhan.*?Rp1\.050\.000.*?Rp125\.000/);

  assert.equal((text.match(/PC012026000001/g) || []).length, 1);
  assert.equal((text.match(/PC012026000002/g) || []).length, 1);
});
