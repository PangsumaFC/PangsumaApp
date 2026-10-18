import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function downloadPdf(button) {'); const helperStart = source.lastIndexOf('function isPangsumaApkWrapper()', start); const end = source.indexOf('\nasync function loadMoreHistory', start); assert.ok(helperStart >= 0 && start >= 0 && end > start);
function harness(userAgent, { role = 'manager', status = 200, pdfUrl = null, bridge = false, standalone = false, helper = true } = {}) {
  const calls = { fetch: 0, fetchUrls: [], downloads: [], toasts: [], revoked: [], apkStatuses: [], prepares: [] };
  const context = vm.createContext({
    state: { user: { role } }, authEpoch: 1,
    PwaFiles: { ...(helper ? { showApkDownloadStatus: options => { calls.apkStatuses.push(options); return Promise.resolve({ dialog: { id: 'pwaPdfApkDialog' } }); } } : {}), isAndroidWebView: () => bridge, prepare: options => { calls.prepares.push(options); return Promise.resolve(options); } },
    ManagerReportFilters: pdfUrl ? { pdfUrl: () => pdfUrl } : undefined,
    navigator: { userAgent, maxTouchPoints: 5 },
    todayISO: () => '2026-10-18',
    document: { body: { append() {} }, createElement() { return { isConnected: true, click() { calls.downloads.push({ href: this.href, download: this.download }); }, remove() {} }; } },
    window: { PangsumaFileBridge: bridge ? {} : undefined, matchMedia: () => ({ matches: standalone }), setTimeout: callback => callback() },
    URL: { createObjectURL: () => 'blob:local-pdf', revokeObjectURL: url => calls.revoked.push(url) },
    fetch: async url => { calls.fetch++; calls.fetchUrls.push(url); return { ok: status === 200, status, headers: new Headers({ 'Content-Disposition': 'attachment; filename="complete.pdf"' }), blob: async () => new Blob(['local']), json: async () => ({ error: { code: 'forbidden', message: 'Manager only' } }) }; },
    ApiFailure: class extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }, setButtonBusy() {}, showToast: text => calls.toasts.push(text), friendlyError: error => error.message
  });
  vm.runInContext(source.slice(helperStart, end), context); return { calls, download: () => context.downloadPdf({ isConnected: true }) };
}
for (const [name, ua] of [['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'], ['iPadOS desktop-mode', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15']]) test(`${name} uses a native attachment link synchronously without an awaited Blob fetch`, async () => { const h = harness(ua); const pending = h.download(); assert.deepEqual(h.calls.downloads, [{ href: '/api/export.pdf', download: 'pangsuma-laporan-keuangan-2026-10-18.pdf' }]); assert.equal(h.calls.fetch, 0); await pending; });

test('confirmed APK bridge shows status only, without fetch, browser handoff, popup, clipboard, or download', async () => { const h = harness('Android 14 Chrome/130', { bridge: true }); await h.download(); assert.equal(h.calls.apkStatuses.length, 1); assert.equal(h.calls.apkStatuses[0].isCurrent(), true); assert.equal(h.calls.fetch, 0); assert.deepEqual(h.calls.downloads, []); assert.deepEqual(h.calls.toasts, []); });
test('missing APK helper gives the same status as a toast and does not fall through', async () => { const h = harness('Android 14 Chrome/130', { bridge: true, helper: false }); await h.download(); assert.equal(h.calls.fetch, 0); assert.deepEqual(h.calls.downloads, []); assert.deepEqual(h.calls.toasts, ['Unduh PDF langsung memerlukan APK yang diperbarui.']); });
test('ordinary Android Chrome retains its complete Blob download and server filename', async () => { const h = harness('Mozilla/5.0 (Linux; Android 14) Chrome/130'); await h.download(); assert.equal(h.calls.fetch, 1); assert.deepEqual(h.calls.downloads, [{ href: 'blob:local-pdf', download: 'complete.pdf' }]); assert.deepEqual(h.calls.revoked, ['blob:local-pdf']); });
test('standalone PWA still prepares same-origin PDF without wrapper status', async () => { const h = harness('Mozilla/5.0 (Linux; Android 14) Chrome/130', { standalone: true }); await h.download(); assert.equal(h.calls.prepares.length, 1); assert.equal(h.calls.prepares[0].url, '/api/export.pdf'); assert.equal(h.calls.fetch, 0); assert.equal(h.calls.apkStatuses.length, 0); });
test('a non-Manager cannot start either download path', async () => { const h = harness('iPhone', { role: 'user', bridge: true }); await h.download(); assert.equal(h.calls.fetch, 0); assert.deepEqual(h.calls.downloads, []); assert.equal(h.calls.apkStatuses.length, 0); });
test('failed desktop exports remain errors, not false download successes', async () => { const h = harness('Chrome', { status: 403 }); await h.download(); assert.deepEqual(h.calls.downloads, []); assert.deepEqual(h.calls.toasts, ['Manager only']); });
for (const [name, userAgent, native] of [['iPhone', 'iPhone AppleWebKit', true], ['Android Chrome', 'Android 14 Chrome/130', false]]) test(`${name} downloads exactly the applied server-side filters`, async () => { const pdfUrl = '/api/export.pdf?periode=customWIB&start=2026-10-01&end=2026-10-18&jenis=petty_cash&status=approved&q=Latihan'; const h = harness(userAgent, { pdfUrl }); await h.download(); if (native) assert.equal(h.calls.downloads[0].href, pdfUrl); else assert.deepEqual(h.calls.fetchUrls, [pdfUrl]); });
