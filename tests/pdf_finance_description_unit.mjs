import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFDict, PDFName, PDFRawStream } from 'pdf-lib';
import { unifiedReportRows } from '../functions/_lib/pdf-cashflow.js';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';

const execFileAsync = promisify(execFile);
const evidenceDir = process.env.PANGSUMA_PDF_EVIDENCE_DIR || '/tmp/pangsuma-finance-description-evidence';
const RECEIPT = 'https://www.dropbox.com/scl/fi/finance-description/receipt.pdf';
const SNAPSHOT = '2026-10-18T12:00:00.000Z';

function finance(id, overrides = {}) {
  return {
    id, type: 'finance_request', status: 'approved', amount_idr: 370_000,
    description: 'Perlengkapan latihan', date: '2026-10-10', created_at: '2026-10-10T03:00:00Z',
    created_by_name: 'Akun Fixture', ...overrides,
  };
}
function petty(id, overrides = {}) {
  return finance(id, { type: 'petty_cash', description: 'Kas kecil normal', ...overrides });
}

async function inspectPdf(bytes, name) {
  await mkdir(evidenceDir, { recursive: true });
  const path = join(evidenceDir, name);
  await writeFile(path, bytes);
  const { stdout: text } = await execFileAsync('pdftotext', ['-layout', path, '-'], { maxBuffer: 32 * 1024 * 1024 });
  const pdf = await PDFDocument.load(bytes);
  return { text, pdf, path };
}
function pageTexts(text) { return text.split(/\f/).filter(Boolean); }
function imageCount(pdf, page) {
  const xObject = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
  if (!xObject) return 0;
  return xObject.entries().filter(([, ref]) => {
    const object = pdf.context.lookup(ref);
    return object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image';
  }).length;
}
function annotations(pdf) {
  return pdf.getPages().flatMap(page => {
    const annots = page.node.Annots();
    return annots ? annots.asArray().map(ref => pdf.context.lookup(ref, PDFDict)) : [];
  });
}

// This is intentionally a projection-level contract: no cleanup regex may erase
// legitimate numeric, unit, or status-like prose supplied by the user.
test('Finance approved/sent and petty keep purpose only and inputs immutable', () => {
  const submissions = [
    finance('approved', { description: 'Perlengkapan latihan', note: '' }),
    finance('sent', {
      status: 'sent', date: '2026-10-11', description: '2 unit @ Rp185.000 | Finance Disetujui Rp370.000',
      note: 'Catatan terpisah: 370000 unit; status-like text tetap milik pengguna',
    }),
    petty('petty', { date: '2026-10-12', description: 'Kas kecil normal', note: 'Nota petty asli' }),
    finance('pending', { status: 'pending', date: '2026-10-13', description: 'Tidak boleh tampil' }),
  ];
  const source = { submissions, ledger: [] };
  const before = structuredClone(source);
  const { rows, totalSubmitted, submissionCount } = unifiedReportRows(source);

  assert.equal(submissionCount, 3, 'approved/sent Finance and approved petty are eligible');
  assert.equal(totalSubmitted, 1_110_000n);
  assert.deepEqual(rows.map(row => row.report_key), ['submission-approved', 'submission-sent', 'submission-petty']);
  assert.equal(rows[0].report_description, 'Perlengkapan latihan');
  assert.equal(rows[1].report_description, '2 unit @ Rp185.000 | Finance Disetujui Rp370.000');
  assert.equal(rows[2].report_description, 'Kas kecil normal');
  assert.doesNotMatch(rows[0].report_description, /Finance Disetujui/);
  assert.match(rows[1].report_description, /Finance Disetujui Rp370\.000/);
  assert.doesNotMatch(rows[1].report_description, /\| Finance Terkirim/);
  assert.equal(JSON.stringify(source), JSON.stringify(before), 'projection must not mutate source rows');
});

