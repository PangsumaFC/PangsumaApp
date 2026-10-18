import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const downloadSource = source.slice(source.indexOf('function isPangsumaApkWrapper() {'), source.indexOf('\nfunction configureBoundedHistory()', source.indexOf('async function downloadPdf(button) {')));
function downloadHarness({ standalone = false, iosStandalone = false, role = 'manager', helper = false } = {}) {
  const calls = { fetch: 0, downloads: [], toasts: [], prepared: [] };
  const context = vm.createContext({
    state: { user: { role } }, authEpoch: 1,
    PwaFiles: helper ? { prepare: options => { calls.prepared.push(options); } } : undefined,
    ManagerReportFilters: { pdfUrl: () => '/api/export.pdf?q=Latihan&jenis=petty_cash' },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36', standalone: iosStandalone },
    window: { matchMedia: query => ({ matches: standalone && query === '(display-mode: standalone)' }), setTimeout: fn => fn() },
    document: { body: { append() {} }, createElement: () => ({ click() { calls.downloads.push({ href: this.href, download: this.download }); }, remove() {} }) },
    todayISO: () => '2026-10-18',
    fetch: async () => { calls.fetch++; return { ok: true, headers: new Headers(), blob: async () => new Blob(['pdf']) }; },
    URL: { createObjectURL: () => 'blob:temporary', revokeObjectURL() {} },
    setButtonBusy() {}, showToast: message => calls.toasts.push(message), friendlyError: error => error.message,
  });
  vm.runInContext(downloadSource, context);
  return { calls, run: () => context.downloadPdf({ isConnected: true }) };
}
for (const options of [{ standalone: true }, { iosStandalone: true }]) {
  test(`PWA uses the same authenticated Blob download flow as a tab: ${JSON.stringify(options)}`, async () => {
    const h = downloadHarness(options);
    await h.run();
    assert.deepEqual(h.calls.downloads, [{ href: 'blob:temporary', download: 'pangsuma-laporan-petty-cash-2026-10-18.pdf' }]);
    assert.equal(h.calls.fetch, 1);
  });
}
test('regular Chrome tab retains authenticated blob flow', async () => {
  const h = downloadHarness(); await h.run();
  assert.equal(h.calls.fetch, 1);
  assert.equal(h.calls.downloads[0].href, 'blob:temporary');
});
test('installed PWA does not use a mode-only PDF dialog', async () => {
  const h = downloadHarness({ standalone: true, helper: true }); await h.run();
  assert.equal(h.calls.prepared.length, 0);
  assert.equal(h.calls.fetch, 1);
  assert.deepEqual(h.calls.downloads, [{ href: 'blob:temporary', download: 'pangsuma-laporan-petty-cash-2026-10-18.pdf' }]);
});
test('standalone User cannot request a Manager export', async () => {
  const h = downloadHarness({ standalone: true, role: 'user' }); await h.run();
  assert.equal(h.calls.fetch, 0); assert.deepEqual(h.calls.downloads, []);
});

const photoSource = source.slice(source.indexOf('function profilePhotoMime('), source.indexOf('\nasync function prepareProfilePhoto('));
function photoHarness() {
  const context = vm.createContext({ Uint8Array });
  vm.runInContext(photoSource, context);
  return context;
}
for (const [label, bytes, mime] of [
  ['JPEG', [255,216,255,224,0,16], 'image/jpeg'],
  ['PNG', [137,80,78,71,13,10,26,10], 'image/png'],
  ['WebP', [...Buffer.from('RIFF'), 16,0,0,0, ...Buffer.from('WEBPVP8 ')], 'image/webp'],
]) {
  test(`gallery ${label} without extension or MIME uses bounded signature detection`, async () => {
    const h = photoHarness();
    for (const type of ['', 'application/octet-stream', 'image/*']) {
      const file = new Blob([new Uint8Array(bytes)], { type });
      assert.equal(await h.resolveProfilePhotoMime(file), mime);
    }
  });
}
test('generic gallery MIME does not admit SVG or arbitrary bytes', async () => {
  const h = photoHarness();
  for (const value of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'not an image']) {
    assert.equal(await h.resolveProfilePhotoMime(new Blob([value], { type: 'application/octet-stream' })), 'application/octet-stream');
  }
});
test('explicit unsupported MIME stays unsupported even with JPEG-like bytes', async () => {
  const h = photoHarness();
  assert.equal(await h.resolveProfilePhotoMime(new Blob([new Uint8Array([255,216,255])], { type: 'image/svg+xml' })), 'image/svg+xml');
});
