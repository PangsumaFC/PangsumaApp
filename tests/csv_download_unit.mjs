import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function downloadCsv(button) {');
const end = source.indexOf('\nasync function loadMoreHistory', start);
assert.ok(start >= 0 && end > start);
function harness(userAgent, { role = 'manager', status = 200 } = {}) {
  const calls = { fetch: 0, downloads: [], toasts: [], revoked: [] };
  const context = vm.createContext({
    state: { user: { role } }, authEpoch: 1,
    navigator: { userAgent, maxTouchPoints: 5 },
    todayISO: () => '2026-10-18',
    document: {
      body: { append() {} },
      createElement() { return { click() { calls.downloads.push({ href: this.href, download: this.download }); }, remove() {} }; }
    },
    window: { setTimeout: callback => callback() },
    URL: { createObjectURL: () => 'blob:local-csv', revokeObjectURL: url => calls.revoked.push(url) },
    fetch: async () => {
      calls.fetch++;
      return { ok: status === 200, status, headers: new Headers({ 'Content-Disposition': 'attachment; filename="complete.csv"' }),
        blob: async () => new Blob(['local']), json: async () => ({ error: { code: 'forbidden', message: 'Manager only' } }) };
    },
    ApiFailure: class extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } },
    setButtonBusy() {}, showToast: text => calls.toasts.push(text), friendlyError: error => error.message
  });
  vm.runInContext(source.slice(start, end), context);
  return { calls, download: () => context.downloadCsv({ isConnected: true }) };
}
for (const [name, ua] of [
  ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'],
  ['iPadOS desktop-mode', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15']
]) {
  test(`${name} uses a native attachment link synchronously without an awaited Blob fetch`, async () => {
    const h = harness(ua);
    const pending = h.download();
    assert.deepEqual(h.calls.downloads, [{ href: '/api/export.csv', download: 'pangsuma-rekap-lengkap-2026-10-18.csv' }]);
    assert.equal(h.calls.fetch, 0);
    await pending;
  });
}
test('Android WebView uses native attachment navigation instead of a blob URL', async () => {
  const h = harness('Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A.231005.007; wv) AppleWebKit/537.36 Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36');
  const pending = h.download();
  assert.deepEqual(h.calls.downloads, [{ href: '/api/export.csv', download: 'pangsuma-rekap-lengkap-2026-10-18.csv' }]);
  assert.equal(h.calls.fetch, 0);
  await pending;
});
test('Android retains its complete Blob download and server-provided filename', async () => {
  const h = harness('Mozilla/5.0 (Linux; Android 14) Chrome/130.0');
  await h.download();
  assert.equal(h.calls.fetch, 1);
  assert.deepEqual(h.calls.downloads, [{ href: 'blob:local-csv', download: 'complete.csv' }]);
  assert.deepEqual(h.calls.revoked, ['blob:local-csv']);
});
test('a non-Manager cannot start either download path', async () => {
  const h = harness('iPhone', { role: 'user' });
  await h.download();
  assert.equal(h.calls.fetch, 0);
  assert.deepEqual(h.calls.downloads, []);
});
test('failed desktop exports remain errors, not false download successes', async () => {
  const h = harness('Chrome', { status: 403 });
  await h.download();
  assert.deepEqual(h.calls.downloads, []);
  assert.deepEqual(h.calls.toasts, ['Manager only']);
});
