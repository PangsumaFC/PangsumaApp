import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unifiedReportRows } from '../functions/_lib/pdf-cashflow.js';
import { reportDisplayFields } from '../functions/_lib/pdf-demo-provenance.js';
function seedId(tag) {
  const h = createHash('sha256').update(`PANGSUMA-SIMULASI-20261018-APPROVED-A:${tag}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-b${h.slice(17,20)}-${h.slice(20,32)}`;
}
const applicant = 'Rahmat Saputro';
const description = 'SIMULASI [D20261018-A] Konsumsi kegiatan 1.2';
const note = `SIMULASI | Seed langsung oleh Manager untuk akun ${applicant}; bukan pengajuan asli pengguna. Tanggal usaha untuk uji; pencatatan mengikuti waktu eksekusi.`;
const fields = { id: seedId('sub-0-1'), description, note, applicant };
test('exact known demo identity and full templates clean PDF fields only', () => {
  assert.deepEqual(reportDisplayFields(fields), { description: 'Konsumsi kegiatan 1.2', note: '', knownDemo: true });
  const labels = ['Perlengkapan latihan','Konsumsi kegiatan','Transport kegiatan','Kebutuhan administrasi','Penggantian perlengkapan','Biaya kegiatan'];
  for (let a = 0; a < 11; a++) for (let i = 0; i < (a === 0 ? 6 : 10); i++) {
    const business = `${labels[i % labels.length]} ${a + 1}.${i + 1}`;
    assert.equal(reportDisplayFields({ ...fields, id: seedId(`sub-${a}-${i}`), description: `SIMULASI [D20261018-A] ${business}` }).description, business);
  }
});
test('lookalike real text, unknown IDs, changed notes, missing names and changed batches are preserved', () => {
  for (const override of [
    { id: 'real-record' }, { note: note + ' Catatan asli: tolong jangan hapus.' },
    { applicant: '' }, { description: description.replace('D20261018-A','D20261019-B') },
    { description: 'Konsumsi asli; Seed langsung oleh Manager adalah isi kuitansi' },
    { note: 'Tanggal usaha untuk uji; pencatatan mengikuti waktu eksekusi' },
  ]) {
    const input = { ...fields, ...override };
    assert.deepEqual(reportDisplayFields(input), { description: input.description, note: input.note, knownDemo: false });
  }
});
test('known topup provenance cleans only exact identity and exact text', () => {
  const text = 'SIMULASI [D20261018-A] | Seed langsung oleh Manager; bukan transaksi kas nyata.';
  const input = { topupId: seedId('topup'), description: text, note: text };
  assert.deepEqual(reportDisplayFields(input), { description: 'Tambah kas', note: '', knownDemo: true });
  assert.equal(reportDisplayFields({ ...input, topupId: 'real-topup' }).note, text);
});
test('both request and linked ledger retain business description, submitter, amounts and source metadata', () => {
  for (const linked of [false, true]) {
    const submission = { id: fields.id, description, note, created_by_name: applicant, type: linked ? 'petty_cash' : 'finance_request', status: 'approved', date: '2026-10-18', amount_idr: 125000 };
    const source = { submissions: [submission], ledger: linked ? [{ id: 4, submission_id: fields.id, description, submission_note: note, created_by_name: applicant, direction: 'debit', amount_idr: 125000, balance_after_idr: 500000, created_at: '2026-10-18T01:00:00Z' }] : [] };
    const before = JSON.stringify(source);
    const result = unifiedReportRows(source);
    assert.equal(result.rows.length, 1);
    assert.match(result.rows[0].report_description, /Konsumsi kegiatan 1\.2/);
    assert.match(result.rows[0].report_description, /Pengaju: Rahmat Saputro/);
    assert.doesNotMatch(result.rows[0].report_description, /D20261018|Seed langsung|Tanggal usaha|pencatatan mengikuti|bukan pengajuan/);
    assert.equal(result.hasSimulation, true);
    assert.equal(result.totalSubmitted, 125000n);
    assert.equal(JSON.stringify(source), before);
    if (linked) assert.equal(result.rows[0].balance_after_idr, 500000);
  }
});
test('real user text containing SIMULASI or provenance phrases is never scrubbed by substring', () => {
  const text = 'Kegiatan SIMULASI bencana\nCatatan: bukan pengajuan asli pengguna adalah kutipan.';
  const result = unifiedReportRows({ submissions: [{ id: 'real', type: 'finance_request', status: 'approved', date: '2026-10-18', description: text, note: 'Seed langsung oleh Manager tercetak di bukti.', created_by_name: applicant }] });
  assert.ok(result.rows[0].report_description.includes(text));
  assert.match(result.rows[0].report_description, /Seed langsung oleh Manager tercetak di bukti\./);
});