test('Finance PDF has purpose-only description, exact row/total amounts, sent eligibility, and no generated suffix under either renderer', async () => {
  const submissions = [
    finance('finance-approved', { description: 'Perlengkapan latihan', note: '' }),
    finance('finance-sent', {
      status: 'sent', date: '2026-10-11', description: 'Status approved 2 unit / 370000 user-entered',
      note: 'Catatan terpisah 370000 unit', dropbox_receipt_urls: [RECEIPT],
    }),
    petty('petty-normal', { date: '2026-10-12', description: 'Kas kecil normal', note: 'Nota petty asli' }),
  ];
  const before = structuredClone(submissions);
  for (const reportType of ['finance_request', 'petty_cash']) {
    const result = await inspectPdf(await buildFinancialReport({
      reportType, submissions, ledger: [], snapshotAt: SNAPSHOT, managerName: 'Manager Fixture',
      periodLabel: `Finance description ${reportType}`,
    }), `description-${reportType}.pdf`);
    assert.match(result.text, reportType === 'finance_request' ? /Laporan Request Finance/ : /Laporan Petty Cash/);
    assert.match(result.text, /Perlengkapan latihan/);
    assert.match(result.text, /Status approved 2 unit \/ 370000/);
    assert.match(result.text, /user-entered/);
    assert.doesNotMatch(result.text, /Cat[a\n]?tan terpisah/);
    assert.doesNotMatch(result.text, /370000 unit/);
    assert.match(result.text, /Kas kecil normal/);
    assert.doesNotMatch(result.text, /Nota petty asli/);
    const amountCount = (result.text.match(/370\.000/g) || []).length;
    assert.equal(amountCount, reportType === 'finance_request' ? 3 : 0, 'amounts appear only in numeric columns, not in purpose text');
    if (reportType === 'finance_request') {
      assert.match(result.text, /Total request disetujui\s+Rp\s+1\.110\.000/);
    }
    assert.doesNotMatch(result.text, /Finance (Disetujui|Terkirim)/, 'generated Finance suffix is absent in either report type');
    assert.doesNotMatch(result.text, /Pengajuan Disetujui/, 'petty purpose excludes generated status and amount too');
    assert.equal(annotations(result.pdf).length, 1, 'the synthetic Dropbox receipt remains linked exactly once');
  }
  assert.deepEqual(submissions, before, 'PDF generation must not mutate authoritative submissions');
});

test('Finance-only PDF prints Perlengkapan latihan with exactly one row amount and one 370000 total', async () => {
  const result = await inspectPdf(await buildFinancialReport({
    reportType: 'finance_request',
    submissions: [finance('finance-only', { description: 'Perlengkapan latihan', note: '' })],
    ledger: [], snapshotAt: SNAPSHOT, managerName: 'Manager Fixture', periodLabel: 'Finance-only nominal fixture',
  }), 'finance-only-370000.pdf');
  assert.match(result.text, /Perlengkapan latihan\s+Rp\s+370\.000/);
  assert.equal((result.text.match(/370\.000/g) || []).length, 2, 'one row amount and one total');
  assert.match(result.text, /Total request disetujui\s+Rp\s+370\.000/);
  assert.doesNotMatch(result.text, /\| Finance Disetujui/);
});

test('Both report types retain first-page-only headers, links, wrapping, and final signature/stamp/DATA DEMO on multiple pages', async () => {
  const long = `MULTIPAGE-DESCRIPTION-START ${'latihan unit status approved 370000 '.repeat(55)} MULTIPAGE-DESCRIPTION-END`;
  for (const reportType of ['finance_request', 'petty_cash']) {
    const submissions = Array.from({ length: 92 }, (_, index) => finance(`${reportType}-${index}`, {
      date: `2026-10-${String((index % 20) + 1).padStart(2, '0')}`,
      description: index === 0 ? long : `PAGED-${reportType}-${index}`,
      note: index === 0 ? 'Catatan wrapping terpisah' : '',
      dropbox_receipt_urls: index === 0 ? [RECEIPT] : [],
    }));
    const result = await inspectPdf(await buildFinancialReport({
      reportType, submissions, ledger: [], snapshotAt: SNAPSHOT, managerName: 'Manager Fixture',
      periodLabel: `Multipage ${reportType}`, maxPages: 150,
    }), `multipage-${reportType}.pdf`);
    const pages = pageTexts(result.text);
    assert.ok(pages.length > 1, `${reportType} must render multiple pages`);
    const title = reportType === 'finance_request' ? 'Laporan Request Finance' : 'Laporan Petty Cash';
    assert.equal((result.text.match(new RegExp(title, 'g')) || []).length, 1, 'report header is first-page only');
    assert.equal((result.text.match(new RegExp(`Multipage ${reportType}`, 'g')) || []).length, 1, 'period header is first-page only');
    assert.match(result.text, /MULTIPAGE-DESCRIPTION-STAR/);
    assert.match(result.text, /MULTIPAGE-DESCRIPTION-END/);
    assert.equal((result.text.match(/DATA DEMO/g) || []).length, 1);
    assert.equal((result.text.match(/Yang mengajukan,/g) || []).length, 1);
    assert.equal((result.text.match(/Rahmat Saputro/g) || []).length, 1);
    assert.equal((result.text.match(/Manager/g) || []).length, 3, 'header label, header value, and signature role remain');
    assert.equal((result.text.match(/Lampiran/g) || []).length, 2, 'header plus one linked row');
    assert.equal(annotations(result.pdf).length, 1);
    assert.equal(result.pdf.getPages().filter(page => imageCount(result.pdf, page) > 0).length, 1);
    assert.equal(imageCount(result.pdf, result.pdf.getPages().at(-1)), 2, 'signature and stamp are final-page-only');
    for (const continuation of pages.slice(1)) assert.doesNotMatch(continuation, new RegExp(`${title}|Multipage ${reportType}`));
  }
});
