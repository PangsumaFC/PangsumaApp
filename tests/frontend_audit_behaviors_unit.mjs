import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const theme = fs.readFileSync(new URL('../site/pangsuma-theme.css', import.meta.url), 'utf8');
const evidence = fs.readFileSync(new URL('../site/report-evidence.js', import.meta.url), 'utf8');
const evidenceCss = fs.readFileSync(new URL('../site/report-evidence.css', import.meta.url), 'utf8');

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

test('PDF fallback is hidden by default and never advertises external browser or clipboard handoff', () => {
  assert.ok(app.includes('id=\"managerPdfFallback\" hidden'));
  assert.match(app, /fallback\.hidden = false/);
  assert.match(app, /fallback\.hidden = true/);
  assert.match(app, /ManagerReportFilters\.pdfUrl\(\)/);
  assert.doesNotMatch(app, /Coba buka di Chrome atau Safari/);
  assert.doesNotMatch(app, /navigator\.clipboard/);
});

test('Receipt list retry is actionable and does not clear pending upload state', () => {
  assert.ok(evidence.includes('class=\"receipt-retry\"'));
  assert.match(evidence, /if \(!ctx\.listLoading\) void loadReceipts\(ctx\)/);
  assert.match(evidence, /prepared: null/);
  assert.match(evidenceCss, /\.receipt-retry \{[^}]*min-height:\s*44px/);
});
