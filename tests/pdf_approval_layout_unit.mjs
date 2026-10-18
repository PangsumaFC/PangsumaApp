import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { decode as decodePng } from 'fast-png';
import { PDFDocument, PDFDict, PDFName, PDFRawStream } from 'pdf-lib';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';
import { managerSignaturePng, managerStampPng } from '../functions/_lib/pdf-approval-assets.js';

const execFileAsync = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname;
const signatureFile = join(ROOT, 'site/pdf-assets/manager-signature.jpg');
const stampFile = join(ROOT, 'site/pdf-assets/manager-stamp.jpg');
const signaturePngFile = join(ROOT, 'site/pdf-assets/manager-signature.png');
const stampPngFile = join(ROOT, 'site/pdf-assets/manager-stamp.png');
const SNAPSHOT = '2026-10-18T12:00:00.000Z';
const execOptions = { maxBuffer: 16 * 1024 * 1024 };

async function withPdf(label, data, inspect = false) {
  const dir = await mkdtemp(join(tmpdir(), `pangsuma-approval-${label}-`));
  const pdfPath = join(dir, 'report.pdf');
  try {
    const bytes = await buildFinancialReport({ snapshotAt: SNAPSHOT, ...data });
    await writeFile(pdfPath, bytes);
    if (process.env.PANGSUMA_PDF_EVIDENCE_DIR) {
      const evidence = process.env.PANGSUMA_PDF_EVIDENCE_DIR;
      await mkdir(evidence, { recursive: true });
      await copyFile(pdfPath, join(evidence, `${label}-${process.pid}-${Date.now()}.pdf`));
    }
    const pdf = await PDFDocument.load(bytes);
    const { stdout: text } = await execFileAsync('pdftotext', ['-layout', pdfPath, '-'], execOptions);
    const { stdout: bbox } = await execFileAsync('pdftotext', ['-bbox', pdfPath, '-'], execOptions);
    return { bytes, pdf, text, bbox, dir, pdfPath };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function pageText(text) {
  return text.split(/\f/).map(s => s.replace(/\s+$/g, '')).filter((s, i, a) => i < a.length - 1 || s);
}
function bboxPages(bbox) {
  return [...bbox.matchAll(/<page[^>]*>([\s\S]*?)<\/page>/g)].map(m => [...m[1].matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g)].map(w => ({ x: +w[1], y: +w[2], right: +w[3], bottom: +w[4], word: w[5] })));
}
function streamBytes(pdf, page) {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFRawStream ? [contents] : contents?.array?.map(ref => pdf.context.lookup(ref)).filter(Boolean) || [];
  return streams.map(stream => {
    const raw = stream.getContents();
    try { return inflateSync(raw).toString('latin1'); } catch { return Buffer.from(raw).toString('latin1'); }
  }).join('\n');
}
function imageEntries(pdf, page) {
  const resources = page.node.Resources();
  const xObject = resources?.lookup(PDFName.of('XObject'), PDFDict);
  if (!xObject) return [];
  return xObject.entries().flatMap(([name, ref]) => {
    const object = pdf.context.lookup(ref);
    if (!(object instanceof PDFRawStream)) return [];
    const subtype = object.dict.get(PDFName.of('Subtype'));
    return subtype?.toString() === '/Image' ? [{ name: name.toString(), object }] : [];
  });
}
function imageDraws(pdf, page) {
  const source = streamBytes(pdf, page);
  const tokens = source.match(/\/[^^\s]+|[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?|[A-Za-z*]+/g) || [];
  const identity = [1, 0, 0, 1, 0, 0];
  const multiply = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const point = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const draws = []; let ctm = identity; const stack = []; let operands = [];
  // Parse image invocations while applying all preceding cm transforms.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^[+-]?(?:\d*\.)?\d/.test(token)) { operands.push(+token); continue; }
    if (token === 'q') { stack.push(ctm); operands = []; continue; }
    if (token === 'Q') { ctm = stack.pop() || identity; operands = []; continue; }
    if (token === 'cm') { if (operands.length >= 6) ctm = multiply(ctm, operands.slice(-6)); operands = []; continue; }
    if (token === 'Do' && i > 0 && tokens[i - 1].startsWith('/')) {
      const corners = [point(ctm, 0, 0), point(ctm, 1, 0), point(ctm, 0, 1), point(ctm, 1, 1)];
      draws.push({ x: Math.min(...corners.map(p => p[0])), y: Math.min(...corners.map(p => p[1])), w: Math.max(...corners.map(p => p[0])) - Math.min(...corners.map(p => p[0])), h: Math.max(...corners.map(p => p[1])) - Math.min(...corners.map(p => p[1])), name: tokens[i - 1] });
      operands = []; continue;
    }
    if (token.startsWith('/')) { operands.push(token); continue; }
    operands = [];
  }
  return draws;
}
function pdfYFromBbox(word) { return 841.89 - word.bottom; }
function ledgerRows(count, long = false) {
  let balance = 0n;
  return Array.from({ length: count }, (_, i) => {
    const incoming = i % 2 === 0;
    const amount = BigInt(i + 1) * 125000n;
    balance += incoming ? amount : -amount;
    return {
      id: i + 1, direction: incoming ? 'in' : 'out', amount_idr: amount,
      balance_after_idr: balance, created_at: `2026-10-${String((i % 27) + 1).padStart(2, '0')}T03:00:00.000Z`,
      description: long ? `LONG-START-${i} ${'deskripsi yang sengaja sangat panjang untuk memaksa pemisahan halaman '.repeat(35)}LONG-END-${i}` : `Transaksi ledger ${i + 1}`,
    };
  });
}
function assertApprovalContract(result, { expectPages = null } = {}) {
  const pages = pageText(result.text);
  const bbox = bboxPages(result.bbox);
  assert.equal(pages.length, result.pdf.getPageCount(), 'pdftotext page count must match pdf-lib');
  if (expectPages) assert.equal(pages.length, expectPages);
  assert.equal((result.text.match(/Yg mengajukan,/g) || []).length, 1);
  assert.equal((result.text.match(/Rahmat Saputro/g) || []).length, 1);
  assert.equal((result.text.match(/(?:^|\n)\s*Manager\s*(?:\n|$)/g) || []).length, 1);
  assert.equal((result.text.match(/DATA DEMO/g) || []).length, 1);
  assert.doesNotMatch(result.text, /Subtotal halaman/);
  const approvalStart = result.text.indexOf('Yg mengajukan,');
  const nameStart = result.text.indexOf('Rahmat Saputro', approvalStart);
  const order = [approvalStart, nameStart, result.text.indexOf('Manager', nameStart), result.text.indexOf('DATA DEMO', nameStart)];
  assert.ok(order.every(i => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), `approval text order: ${order}`);
  assert.match(pages[0], /PANGSUMA FC/);
  for (const continuation of pages.slice(1)) assert.doesNotMatch(continuation, /PANGSUMA FC|Laporan Petty Cash|Tanggal cetak/);
  const imagePages = result.pdf.getPages().map((page, i) => ({ i, count: imageEntries(result.pdf, page).length })).filter(x => x.count);
  assert.equal(imagePages.length, 1, 'approval PNGs must be present on one page only');
  assert.equal(imagePages[0].i, result.pdf.getPageCount() - 1, 'approval PNGs must be on final page');
  assert.equal(imagePages[0].count, 2, 'final page must have signature and stamp PNG XObjects');
  const finalIndex = result.pdf.getPageCount() - 1;
  const finalDraws = imageDraws(result.pdf, result.pdf.getPages()[finalIndex]);
  assert.equal(finalDraws.length, 2, 'both final-page PNGs must have observable Do transforms');
  for (const draw of finalDraws) assert.ok(draw.x > 300 && draw.y >= 38 && draw.y + draw.h <= 820, `approval image outside right-side block: ${JSON.stringify(draw)}`);
  const finalWords = bbox[finalIndex];
  const approvalLabel = finalWords.find(w => w.word.includes('Yg'));
  assert.ok(approvalLabel, 'approval label must have a final-page bbox');
  assert.ok(finalWords.some(w => w.word.includes('Rahmat')), 'signature name must have a final-page bbox');
  assert.ok(finalWords.some(w => w.word === 'Manager'), 'manager role must have a final-page bbox');
  assert.ok(finalWords.some(w => w.word.includes('DATA')), 'demo marker must have a final-page bbox');
  const total = finalWords.find(w => w.word === 'keseluruhan');
  if (total) {
    const gap = (pdfYFromBbox(total) - 8) - pdfYFromBbox(approvalLabel);
    assert.ok(gap >= 8 && gap <= 24, `approval label must follow totals by 12–18pt (observed ${gap.toFixed(2)}pt)`);
  }
  if (result.text.includes('Keterangan')) {
    const grid = result.pdf.getPages().map(page => streamBytes(result.pdf, page)).join('\n');
    for (const x of [30, 54, 112, 260, 336, 412, 498, 565]) assert.match(grid, new RegExp(`(?:^|\\n| )${x}(?:\\.0+)? \\-?\\d+(?:\\.\\d+)? m`), `grid boundary x=${x}`);
    assert.match(grid, /0\.4 w/);
  }
}

const twoRows = ledgerRows(2);

test('one-page approval has exact text, final-only assets, and thin grid', async () => {
  const result = await withPdf('one-page', { ledger: twoRows, submissions: [] });
  assertApprovalContract(result, { expectPages: 1 });
  assert.equal(result.pdf.getTitle(), 'Laporan Petty Cash');
  assert.equal((result.text.match(/Laporan Petty Cash/g) || []).length, 1);
  assert.match(result.text, /Masuk/);
  assert.match(result.text, /Keluar/);
  assert.match(result.text, /Total kas keseluruhan/);
  const images = imageEntries(result.pdf, result.pdf.getPages()[0]);
  assert.equal(images.length, 2);
});

test('empty report still has one final approval block and no table-grid requirement', async () => {
  const result = await withPdf('empty', { ledger: [], submissions: [] });
  assertApprovalContract(result, { expectPages: 1 });
  assert.match(result.text, /Tidak ada transaksi pada filter ini\./);
  assert.equal((result.text.match(/DATA DEMO/g) || []).length, 1);
  assert.doesNotMatch(result.text, /Subtotal halaman/);
});

test('embedded PNG bytes preserve source pixels, alpha masks, and dimensions', async () => {
  const result = await withPdf('assets', { ledger: twoRows });
  const sourceSig = await readFile(signatureFile);
  const sourceStamp = await readFile(stampFile);
  const sourceSigPng = await readFile(signaturePngFile);
  const sourceStampPng = await readFile(stampPngFile);
  assert.equal((await import('node:crypto')).createHash('sha256').update(sourceSig).digest('hex'), '263a07dca3073b5143674e2cd448288100b27178eebe61ec429b7902b4923f65');
  assert.equal((await import('node:crypto')).createHash('sha256').update(sourceStamp).digest('hex'), '96e83ed1a1aa3bc38297d96822b78d93c1707100bb8b452e7868cb35e51a1c09');
  assert.deepEqual(Buffer.from(managerSignaturePng), sourceSigPng);
  assert.deepEqual(Buffer.from(managerStampPng), sourceStampPng);
  const expected = [decodePng(sourceSigPng), decodePng(sourceStampPng)];
  for (const image of expected) {
    assert.equal(image.channels, 4);
    assert.equal(image.depth, 8);
    assert.ok(image.width > 0 && image.height > 0);
  }
  const images = imageEntries(result.pdf, result.pdf.getPages()[0]);
  const dimensions = images.map(({ object }) => [object.dict.get(PDFName.of('Width')).numberValue, object.dict.get(PDFName.of('Height')).numberValue]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(dimensions, [[1024, 1024], [1200, 396]]);
  assert.ok(images.every(({ object }) => object.dict.get(PDFName.of('Filter')).toString() === '/FlateDecode'));
  for (const { object } of images) {
    const width = object.dict.get(PDFName.of('Width')).numberValue;
    const height = object.dict.get(PDFName.of('Height')).numberValue;
    const smask = result.pdf.context.lookup(object.dict.get(PDFName.of('SMask')));
    assert.ok(smask instanceof PDFRawStream, 'each approval PNG must have an alpha SMask');
    assert.equal(smask.dict.get(PDFName.of('Width')).numberValue, width);
    assert.equal(smask.dict.get(PDFName.of('Height')).numberValue, height);
    const source = expected.find(image => image.width === width && image.height === height);
    assert.ok(source);
    const rgb = inflateSync(object.getContents());
    const alpha = inflateSync(smask.getContents());
    const expectedRgb = Buffer.alloc(width * height * 3);
    const expectedAlpha = Buffer.alloc(width * height);
    for (let i = 0; i < width * height; i++) {
      expectedRgb[i * 3] = source.data[i * 4];
      expectedRgb[i * 3 + 1] = source.data[i * 4 + 1];
      expectedRgb[i * 3 + 2] = source.data[i * 4 + 2];
      expectedAlpha[i] = source.data[i * 4 + 3];
    }
    assert.deepEqual(rgb, expectedRgb, 'PDF RGB pixels must exactly match source PNG RGB pixels');
    assert.deepEqual(alpha, expectedAlpha, 'PDF SMask pixels must exactly match source PNG alpha pixels');
    assert.equal(expectedAlpha[0], 0, 'transparent corner must remain transparent');
    assert.ok(expectedAlpha.some(value => value === 255), 'opaque ink pixels must remain opaque');
  }
});

test('multi-page 90-row ledger keeps header page one and approval on final page', async () => {
  const result = await withPdf('multi-90', { ledger: ledgerRows(90), submissions: [] });
  assert.ok(result.pdf.getPageCount() > 2);
  assertApprovalContract(result);
  assert.match(result.text, /LONG|Transaksi ledger 90/);
});

test('boundary row counts 15 through 22 keep final-only approval and valid page geometry', async () => {
  for (const count of [15, 16, 17, 18, 19, 20, 21, 22]) {
    const result = await withPdf(`boundary-${count}`, { ledger: ledgerRows(count), submissions: [] });
    assertApprovalContract(result);
    assert.ok(result.pdf.getPageCount() >= 1);
    const final = result.pdf.getPages().at(-1);
    for (const word of bboxPages(result.bbox).at(-1)) assert.ok(word.x >= 29 && word.right <= 566 && word.y >= 8 && word.bottom <= 837, `boundary ${count}: text outside page bounds`);
    assert.ok(imageDraws(result.pdf, final).every(draw => draw.x > 300 && draw.y >= 38), `boundary ${count}: final image not right-side`);
  }
});

test('long descriptions split across pages without duplicating approval or losing amounts', async () => {
  const result = await withPdf('long-description', { ledger: ledgerRows(2, true), submissions: [] });
  assert.ok(result.pdf.getPageCount() > 1);
  assertApprovalContract(result);
  assert.match(result.text, /LONG-START-0/);
  assert.match(result.text, /LONG-END-1/);
  assert.match(result.text, /Rp\s+125\.000/);
  assert.match(result.text, /-\s+Rp\s+250\.000/);
});

test('large positive, negative, and bigint amounts use id-ID grouping and right-aligned currency cells', async () => {
  const huge = 18014398509481983n;
  const result = await withPdf('large-values', { ledger: [
    { id: 1, direction: 'in', amount_idr: huge, balance_after_idr: huge, created_at: '2026-10-01T00:00:00Z', description: 'Positif bigint' },
    { id: 2, direction: 'out', amount_idr: huge, balance_after_idr: -huge, created_at: '2026-10-02T00:00:00Z', description: 'Negatif bigint' },
  ], openingBalanceIdr: 0n, closingBalanceIdr: -huge });
  assertApprovalContract(result);
  const grouped = 'Rp18.014.398.509.481.983';
  const signedGrouped = '-18.014.398.509.481.983';
  const words = bboxPages(result.bbox).flat();
  for (const [prefix, left, right] of [['Rp', 264, 332], ['Rp', 340, 408], ['Rp', 416, 494]]) {
    const prefixes = words.filter(w => w.word === prefix && w.x === left);
    assert.ok(prefixes.length, `currency prefix ${prefix} must start at x=${left}`);
    assert.ok(words.some(w => w.right >= right - 1 && w.right <= right + 1 && w.word === grouped.replace('Rp', '')), `grouped numeric amount must end at x=${right}`);
  }
  assert.ok(words.some(w => w.word === signedGrouped && w.right >= 493 && w.right <= 495), 'signed grouped numeric amount must end at the balance right edge');
  assert.ok(words.every(w => w.x >= 29 && w.right <= 566), 'currency text must remain inside page margins');
});
