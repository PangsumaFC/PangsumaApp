import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFinancialReport, wrap } from '../functions/_lib/pdf-report.js';

const execFileAsync = promisify(execFile);
const evidenceDir = process.env.PANGSUMA_PDF_EVIDENCE_DIR || join(tmpdir(), 'pangsuma-pdf-description-wrap-evidence');
const attachment = 'https://www.dropbox.com/scl/fi/demo123/receipt.pdf';

async function pdfText(bytes, name) {
  await mkdir(evidenceDir, { recursive: true });
  const path = join(evidenceDir, name);
  await writeFile(path, bytes);
  const [{ stdout: text }, { stdout: bbox }] = await Promise.all([
    execFileAsync('pdftotext', ['-layout', path, '-'], { maxBuffer: 32 * 1024 * 1024 }),
    execFileAsync('pdftotext', ['-bbox', path, '-'], { maxBuffer: 32 * 1024 * 1024 }),
  ]);
  await writeFile(`${path}.txt`, text);
  await writeFile(`${path}.bbox.html`, bbox);
  return { text, bbox, path };
}

function wordsInBbox(bbox, needles) {
  const found = [];
  for (const match of bbox.matchAll(/<word[^>]*xMin="([\d.]+)"[^>]*xMax="([\d.]+)"[^>]*>([\s\S]*?)<\/word>/g)) {
    const value = match[3].replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    if (needles.some(needle => value.includes(needle))) found.push({ value, xMin: Number(match[1]), xMax: Number(match[2]) });
  }
  return found;
}

function overlappingDescriptionGlyphs(bbox, rightEdge) {
  const words = [];
  for (const match of bbox.matchAll(/<word[^>]*xMin="([\d.]+)"[^>]*yMin="([\d.]+)"[^>]*xMax="([\d.]+)"[^>]*yMax="([\d.]+)"[^>]*>/g)) {
    const [, xMin, yMin, xMax, yMax] = match.map(Number);
    if (xMin >= 115.5 && xMax <= rightEdge + 0.6) words.push({ yMin, yMax });
  }
  const overlaps = [];
  for (let i = 0; i < words.length; i += 1) for (let j = i + 1; j < words.length; j += 1) {
    if (Math.abs(words[i].yMin - words[j].yMin) > 3 && Math.min(words[i].yMax, words[j].yMax) - Math.max(words[i].yMin, words[j].yMin) > 0.5) overlaps.push([words[i], words[j]]);
  }
  return overlaps;
}

function pageCountFromBbox(bbox) { return (bbox.match(/<page /g) || []).length; }
function count(text, pattern) { return (text.match(pattern) || []).length; }

function baseSubmission(description, extra = {}) {
  return {
    id: extra.id || 'sub-fixed',
    type: extra.type || 'petty_cash', status: 'approved', amount_idr: 125000,
    description, date: '2026-10-01', created_by_name: 'Akun Demo',
    created_at: '2026-10-01T02:00:00Z', ...extra,
  };
}

function sourceRows(type, descriptions, extra = {}) {
  return descriptions.map((description, index) => baseSubmission(description, {
    id: `${type}-description-${index}`, type, ...extra,
    dropbox_receipt_urls: index === 0 ? [attachment] : [],
  }));
}

async function render(type, descriptions, options = {}) {
  return buildFinancialReport({
    reportType: type, submissions: sourceRows(type, descriptions, options.submissionExtra), ledger: [],
    snapshotAt: '2026-10-18T12:00:00.000Z', managerName: 'Manager Fixture',
    periodLabel: 'Fixture wrap regression', maxPages: options.maxPages || 150,
  });
}

test('wrap measures sum of glyph advances, preserves explicit newlines, and never truncates a long word', async () => {
  const font = await (async () => { const pdf = await PDFDocument.create(); return pdf.embedFont(StandardFonts.Helvetica); })();
  const explicit = 'Baris pertama\nBaris kedua';
  const lines = wrap(explicit, font, 8.5, 200);
  assert.deepEqual(lines, ['Baris pertama', 'Baris kedua']);
  const longWord = 'IDENTIFIER-' + 'x'.repeat(180);
  const longLines = wrap(longWord, font, 8.5, 35);
  assert.equal(longLines.join(''), longWord);
  assert.ok(longLines.every(line => Array.from(line).reduce((sum, char) => sum + font.widthOfTextAtSize(char, 8.5), 0) <= 35 + 1e-7));
});

