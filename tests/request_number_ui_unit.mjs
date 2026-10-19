import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../site/app.js', import.meta.url), 'utf8');
const filters = await readFile(new URL('../site/report-filters.js', import.meta.url), 'utf8');

test('request numbers are rendered as the human-facing identifier and escaped', () => {
  assert.match(app, /function submissionNumber\(item\)/);
  assert.match(app, /escapeHTML\(value\)/);
  assert.match(app, /submissionNumber\(item\)/);
  assert.match(app, /submissionNumber\(sub\)/);
  assert.doesNotMatch(app, /item\.id[^\n]*Nomor/);
});

test('archive search is server-scoped rather than filtering only loaded records', () => {
  assert.match(app, /Search and type filtering are server-scoped/);
  assert.match(app, /query\.set\('q', search\)/);
  assert.match(app, /placeholder="Cari nomor, kebutuhan, atau tanggal/);
  assert.match(filters, /placeholder="Nomor, keterangan, catatan, pengaju, atau status"/);
});

test('financial history displays only API-provided request numbers', () => {
  assert.match(app, /event\.request_number \? ` · Nomor/);
  assert.match(app, /escapeHTML\(event\.request_number\)/);
});
