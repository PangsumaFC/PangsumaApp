import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const theme = fs.readFileSync(new URL('../site/pangsuma-theme.css', import.meta.url), 'utf8');
const evidence = fs.readFileSync(new URL('../site/report-evidence.js', import.meta.url), 'utf8');
const evidenceCss = fs.readFileSync(new URL('../site/report-evidence.css', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const pdfBrowser = fs.readFileSync(new URL('../site/pdf-browser.html', import.meta.url), 'utf8');
const reportFilters = fs.readFileSync(new URL('../site/report-filters.js', import.meta.url), 'utf8');

test('Finance navigation keeps one actual Finance page and does not mislabel mobile groups', () => {
  assert.doesNotMatch(app, /nav-group.*Laporan/);
  assert.doesNotMatch(app, /nav-group.*Pengelolaan kas/);
  assert.equal((app.match(/id: 'finance'/g) || []).length, 1);
  assert.match(app, /mobile\.innerHTML = items\.map\(navButton\)/);
});

test('Finance search and pagination controls are touch-sized and keyboard-visible', () => {
  assert.match(theme, /report-filter-search input[^}]*min-height:\s*44px/);
  assert.match(theme, /report-filter-actions button, \.report-pagination button[^}]*min-height:\s*44px/);
  assert.match(theme, /report-filter-search input:focus-visible/);
});

test('PDF download has no external browser or clipboard fallback UI', () => {
  assert.doesNotMatch(app, /managerPdfFallback|pdf-fallback/);
  assert.doesNotMatch(app, /Coba buka di Chrome atau Safari|navigator\.clipboard/);
  assert.match(app, /ManagerReportFilters\.pdfUrl\(reportType\)/);
  assert.match(app, /data-report-type="petty_cash"/);
  assert.match(app, /data-report-type="finance_request"/);
});
test('Receipt list retry is actionable and does not clear pending upload state', () => {
  assert.ok(evidence.includes('class=\"receipt-retry\"'));
  assert.match(evidence, /if \(!ctx\.listLoading\) void loadReceipts\(ctx\)/);
  assert.match(evidence, /prepared: null/);
  assert.match(evidenceCss, /\.receipt-retry \{[^}]*min-height:\s*44px/);
});

test('Frontend copy keeps product names and capitalization consistent', () => {
  const copy = [app, index, pdfBrowser, reportFilters].join('\n');
  assert.doesNotMatch(copy, /\bPetty cash\b|\bpetty cash\b/);
  assert.match(copy, /\bPetty Cash\b/);
  assert.match(copy, /\bRequest Finance\b/);
  assert.match(index, />Tambah\/isi ulang Petty Cash<\/h2>/);
  assert.match(app, />Request Finance PDF<\/button>/);
  assert.match(pdfBrowser, /Petty Cash atau Request Finance/);
});
