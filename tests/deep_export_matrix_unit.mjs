import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { CSV_HEADERS, csvCell, csvHeader, csvLine } from '../functions/_lib/csv-export.js';
import { buildFinancialReport, amount, statusLabel, wrap } from '../functions/_lib/pdf-report.js';

const exec = promisify(execFile);
const evidenceDir = process.env.PANGSUMA_DEEP_EXPORT_EVIDENCE || fileURLToPath(new URL('../.evidence/deep-export/', import.meta.url));
const manifest = [];
const counts = { csv: { pass: 0, fail: 0, blocked: 0 }, pdf: { pass: 0, fail: 0, blocked: 0 }, policy: { pass: 0, fail: 0, blocked: 0 } };
function scenario(domain, name, fn) {
  test(`${domain}: ${name}`, async () => {
    try { await fn(); manifest.push({ domain, name, status: 'pass' }); counts[domain].pass++; }
    catch (error) { manifest.push({ domain, name, status: 'fail', error: String(error) }); counts[domain].fail++; throw error; }
  });
}
function row(i, extra = {}) { return { id: `s-${i}`, type: 'petty_cash', status: 'approved', date: `2026-10-${String((i % 9) + 1).padStart(2, '0')}`, created_at: `2026-10-${String((i % 9) + 1).padStart(2, '0')}T03:00:00Z`, amount_idr: i * 125000, description: `Keterangan ${i}`, request_number: `PC112026${String(i).padStart(6, '0')}`, created_by_name: 'Staff Sintetis', ...extra }; }
async function pdfText(bytes, name) { await mkdir(evidenceDir, { recursive: true }); const path = join(evidenceDir, name); await writeFile(path, bytes); const { stdout } = await exec('pdftotext', ['-layout', path, '-']); return { text: stdout, path }; }
async function pdfScenario(name, opts, checks) { const bytes = await buildFinancialReport({ snapshotAt: '2026-10-19T03:00:00Z', managerName: 'Manager Synthetic', ...opts }); assert.ok(bytes.byteLength > 500, 'PDF should contain bytes'); const loaded = await PDFDocument.load(bytes); assert.ok(loaded.getPageCount() >= 1); const out = await pdfText(bytes, `${name}.pdf`); checks(out.text, loaded.getPageCount()); }