for (const [type, rightEdge] of [['petty_cash', 326], ['finance_request', 361]]) {
  test(`${type} regression keeps wrapped descriptions inside the actual glyph column and avoids double wrapping`, async () => {
    const descriptions = [
      'pengguna. Tahun eksekusi. eksekusi.',
      'pengguna. eksekusi. mengikuti Konsumsi 1.2 WA Pengaju: akun |',
      `SIMULASI newline\nexplicit second line ${type} ${'word '.repeat(12)}`,
    ];
    const input = descriptions.map(value => ({ ...baseSubmission(value), nested: { keep: true } }));
    const before = structuredClone(input);
    const bytes = await buildFinancialReport({ reportType: type, submissions: input, ledger: [], snapshotAt: '2026-10-18T12:00:00.000Z', managerName: 'Manager Fixture', periodLabel: 'Fixture wrap regression' });
    assert.deepEqual(input, before, 'renderer must not mutate source rows');
    const { text, bbox } = await pdfText(bytes, `${type}-wrap.pdf`);
    assert.equal(count(text, /DATA DEMO/g), 1, 'one report-level demo marker only');
    assert.match(text, /Laporan (Petty Cash|Request Finance)/);
    assert.equal(count(text, /Fixture wrap regression/g), 1, 'header is emitted only on page one');
    for (const description of descriptions) {
      const plain = description.replace(/^SIMULASI\s*/i, '').replace(/\n/g, ' ');
      for (const token of plain.split(/\s+/).filter(token => token.length >= 5)) assert.ok(text.includes(token), `missing description token ${token}`);
    }
    // pdftotext places the renderer's status suffix between wrapped
    // description lines, so assert the complete source vocabulary exactly once
    // rather than requiring a visual line boundary or suffix placement.
    assert.equal(count(text, /pengguna\./g), 2);
    assert.equal(count(text, /Tahun/g), 1);
    assert.equal(count(text, /eksekusi\./g), 3);
    assert.equal(count(text, /mengikuti/g), 1);
    assert.equal(count(text, /Konsumsi/g), 1);
    assert.equal(count(text, /Pengaju: akun/g), 1);
    const descriptionWords = wordsInBbox(bbox, ['pengguna.', 'Tahun', 'eksekusi.', 'Konsumsi', 'Pengaju:', type]);
    assert.ok(descriptionWords.length >= 8, 'expected description glyph boxes');
    for (const word of descriptionWords) {
      assert.ok(word.xMin >= 115.5, `${word.value} begins outside description column: ${word.xMin}`);
      assert.ok(word.xMax <= rightEdge + 0.6, `${word.value} exceeds description column: ${word.xMax} > ${rightEdge}`);
    }
    assert.deepEqual(overlappingDescriptionGlyphs(bbox, rightEdge), [], 'description baselines must not collide with the next wrapped line or row boundary');
    assert.match(text, /Lampiran/);
  });
}

test('petty_cash and finance_request retain huge descriptions across pages with links, complete text, and stable headers', async () => {
  const huge = `SIMULASI HUGE-DESCRIPTION-START ${'verylongidentifier_'.repeat(420)} HUGE-DESCRIPTION-END`;
  for (const type of ['petty_cash', 'finance_request']) {
    const bytes = await render(type, [huge], { maxPages: 150 });
    const { text, bbox } = await pdfText(bytes, `${type}-huge.pdf`);
    assert.ok(pageCountFromBbox(bbox) > 1, `${type} oversized description should split across pages`);
    assert.match(text, /HUGE-DESCRIPTION-START/);
    assert.match(text, /HUGE-DESCRIPTION-END/);
    assert.equal(count(text, /DATA DEMO/g), 1);
    assert.equal(count(text, /Fixture wrap regression/g), 1);
    assert.match(text, /Lampiran/);
    assert.ok(!text.includes('Akun Demo'), 'applicant suffix must not be printed');
  }
});
