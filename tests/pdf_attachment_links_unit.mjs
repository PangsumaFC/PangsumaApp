import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { buildFinancialReport } from '../functions/_lib/pdf-report.js';

const execFileAsync = promisify(execFile);
const DEMO_URL = 'https://www.dropbox.com/scl/fi/DEMOFILE/bukti-demo.jpg?rlkey=demo-share-key&dl=0';
const longDescription = `LONG-START ${'deskripsi bukti yang sengaja panjang untuk memaksa pemisahan baris dan halaman '.repeat(55)} LONG-END`;

function row(id, overrides = {}) {
  return {
    id,
    direction: id % 2 ? 'in' : 'out',
    amount_idr: 100_000 + id,
    balance_after_idr: id % 2 ? 100_000 + id : -100_000 - id,
    created_at: `2026-10-${String(Math.min(id, 28)).padStart(2, '0')}T03:00:00.000Z`,
    description: `DATA-ROW-${id}`,
    request_number: `PC112026${String(id).padStart(6, '0')}`,
    ...overrides,
  };
}

async function inspect(bytes, name = 'attachment-links.pdf') {
  const dir = await mkdtemp(join(tmpdir(), 'pangsuma-attachment-links-'));
  const path = join(dir, name);
  try {
    await writeFile(path, bytes);
    const [{ stdout: text }, { stdout: bbox }] = await Promise.all([
      execFileAsync('pdftotext', ['-layout', path, '-'], { maxBuffer: 32 * 1024 * 1024 }),
      execFileAsync('pdftotext', ['-bbox', path, '-'], { maxBuffer: 32 * 1024 * 1024 }),
    ]);
    const pdf = await PDFDocument.load(bytes);
    return { pdf, text, bbox };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function annotationEntries(pdf) {
  return pdf.getPages().flatMap((page, pageIndex) => {
    const annots = page.node.Annots();
    if (!annots) return [];
    return annots.asArray().map((ref) => {
      const annotation = pdf.context.lookup(ref, PDFDict);
      const action = annotation.lookup(PDFName.of('A'), PDFDict);
      const uri = action?.lookup(PDFName.of('URI'));
      const rect = annotation.lookup(PDFName.of('Rect'))?.asArray().map((n) => n.numberValue);
      const contents = annotation.lookup(PDFName.of('Contents'));
      return { page, pageIndex, annotation, action, uri: uri?.decodeText?.() ?? String(uri ?? ''), contents: contents?.decodeText?.() ?? String(contents ?? ''), rect };
    });
  });
}

function pageStream(pdf, page) {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFRawStream
    ? [contents]
    : contents?.asArray?.().map((ref) => pdf.context.lookup(ref)).filter(Boolean) || [];
  return streams.map((stream) => {
    try { return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'); }
    catch { return Buffer.from(stream.getContents()).toString('latin1'); }
  }).join('\n');
}

function imageCount(pdf, page) {
  const resources = page.node.Resources();
  const xObject = resources?.lookup(PDFName.of('XObject'), PDFDict);
  if (!xObject) return 0;
  return xObject.entries().filter(([, ref]) => {
    const object = pdf.context.lookup(ref);
    return object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image';
  }).length;
}

function bboxWords(bbox) {
  return [...bbox.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g)]
    .map((m) => ({ x: +m[1], y: +m[2], right: +m[3], bottom: +m[4], word: m[5] }));
}

const base = {
  snapshotAt: '2026-10-18T12:00:00.000Z',
  managerName: 'Manager Test',
  ledger: [
    row(1, { description: 'VALID LEDGER RECEIPT', dropbox_receipt_url: DEMO_URL }),
    row(2, { description: 'PUBLIC FOLDER MUST NOT BE ATTACHED', dropbox_receipt_url: 'https://www.dropbox.com/scl/fo/abc123/public-folder' }),
    row(3, { description: 'INVALID HOST MUST NOT BE ATTACHED', dropbox_receipt_url: 'https://evil.example/home/secret.pdf' }),
    row(4, { description: 'HTTP USERINFO TOKEN MUST NOT BE ATTACHED', dropbox_receipt_url: 'http://user:pass@www.dropbox.com/home/private.pdf' }),
    row(5, { description: longDescription, submission_id: 'linked-submission' }),
  ],
  submissions: [
    { id: 'linked-submission', type: 'finance_request', status: 'approved', date: '2026-10-05', amount_idr: 505, description: longDescription, dropbox_receipt_url: DEMO_URL },
    { id: 'standalone-submission', type: 'petty_cash', status: 'approved', date: '2026-10-06', amount_idr: 606, description: 'STANDALONE ELIGIBLE RECEIPT', dropbox_receipt_url: DEMO_URL },
    { id: 'unattached-ineligible', type: 'finance_request', status: 'pending', date: '2026-10-07', amount_idr: 707, description: 'INELIGIBLE MUST NOT INVENT OR ATTACH', dropbox_receipt_url: DEMO_URL },
  ],
};

test('Dropbox shared-file receipt links are exact URI annotations with provenance and no invented links', async () => {
  const { pdf, text, bbox } = await inspect(await buildFinancialReport({ ...base, reportType: 'finance_request' }));
  const links = annotationEntries(pdf);
  const streams = pdf.getPages().map((page) => pageStream(pdf, page)).join('\n');
  assert.equal(links.length, 3, 'ledger, linked submission, and standalone eligible submission each get one link');
  assert.deepEqual(links.map((link) => link.uri), [DEMO_URL, DEMO_URL, DEMO_URL]);
  assert.deepEqual(links.map((link) => link.contents), [
    'Lampiran baris 1, berkas 1', 'Lampiran baris 5, berkas 1', 'Lampiran baris 6, berkas 1',
  ], 'link accessibility context identifies the rendered row and file');
  assert.match(streams, /0\.05 0\.25 0\.75 rg/, 'visible attachment labels use the PDF blue link color');
  assert.equal(new Set(links.map((link) => link.rect.join(','))).size, 3, 'long-row split must not duplicate annotation');
  for (const link of links) {
    assert.ok(link.rect, 'annotation has a rectangle');
    const [x1, y1, x2, y2] = link.rect;
    assert.ok(x1 >= 446 && x2 <= 565 && x2 > x1, `Rect must stay inside Lampiran column: ${link.rect}`);
    assert.ok(y1 > 38 && y2 > y1 && y2 < 810, `Rect must be content-row, not footer: ${link.rect}`);
    assert.equal(link.annotation.get(PDFName.of('Subtype'))?.toString(), '/Link');
  }
  assert.equal((text.match(/Lampiran/g) || []).length, 2, 'header plus the unnumbered fallback attachment label');
  assert.match(text, /VALID LEDGER RECEIPT/);
  assert.match(text, /LONG-START/);
  assert.match(text, /STANDALONE ELIGIBLE RECEIPT/);
  assert.match(text, /PC112026000001/);
  assert.match(text, /PC112026000005/);
  assert.doesNotMatch(text, /PUBLIC FOLDER MUST NOT BE ATTACHED/);
  assert.doesNotMatch(text, /INELIGIBLE MUST NOT INVENT OR ATTACH/);
  const words = bboxWords(bbox);
  for (const word of words.filter((entry) => entry.word === 'Lampiran')) {
    if (word.x > 440) assert.ok(word.x >= 446 && word.right <= 565, `Lampiran text must be in Lampiran column: ${JSON.stringify(word)}`);
  }
});

test('attachment policy accepts shared files but rejects folders, unsafe public paths, other hosts, schemes, userinfo, and credentials', async () => {
  const invalid = [
    'https://www.dropbox.com/scl/fo/abc/public-folder',
    'https://www.dropbox.com/sh/abc/public-folder',
    'https://www.dropbox.com/scl/fi/abc',
    'https://www.dropbox.com/s/abc',
    'https://dropboxusercontent.com/home/private.pdf',
    'https://www.dropbox.com.evil.example/home/private.pdf',
    'http://www.dropbox.com/home/private.pdf',
    'javascript:https://www.dropbox.com/home/private.pdf',
    'https://user:pass@www.dropbox.com/home/private.pdf',
    'https://www.dropbox.com/home/private.pdf?token=secret',
  ];
  const { pdf, text } = await inspect(await buildFinancialReport({
    snapshotAt: base.snapshotAt,
    ledger: invalid.map((url, index) => row(index + 1, { description: `INVALID-${index}`, dropbox_receipt_url: url })),
    submissions: [],
  }), 'invalid-links.pdf');
  assert.equal(annotationEntries(pdf).length, 0);
  assert.equal((text.match(/Lampiran/g) || []).length, 1, 'invalid links leave only the table header');
});

test('wide table boundaries, one grand total, no page subtotals, and final-only approval assets remain stable', async () => {
  const ledger = Array.from({ length: 88 }, (_, index) => row(index + 1, {
    description: index === 0 ? 'SINGLE DEMO ROW SENTINEL' : `PAGED-ROW-${index + 1}`,
    dropbox_receipt_url: index === 0 ? DEMO_URL : undefined,
  }));
  const { pdf, text } = await inspect(await buildFinancialReport({ ...base, ledger, submissions: [] }), 'multipage-links.pdf');
  assert.ok(pdf.getPageCount() > 2);
  assert.equal((text.match(/Subtotal halaman/g) || []).length, 0);
  assert.equal((text.match(/Total kas keseluruhan/g) || []).length, 1);
  assert.equal((text.match(/DATA DEMO/g) || []).length, 1);
  assert.equal((text.match(/Lampiran/g) || []).length, 1, 'canonical numbered attachment does not repeat Lampiran');
  assert.match(text, /Lampiran/);
  const headers = text.split(/\f/).filter(Boolean).filter((page) => /Lampiran/.test(page));
  assert.equal(headers.length, 1, 'Lampiran header appears only on page one');
  assert.equal((text.match(/Yang mengajukan,/g) || []).length, 1);
  assert.equal((text.match(/Rahmat Saputro/g) || []).length, 1);
  assert.equal((text.match(/(?:^|\n)\s*Manager\s*(?:\n|$)/g) || []).length, 1);
  const imagePages = pdf.getPages().map((page, index) => ({ index, count: imageCount(pdf, page) })).filter((entry) => entry.count);
  assert.equal(imagePages.length, 1);
  assert.equal(imagePages[0].index, pdf.getPageCount() - 1);
  assert.equal(imagePages[0].count, 2);
  const streams = pdf.getPages().map((page) => pageStream(pdf, page)).join('\n');
  for (const x of [30, 54, 112, 206, 326, 380, 434, 488, 565]) {
    assert.match(streams, new RegExp(`(?:^|\\n| )${x}(?:\\.0+)? \\-?\\d+(?:\\.\\d+)? m`), `missing table boundary x=${x}`);
  }
});


test('multiple receipt arrays render distinct numbered links once per row and omit invalid entries', async () => {
  const urls = [
    'https://www.dropbox.com/scl/fi/FIRST/file-a.jpg?rlkey=a&dl=0',
    'https://www.dropbox.com/scl/fi/SECOND/file-b.jpg?rlkey=b&dl=0',
    'https://www.dropbox.com/scl/fi/THIRD/file-c.jpg?rlkey=c&dl=0',
  ];
  const { pdf, text } = await inspect(await buildFinancialReport({
    snapshotAt: base.snapshotAt,
    managerName: base.managerName,
    ledger: [row(1, {
      description: longDescription,
      dropbox_receipt_urls: [urls[0], 'https://evil.example/home/nope', urls[1], urls[0], urls[2], 'https://www.dropbox.com/scl/fo/folder'],
    })],
    submissions: [],
  }), 'multiple-links.pdf');
  const links = annotationEntries(pdf);
  assert.deepEqual(links.map((link) => link.uri), urls);
  assert.equal(links.length, urls.length, 'each deduplicated valid receipt gets one annotation, not a second transaction row');
  assert.equal((text.match(/Lampiran/g) || []).length, 1, 'canonical numbered attachments do not repeat Lampiran');
  assert.match(text, /LONG-START/);
  assert.match(text, /LONG-END/);
  assert.doesNotMatch(text, /nope|folder/);
  assert.equal(new Set(links.map((link) => link.rect.join(','))).size, 3, 'row split must not duplicate link annotations');
  assert.deepEqual(links.map((link) => link.contents), [
    'Lampiran baris 1, berkas 1', 'Lampiran baris 1, berkas 2', 'Lampiran baris 1, berkas 3',
  ]);
  for (const link of links) {
    const [x1, y1, x2, y2] = link.rect;
    assert.ok(x1 >= 446 && x2 <= 565.28 && y1 > 38 && y2 > y1);
  }
});

for (const reportType of ['petty_cash', 'finance_request']) {
  test(`${reportType}: identical Lampiran labels preserve each approved row and file viewer target`, async () => {
    const fileUrl = token => `https://www.dropbox.com/scl/fi/${token}/${token}.jpg?rlkey=${token}&dl=0`;
    const first = fileUrl('ROWONEFILEONE');
    const second = fileUrl('ROWONEFILETWO');
    const third = fileUrl('ROWTWOFILEONE');
    const { pdf, text, bbox } = await inspect(await buildFinancialReport({
      reportType,
      snapshotAt: base.snapshotAt,
      managerName: base.managerName,
      submissions: [
        { id: 'one', type: reportType, status: 'approved', date: '2026-10-01', created_at: '2026-10-01T03:00:00Z', amount_idr: 101, description: 'FIRSTROW', request_number: `${reportType === 'petty_cash' ? 'PC' : 'RF'}112026000001`, dropbox_receipt_urls: [first, 'https://www.dropbox.com/scl/fo/FOLDER', second] },
        { id: 'two', type: reportType, status: 'approved', date: '2026-10-02', created_at: '2026-10-02T03:00:00Z', amount_idr: 202, description: 'SECONDROW', request_number: `${reportType === 'petty_cash' ? 'PC' : 'RF'}112026000002`, dropbox_receipt_urls: [third, 'javascript:alert(1)'] },
      ],
      ledger: [],
    }));
    const links = annotationEntries(pdf);
    assert.deepEqual(links.map(link => link.uri), [first, second, third]);
    assert.deepEqual(links.map(link => link.contents), [
      'Lampiran baris 1, berkas 1', 'Lampiran baris 1, berkas 2', 'Lampiran baris 2, berkas 1',
    ]);
    assert.doesNotMatch(text, /Bukti\s*\d|ROWONEFILE|ROWTWOFILE|\.jpg|berkas \d/);
    assert.equal((text.match(/Lampiran/g) || []).length, 1, 'header only when all attachments are numbered');
    const words = bboxWords(bbox);
    for (const [index, sentinel] of ['FIRSTROW', 'FIRSTROW', 'SECONDROW'].entries()) {
      const rowWord = words.find(word => word.word === sentinel);
      assert.ok(rowWord, `${sentinel} must be visible`);
      const link = links[index];
      const lineTop = 841.89 - link.rect[3];
      assert.ok(Math.abs(lineTop - rowWord.y) < 24, `${link.uri} must remain aligned with ${sentinel}`);
      assert.equal(link.annotation.get(PDFName.of('Subtype'))?.toString(), '/Link');
    }
    const streams = pdf.getPages().map(page => pageStream(pdf, page)).join('\n');
    assert.match(streams, /0\.05 0\.25 0\.75 rg/);
  });
}
