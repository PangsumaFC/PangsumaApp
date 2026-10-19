import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';
import { unifiedReportRows } from '../functions/_lib/pdf-cashflow.js';
const execFileAsync = promisify(execFile);
const applicant = 'Asep Zainal Arifin';
const hash = createHash('sha256').update('PANGSUMA-SIMULASI-20261018-APPROVED-A:sub-2-4').digest('hex');
const demoId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-b${hash.slice(17,20)}-${hash.slice(20,32)}`;
const demoDescription = 'SIMULASI [D20261018-A] Penggantian perlengkapan 3.5';
const demoNote = `SIMULASI | Seed langsung oleh Manager untuk akun ${applicant}; bukan pengajuan asli pengguna. Tanggal usaha untuk uji; pencatatan mengikuti waktu eksekusi.`;
const attachment = 'https://www.dropbox.com/scl/fi/fixture123/receipt.pdf';

for (const type of ['petty_cash', 'finance_request']) {
  for (const linked of [false, true]) {
    test(`${type} ${linked ? 'ledger' : 'submission'} Keterangan omits applicant and verified demo ordinals only`, async () => {
      const submission = { id: demoId, type, status: 'approved', amount_idr: 125000, date: '2026-10-18', description: demoDescription, note: demoNote, created_by_name: applicant, dropbox_receipt_urls: [attachment] };
      const real = { ...submission, id: 'real-quantity', description: 'Penggantian perlengkapan 3.5', note: 'Ukuran 3.5 meter; bukti asli', amount_idr: 25000 };
      const source = { submissions: [submission, real], ledger: linked ? [{ id: 7, submission_id: demoId, description: demoDescription, submission_note: demoNote, created_by_name: applicant, created_at: '2026-10-18T01:00:00Z', direction: 'out', amount_idr: 125000, balance_after_idr: 500000 }] : [], audits: [{ action: 'submission.created', actor_name: applicant, entity_id: demoId }] };
      const before = structuredClone(source);
      const projected = unifiedReportRows(source);
      const demo = projected.rows.find(row => row.report_key === (linked ? 'ledger-7' : `submission-${demoId}`));
      assert.ok(demo.report_description.startsWith('Penggantian perlengkapan'));
      assert.doesNotMatch(demo.report_description, /3\.5|Pengaju:|Asep|SIMULASI|Seed langsung/);
      assert.equal(projected.totalSubmitted, 150000n);
      assert.equal(projected.submissionCount, 2);
      if (linked) {
        assert.equal(demo.amount_idr, 125000);
        assert.equal(demo.balance_after_idr, 500000);
        assert.equal(demo.created_by_name, applicant);
      }
      assert.deepEqual(demo.report_attachment_urls, [attachment]);
      const bytes = await buildFinancialReport({ ...source, reportType: type, snapshotAt: '2026-10-18T12:00:00Z', managerName: 'Manager Fixture' });
      const dir = await mkdtemp(join(tmpdir(), 'pdf-keterangan-'));
      try {
        const path = join(dir, 'report.pdf');
        await writeFile(path, bytes);
        const { stdout: text } = await execFileAsync('pdftotext', ['-layout', path, '-']);
        const header = text.split('\n').find(line => /^\s*No\.\s+Tanggal\s+/.test(line));
        assert.equal(header?.trim().replace(/\s+/g, ' '), type === 'finance_request'
          ? 'No. Tanggal No. Pengajuan Keterangan Nominal request Lampiran'
          : 'No. Tanggal No. Pengajuan Keterangan Masuk Keluar Saldo Lampiran', 'description column heading is exactly Keterangan');
        assert.doesNotMatch(text, /Pengaju:|Asep|D20261018|Seed langsung/);
        assert.equal((text.match(/3\.5/g) || []).length, 1, 'the real purpose retains 3.5; optional note is not rendered');
        assert.match(text, /Lampiran/);
        assert.match(text, /Rahmat Saputro/);
        assert.equal((text.match(/DATA DEMO/g) || []).length, 1);
        if (linked || type === 'finance_request') assert.match(text, /125\.000/);
        else assert.doesNotMatch(text, /125\.000/, 'non-ledger petty amount must not reappear as generated prose');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      assert.deepEqual(source, before, 'descriptions, names, audit, ledger and all source fields stay unchanged');
    });
  }
}

test('real names, applicant-like prose and decimal quantities in source text are not scrubbed', () => {
  const description = 'Beli 3.5 meter; Pengaju: Vendor Asep';
  const note = 'Konfirmasi Asep Zainal Arifin; ukuran 3.5';
  const result = unifiedReportRows({ submissions: [{ id: 'real', type: 'petty_cash', status: 'approved', amount_idr: 12000, description, note, created_by_name: applicant }] });
  assert.equal(result.rows[0].report_description, description);
});
