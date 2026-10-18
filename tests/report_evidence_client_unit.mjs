import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox = { console, URL, crypto: globalThis.crypto, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(new URL('../site/report-evidence.js', import.meta.url), 'utf8'), sandbox);
const evidence = sandbox.ReportEvidence;

test('escapeHTML protects receipt and duplicate text', () => {
  assert.equal(evidence.escapeHTML('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.equal(evidence.escapeHTML('"&\''), '&quot;&amp;&#39;');
});

test('duplicate check requires all bounded report fields', () => {
  const base = { type: 'Operasional', amountIdr: 12000, date: '2026-10-18', description: 'Beli tinta' };
  assert.equal(evidence.enoughForDuplicateCheck(base), true);
  assert.equal(evidence.enoughForDuplicateCheck({ ...base, amountIdr: 0 }), false);
  assert.equal(evidence.enoughForDuplicateCheck({ ...base, date: '18-10-2026' }), false);
  assert.equal(evidence.enoughForDuplicateCheck({ ...base, description: 'x'.repeat(151) }), false);
});

test('normalizer rejects SVG before decoding and oversized input', async () => {
  await assert.rejects(() => evidence.normalizeImage({ type: 'image/svg+xml', size: 100 }), /SVG/);
  await assert.rejects(() => evidence.normalizeImage({ type: 'image/jpeg', size: 10 * 1024 * 1024 + 1 }), /10 MB/);
});

test('picker accept list is aligned with decoder-supported JPEG and PNG types', () => {
  const source = fs.readFileSync(new URL('../site/report-evidence.js', import.meta.url), 'utf8');
  assert.match(source, /accept=\"image\/jpeg,image\/png\"/);
  assert.doesNotMatch(source, /accept=\"image\/jpeg,image\/png,image\/webp\"/);
});