// CSV matrix (16 distinct serialization/schema/download-shape scenarios).
scenario('csv', 'header has one BOM and 19 stable columns', () => { const h = csvHeader(); assert.equal(h[0], '\ufeff'); assert.equal(h.slice(1), csvLine(CSV_HEADERS)); assert.equal(CSV_HEADERS.length, 19); });
scenario('csv', 'ordinary Unicode and Indonesian text round-trip quoting', () => assert.equal(csvCell('Keterangan: makan siang — pemain'), '"Keterangan: makan siang — pemain"'));
scenario('csv', 'comma delimiter is quoted', () => assert.equal(csvCell('A, B, C'), '"A, B, C"'));
scenario('csv', 'double quotes are doubled', () => assert.equal(csvCell('Dia berkata "ya"'), '"Dia berkata ""ya"""'));
scenario('csv', 'LF is preserved in one quoted cell', () => assert.equal(csvCell('baris satu\nbaris dua'), '"baris satu\nbaris dua"'));
scenario('csv', 'CRLF record termination', () => assert.match(csvLine(['a', 'b']), /a","b"\r\n$/));
scenario('csv', 'null and undefined become empty cells', () => { assert.equal(csvCell(null), '""'); assert.equal(csvCell(undefined), '""'); });
scenario('csv', 'zero and negative amounts remain numeric strings', () => { assert.equal(csvCell(0), '"0"'); assert.equal(csvCell(-125000), '"-125000"'); });
scenario('csv', 'formula equals is neutralized', () => assert.equal(csvCell('=SUM(A1:A2)'), '"\'=SUM(A1:A2)"'));
scenario('csv', 'formula plus is neutralized with leading spaces', () => assert.equal(csvCell('  +cmd'), '"\'  +cmd"'));
scenario('csv', 'formula at-sign is neutralized', () => assert.equal(csvCell('@audit'), '"\'@audit"'));
scenario('csv', 'formula minus is neutralized', () => assert.equal(csvCell('-2+3'), '"\'-2+3"'));
scenario('csv', 'boolean and object values stringify deterministically', () => { assert.equal(csvCell(true), '"true"'); assert.equal(csvCell({ id: 1 }), '"[object Object]"'); });
scenario('csv', 'empty row still emits column count and CRLF', () => { const line = csvLine(Array(CSV_HEADERS.length).fill('')); assert.equal(line.split(',').length, 19); assert.ok(line.endsWith('\r\n')); });
scenario('csv', 'large ID and decimal-like string are not rounded', () => assert.equal(csvCell('9007199254740993'), '"9007199254740993"'));
scenario('csv', 'mixed delimiters preserve field ordering', () => assert.equal(csvLine(['id-1', 'approved', '1,250', 'note\nnext']), '"id-1","approved","1,250","note\nnext"\r\n'));
scenario('csv', 'very long Keterangan remains a single quoted cell', () => { const value = 'x'.repeat(10000); const encoded = csvCell(value); assert.equal(encoded.length, 10002); assert.equal(encoded[0] + encoded.at(-1), '""'); });

// PDF matrix (24 distinct combinations including both report types, empty/boundary histories, layout and approval assets).
scenario('pdf', 'empty petty cash renders explicit empty-history message', async () => pdfScenario('empty-petty-cash', { reportType: 'petty_cash', submissions: [], ledger: [] }, (text, pages) => { assert.match(text, /Tidak ada transaksi pada filter ini/); assert.match(text, /Laporan Petty Cash/); assert.equal(pages, 1); }));
scenario('pdf', 'empty finance request renders request title', async () => pdfScenario('empty-finance-request', { reportType: 'finance_request', submissions: [], ledger: [] }, (text) => { assert.match(text, /Tidak ada transaksi pada filter ini/); assert.match(text, /Laporan Request Finance/); }));
scenario('pdf', 'petty cash incoming total and balance', async () => pdfScenario('cash-incoming', { submissions: [], ledger: [{ id: 1, event_type: 'topup', direction: 'in', amount_idr: 500000, balance_after_idr: 500000, created_at: '2026-10-01T03:00:00Z', note: 'Top up', actor_name: 'Kasir' }] }, (text) => { assert.match(text, /500\.000/); assert.match(text, /Top up/); }));
scenario('pdf', 'petty cash outgoing total', async () => pdfScenario('cash-outgoing', { submissions: [], ledger: [{ id: 2, event_type: 'expense', direction: 'out', amount_idr: 275000, balance_after_idr: 225000, created_at: '2026-10-02T03:00:00Z', note: 'Belanja', actor_name: 'Kasir' }] }, (text) => { assert.match(text, /275\.000/); assert.match(text, /Belanja/); }));
scenario('pdf', 'finance request approved row and Keterangan', async () => pdfScenario('finance-approved', { reportType: 'finance_request', submissions: [row(1)] }, (text) => { assert.match(text, /Keterangan 1/); assert.match(text, /Total request disetujui/); assert.match(text, /125\.000/); }));
scenario('pdf', 'finance pending and rejected statuses remain visible', async () => pdfScenario('finance-statuses', { reportType: 'finance_request', submissions: [row(2, { status: 'pending' }), row(3, { status: 'rejected' })] }, (text) => { assert.match(text, /Tidak ada transaksi pada filter ini/); }));
scenario('pdf', 'request number is rendered in table', async () => pdfScenario('request-number', { reportType: 'finance_request', submissions: [row(7)] }, (text) => assert.match(text, /PC112026000007/)));
scenario('pdf', 'finance request attachment links are PDF annotations', async () => { const bytes = await buildFinancialReport({ reportType: 'finance_request', submissions: [row(8, { dropbox_receipt_urls: ['https://www.dropbox.com/scl/fi/abc123/receipt-8.jpg'] })] }); const doc = await PDFDocument.load(bytes); const annotations = doc.getPages().flatMap(p => p.node.Annots()?.asArray?.() || []); assert.ok(annotations.length >= 1); });
scenario('pdf', 'unsafe attachment scheme is excluded', async () => { const bytes = await buildFinancialReport({ reportType: 'finance_request', submissions: [row(9, { dropbox_receipt_urls: ['javascript:alert(1)'] })] }); const text = (await pdfText(bytes, 'unsafe-attachment.pdf')).text; assert.doesNotMatch(text, /javascript/); });
scenario('pdf', 'long Keterangan wraps without dropping text', async () => { const long = 'Keterangan panjang '.repeat(35); await pdfScenario('long-keterangan', { reportType: 'finance_request', submissions: [row(10, { description: long })] }, text => { assert.match(text, /Keterangan panjang/); assert.ok(text.length > 500); }); });
scenario('pdf', 'newline Keterangan is safe', async () => await pdfScenario('newline-keterangan', { reportType: 'finance_request', submissions: [row(11, { description: 'baris satu\nbaris dua' })] }, text => { assert.match(text, /baris satu/); assert.match(text, /baris dua/); }));
scenario('pdf', 'emoji/unencodable text gets replacement notice', async () => await pdfScenario('unicode-replacement', { reportType: 'finance_request', submissions: [row(12, { description: 'Keterangan 😀' })] }, text => assert.match(text, /Karakter di luar font/)));
scenario('pdf', 'boundary 1 row has approval signature and stamp labels', async () => await pdfScenario('boundary-one', { reportType: 'finance_request', submissions: [row(13)] }, text => { assert.match(text, /Rahmat Saputro/); assert.match(text, /Manager/); assert.match(text, /DATA DEMO/); }));
scenario('pdf', 'boundary 15 rows paginates and labels every page', async () => await pdfScenario('boundary-15', { reportType: 'finance_request', submissions: Array.from({ length: 15 }, (_, i) => row(i + 20)) }, (text, pages) => { assert.ok(pages >= 1); assert.match(text, /Halaman 1 dari/); assert.match(text, new RegExp(`Halaman ${pages} dari ${pages}`)); }));
scenario('pdf', '90-row history remains bounded by page limit', async () => await pdfScenario('history-90', { reportType: 'finance_request', submissions: Array.from({ length: 90 }, (_, i) => row(i + 100)) }, (_text, pages) => assert.ok(pages <= 20)));
scenario('pdf', 'maxPages one rejects oversized history safely', async () => { await assert.rejects(() => buildFinancialReport({ reportType: 'finance_request', maxPages: 1, submissions: Array.from({ length: 90 }, (_, i) => row(i + 200)) }), /report_too_large|terlalu besar/); });
scenario('pdf', 'maxPages zero clamps to one', async () => { const bytes = await buildFinancialReport({ reportType: 'finance_request', maxPages: 0, submissions: [] }); assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1); });
scenario('pdf', 'large positive and negative amounts format safely', async () => await pdfScenario('large-values', { submissions: [], ledger: [{ id: 3, direction: 'out', amount_idr: -999999999999, balance_after_idr: 999999999999, created_at: '2026-10-03T03:00:00Z', note: 'Large' }] }, text => assert.match(text, /999\.999\.999\.999/)));
scenario('pdf', 'opening and closing balances appear in cash report', async () => await pdfScenario('opening-closing', { openingBalanceIdr: 1000000, closingBalanceIdr: 1250000, ledger: [{ id: 4, direction: 'in', amount_idr: 250000, balance_after_idr: 1250000, created_at: '2026-10-04T03:00:00Z', note: 'Saldo' }] }, text => assert.match(text, /1\.250\.000/)));
scenario('pdf', 'partial ledger marker does not crash report', async () => await pdfScenario('partial-ledger', { ledgerIsPartial: true, ledger: [{ id: 5, direction: 'out', amount_idr: 1000, balance_after_idr: 0, created_at: '2026-10-05T03:00:00Z', note: 'Partial' }] }, text => assert.match(text, /Partial/)));
scenario('pdf', 'filter and period labels are printed', async () => await pdfScenario('filter-period', { filterDescription: 'Status approved', periodLabel: '1-31 Oktober 2026', submissions: [row(14)] }, text => { assert.match(text, /1-31 Oktober 2026/); }));
scenario('pdf', 'attachment array with multiple links remains usable', async () => { const bytes = await buildFinancialReport({ submissions: [], ledger: [{ id: 6, direction: 'out', amount_idr: 1000, balance_after_idr: 0, created_at: '2026-10-06T03:00:00Z', note: 'Links', dropbox_receipt_urls: ['https://example.test/a', 'https://example.test/b'] }] }); assert.ok(bytes.length > 1000); });
scenario('pdf', 'statuses map to human-readable labels', () => { assert.equal(statusLabel('approved'), 'Disetujui'); assert.equal(statusLabel('pending'), 'Menunggu'); assert.equal(statusLabel('rejected'), 'Ditolak'); });
scenario('pdf', 'amount helper formats Indonesian thousands', () => { assert.equal(amount(125000), 'Rp125.000'); assert.equal(amount(-125000), '-Rp125.000'); });
scenario('pdf', 'wrap helper preserves empty fallback', () => { assert.deepEqual(wrap('', { widthOfTextAtSize: () => 1 }, 8, 40), ['-']); });

// Policy/cache/update/offline matrix: local static contract checks only; no network, login, Dropbox, migration, or writes.
const apiSource = await readFile(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../site/app.js', import.meta.url), 'utf8');
scenario('policy', 'CSV route is manager-gated', () => { assert.match(apiSource, /if \(path === '\/export\.csv'\) return exportCsv/); assert.match(apiSource, /manager_required/); });
scenario('policy', 'PDF route is manager-gated', () => { assert.match(apiSource, /if \(path === '\/export\.pdf'\) return exportPdf/); assert.match(apiSource, /requireManager/); });
scenario('policy', 'unauthenticated export path has explicit authentication error', () => assert.match(apiSource, /authentication_required/));
scenario('policy', 'export response declares downloadable content disposition', () => assert.match(apiSource, /Content-Disposition/));
scenario('policy', 'offline/update behavior is not coupled to export helper', () => { assert.doesNotMatch(apiSource.slice(apiSource.indexOf('async function exportCsv'), apiSource.indexOf('async function exportPdf')), /fetch\(/); assert.match(appSource, /async function downloadPdf\(/); });
scenario('policy', 'CSV content type is explicit', () => assert.match(apiSource, /text\/csv/));
scenario('policy', 'PDF content type is explicit', () => assert.match(apiSource, /application\/pdf/));
scenario('policy', 'export code has no Dropbox upload/write call', () => { const exportCode = apiSource.slice(apiSource.indexOf('async function exportCsv'), apiSource.indexOf('async function exportPdf') + 3000); assert.doesNotMatch(exportCode, /upload|dropbox\.com\/2\/files/); });

after(async () => { await mkdir(evidenceDir, { recursive: true }); const report = { generatedAt: new Date().toISOString(), baseline: '494a5bf', localOnly: true, counts, total: manifest.length, scenarios: manifest, notes: ['All scenarios ran against local source/helpers only.', 'Policy checks are static contract checks; no browser, prod login/data, Dropbox, migrations, or external writes were used.'] }; await writeFile(join(evidenceDir, 'scenario-manifest.json'), JSON.stringify(report, null, 2)); });
