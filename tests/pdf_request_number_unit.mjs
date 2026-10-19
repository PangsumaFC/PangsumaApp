import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';
import { unifiedReportRows, requestNumberOf } from '../functions/_lib/pdf-cashflow.js';

const execFileAsync = promisify(execFile);
const evidenceDir = process.env.PANGSUMA_PDF_EVIDENCE_DIR || join(process.cwd(), '.evidence');
const urls = token => `https://www.dropbox.com/scl/fi/${token}/${token}.pdf?rlkey=${token}&dl=0`;
const PC = 'PC112026000123';
const RF = 'RF112026000456';

function annotations(pdf) {
  return pdf.getPages().flatMap(page => (page.node.Annots()?.asArray() || []).map(ref => {
    const annotation = pdf.context.lookup(ref, PDFDict);
    const action = annotation.lookup(PDFName.of('A'), PDFDict);
    return {
      uri: action.lookup(PDFName.of('URI')).decodeText(),
      contents: annotation.lookup(PDFName.of('Contents')).decodeText(),
      rect: annotation.lookup(PDFName.of('Rect')).asArray().map(value => value.numberValue),
    };
  }));
}

async function rendered(data, filename) {
  const bytes = await buildFinancialReport({ snapshotAt: '2026-11-18T12:00:00Z', managerName: 'QA Manager', ...data });
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, filename), bytes);
  const { stdout: text } = await execFileAsync('pdftotext', ['-layout', join(evidenceDir, filename), '-']);
  return { pdf: await PDFDocument.load(bytes), text, bytes };
}

for (const [reportType, requestNumber, filename] of [['petty_cash', PC, 'request-numbers-PC.pdf'], ['finance_request', RF, 'request-numbers-RF.pdf']]) {
  test(`${reportType} renders canonical request number in its own column and exact blue attachment label`, async () => {
    const first = urls(`${reportType}-one`);
    const second = urls(`${reportType}-two`);
    const result = await rendered({
      reportType,
      submissions: [{ id: `${reportType}-submission`, type: reportType, status: 'approved', date: '2026-11-10', created_at: '2026-11-10T03:00:00Z', amount_idr: 125000, description: 'Tujuan pengajuan QA', note: 'Catatan jangan dicetak', request_number: requestNumber, dropbox_receipt_urls: [first, second] }],
      ledger: [],
    }, filename);
    assert.match(result.text, new RegExp(requestNumber.replaceAll('/', '\\/')));
    assert.equal((result.text.match(new RegExp(requestNumber.replaceAll('/', '\\/'), 'g')) || []).length, 3, 'number column plus one blue label per file');
    assert.doesNotMatch(result.text, /Catatan jangan dicetak/);
    const links = annotations(result.pdf);
    assert.deepEqual(links.map(link => link.uri), [first, second]);
    assert.deepEqual(links.map(link => link.contents), ['Lampiran baris 1, berkas 1', 'Lampiran baris 1, berkas 2']);
    assert.ok(links.every(link => link.rect[0] >= 30 && link.rect[2] <= 565 && link.rect[2] > link.rect[0]));
  });
}

test('standalone cash ledger keeps its canonical column empty and never fabricates an ID', async () => {
  const receipt = urls('standalone-ledger');
  const result = await rendered({
    reportType: 'petty_cash',
    submissions: [],
    ledger: [{ id: 9, event_type: 'expense', direction: 'out', amount_idr: 5000, balance_after_idr: 95000, created_at: '2026-11-10T03:00:00Z', description: 'Kas mandiri', dropbox_receipt_url: receipt }],
  }, 'request-numbers-standalone.pdf');
  assert.doesNotMatch(result.text, /PC\/\d{2}\/\d{4}\/\d{6}|RF\/\d{2}\/\d{4}\/\d{6}/);
  assert.match(result.text, /Kas mandiri/);
  const links = annotations(result.pdf);
  assert.equal(links.length, 1);
  assert.equal(links[0].uri, receipt);
  assert.match(result.text, /Lampiran/);
});

test('request-number projection accepts only canonical PC/RF IDs and does not mutate source data', () => {
  const source = { submissions: [
    { id: 'pc', type: 'petty_cash', status: 'approved', request_number: PC, description: 'PC' },
    { id: 'rf', type: 'finance_request', status: 'approved', request_number: RF, description: 'RF' },
    { id: 'bad', type: 'finance_request', status: 'approved', request_number: 'RF/11/2026/123' , description: 'bad' },
  ] };
  const before = structuredClone(source);
  const result = unifiedReportRows(source);
  assert.deepEqual(result.rows.map(row => row.request_number).sort((a, b) => String(a).localeCompare(String(b))), [null, PC, RF]);
  assert.equal(requestNumberOf({ requestNumber: ` ${PC} ` }), PC);
  assert.equal(requestNumberOf({ request_number: 'PC11202600012' }), null);
  assert.deepEqual(source, before);
});
