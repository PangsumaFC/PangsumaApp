import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/report-evidence.js', import.meta.url), 'utf8');

test('receipt picker is an explicit gallery control without forced camera capture', () => {
  assert.match(source, /class="receipt-file-label" for="receipt-file-\$\{esc\(submission\.id\)\}"/);
  assert.match(source, /type="file" accept="image\/jpeg,image\/png,image\/webp"/);
  assert.doesNotMatch(source, /capture="environment"/);
  assert.match(source, /ctx\.input\.disabled = true/);
});

test('generic Android MIME is sniffed from bounded JPEG/PNG signatures', async () => {
  const sandbox = { console, URL, crypto: globalThis.crypto, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  sandbox.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  sandbox.document = { createElement() { return { width: 0, height: 0, getContext() { return { fillStyle: '', fillRect() {}, drawImage() {} }; }, toBlob(callback) { callback({ size: 1, arrayBuffer: async () => new ArrayBuffer(1) }); } }; } };
  vm.runInNewContext(source, sandbox);
  const evidence = sandbox.ReportEvidence;
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x00]);
  const file = { name: 'camera-file', type: '', size: bytes.length, slice() { return { arrayBuffer: async () => bytes.buffer }; } };
  const prepared = await evidence.normalizeImage(file);
  assert.equal(prepared.mimeType, 'image/jpeg');
  assert.equal(prepared.filename, 'camera-file.jpg');
});

test('decoder fallback uses FileReader data URLs and does not create blob URLs', () => {
  assert.match(source, /reader\.readAsDataURL\(file\)/);
  assert.doesNotMatch(source, /const url = URL\.createObjectURL\(file\), img/);
});

test('compression retries reuse one decoded image and close it in finally', () => {
  assert.match(source, /try \{\s*blob = await canvasBlob\(image/);
  assert.match(source, /finally \{ image\.close\?\.\(\); \}/);
  assert.doesNotMatch(source, /canvasBlob\(await imageDecoder\(file\)/);
});

test('gallery bitmap failure falls back to a validated data image with normalized MIME', async () => {
  let decoded = 0, mime = '';
  const sandbox = { URL, Uint8Array, setTimeout, clearTimeout,
    createImageBitmap: async file => { mime = file.type; throw new Error('provider bitmap unavailable'); },
    FileReader: class { readAsDataURL() { this.result = 'data:image/png;base64,fixture'; this.onload(); } },
    Image: class { width = 2; height = 1; async decode() { decoded++; } },
    document: { createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: fn => fn(new Blob(['normalized'])) }) }
  };
  vm.runInNewContext(source, sandbox);
  const file = new Blob([Uint8Array.from([137,80,78,71,13,10,26,10])], { type: 'application/octet-stream' });
  const prepared = await sandbox.ReportEvidence.normalizeImage(file);
  assert.equal(mime, 'image/png'); assert.equal(decoded, 1); assert.equal(prepared.mimeType, 'image/png');
});
