import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../site/report-filters.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../site/mobile-polish.css', import.meta.url), 'utf8');

test('report pagination has one semantic page group and one separate reset group', () => {
  assert.match(script, /class="report-pagination-pages" role="group" aria-label="Pindah halaman laporan"/);
  assert.match(script, /class="report-pagination-start" role="group" aria-label="Awal daftar laporan"/);
  assert.equal((script.match(/data-manager-report-action="before"/g) || []).length, 1);
  assert.equal((script.match(/data-manager-report-action="after"/g) || []).length, 1);
  assert.equal((script.match(/data-manager-report-action="reset-page"/g) || []).length, 1);
});

test('pagination controls expose distinct keyboard labels and share the loading disabled state', () => {
  assert.match(script, /aria-label="Ke halaman laporan sebelumnya"[^>]*\$\{current\.loading \? 'disabled' : ''\}/);
  assert.match(script, /aria-label="Ke halaman laporan berikutnya"[^>]*\$\{current\.loading \? 'disabled' : ''\}/);
  assert.match(script, /aria-label="Kembali ke halaman pertama laporan"[^>]*\$\{current\.loading \? 'disabled' : ''\}/);
});

test('pagination copy is not rendered in the report heading', () => {
  assert.doesNotMatch(script, /PDF mengikuti periode, pencarian, dan pengaju; kategori mengikuti tombol unduhan dan hanya laporan disetujui\. Daftar ditampilkan 5 per halaman\./);
  assert.match(script, /<h2 id="managerReportsTitle">Laporan User &amp; Manager<\/h2>/);
});

test('pagination layout wraps at phone widths and keeps explicit gaps and minimum targets', () => {
  assert.match(css, /\.manager-report-filters \.report-pagination \{[\s\S]*?flex-wrap: wrap;[\s\S]*?gap: 10px;/);
  assert.match(css, /\.manager-report-filters \.report-pagination-pages,[\s\S]*?gap: 8px;/);
  assert.match(css, /\.manager-report-filters \.report-pagination button \{[\s\S]*?min-width: 0;[\s\S]*?min-height: 44px;/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.manager-report-filters \.report-pagination-start button \{\s*width: 100%;\s*\}/);
});
