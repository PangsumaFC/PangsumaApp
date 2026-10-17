import assert from 'node:assert/strict';
import test from 'node:test';
import { CSV_HEADERS, csvCell, csvHeader, csvLine } from '../functions/_lib/csv-export.js';

test('CSV preserves numeric negative amounts as numbers', () => {
  assert.equal(csvCell(-125000), '"-125000"');
  assert.equal(csvCell(0), '"0"');
  assert.equal(csvCell(null), '""');
});

test('CSV neutralizes formula-like text but leaves ordinary text unchanged', () => {
  assert.equal(csvCell('=SUM(A1:A2)'), '"\'=SUM(A1:A2)"');
  assert.equal(csvCell('  +cmd'), '"\'  +cmd"');
  assert.equal(csvCell('@user'), '"\'@user"');
  assert.equal(csvCell('normal text'), '"normal text"');
});

test('CSV quotes delimiters, quotes, and line breaks using CRLF records', () => {
  assert.equal(csvLine(['a,b', 'say "hi"', 'line1\nline2']), '"a,b","say ""hi""","line1\nline2"\r\n');
});

test('CSV header has one UTF-8 BOM and the stable 19-column schema', () => {
  const header = csvHeader();
  assert.ok(header.startsWith('\uFEFF'));
  assert.equal(header.slice(1), csvLine(CSV_HEADERS));
  assert.equal(CSV_HEADERS.length, 19);
});
