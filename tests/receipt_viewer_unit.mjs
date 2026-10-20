import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/report-evidence.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const png = new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function apiHarness(fetch) {
  const sandbox = { Headers, fetch, activeApiTransactions: 0, authEpoch: 1, state: { user: { id: 'manager', role: 'manager' } }, login: '' };
  sandbox.showLogin = message => { sandbox.login = message; sandbox.authEpoch++; sandbox.state.user = null; };
  vm.runInNewContext(app.slice(app.indexOf('class ApiFailure'), app.indexOf('function webAuthnBuffer')), sandbox);
  return sandbox;
}

test('photo API uses the same authenticated no-store request and returns exact bytes', async () => {
  let request;
  const s = apiHarness(async (url, options) => { request = { url, options }; return new Response(png); });
  const blob = await s.api('/receipts/staff-proof', { responseType: 'blob' });
  assert.equal(request.url, '/api/receipts/staff-proof');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(await png.arrayBuffer()));
});

test('expired photo API sends the user to login, never returns the error JSON as a photo', async () => {
  const s = apiHarness(async () => Response.json({ error: { code: 'authentication_required', message: 'Sesi berakhir.' } }, { status: 401 }));
  await assert.rejects(s.api('/receipts/staff-proof', { responseType: 'blob' }), error => error.code === 'session_changed');
  assert.match(s.login, /Sesi Anda berakhir/);
  assert.equal(s.state.user, null);
});

test('a photo body completing after logout or account change is discarded', async () => {
  const body = deferred();
  const s = apiHarness(async () => ({ ok: true, blob: () => body.promise }));
  const result = s.api('/receipts/staff-proof', { responseType: 'blob' });
  await tick(); s.authEpoch++; body.resolve(png);
  await assert.rejects(result, error => error.code === 'session_changed');
});

test('photo 403 remains forbidden without logging out a valid session', async () => {
  const s = apiHarness(async () => Response.json({ error: { code: 'forbidden', message: 'Tidak diizinkan.' } }, { status: 403 }));
  await assert.rejects(s.api('/receipts/staff-proof', { responseType: 'blob' }), error => error.status === 403);
  assert.equal(s.login, ''); assert.equal(s.state.user.id, 'manager');
});

class Element {
  constructor() { this.listeners = {}; this.hidden = false; this.isConnected = true; this.attributes = {}; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'src') delete this.src; }
  querySelector(selector) { return this.parts[selector]; }
  set innerHTML(value) { this.parts = Object.fromEntries(['.receipt-viewer-image', '.receipt-viewer-status', '.receipt-viewer-retry', '.receipt-viewer-close'].map(key => [key, new Element()])); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  remove() { this.isConnected = false; }
  focus() { this.focused = true; }
}
function viewerHarness(api) {
  const created = [], revoked = [], requests = [], dialogs = [];
  const ctx = { submission: { id: 'staff-request', createdById: 'staff' }, items: [{ url: '/api/receipts/staff-proof' }], cleaned: false };
  const s = { AbortController, ACCEPTED: new Set(['image/jpeg', 'image/png']), contexts: new Set([ctx]), owner: 'manager',
    currentOwnerId: () => s.owner, userCanSee: () => !!s.owner,
    receiptUrl: value => /^\/api\/receipts\/[a-zA-Z0-9-]+$/.test(value) ? value : '',
    apiCall: (path, options) => { requests.push({ path, options }); return api(path, options); },
    URL: { createObjectURL: blob => { created.push(blob); return 'blob:private-proof'; } },
    revoke: url => { if (url) revoked.push(url); },
    document: { createElement: () => new Element(), body: { appendChild: el => dialogs.push(el) } }
  };
  vm.runInNewContext(source.slice(source.indexOf('  function openReceipt('), source.indexOf('  function updateReceiptControls(')), s);
  const trigger = new Element();
  const open = (url = '/api/receipts/staff-proof') => s.openReceipt(ctx, url, trigger);
  return { s, ctx, open, created, revoked, requests, dialogs, trigger };
}

test('manager opens the same staff receipt in an app dialog and close revokes its private blob', async () => {
  const h = viewerHarness(async () => png); h.open(); await tick();
  assert.equal(h.requests[0].path, '/receipts/staff-proof');
  assert.equal(h.requests[0].options.responseType, 'blob');
  assert.equal(h.created[0], png);
  const dialog = h.ctx.viewer.dialog;
  assert.equal(dialog.querySelector('.receipt-viewer-image').src, 'blob:private-proof');
  h.ctx.viewer.close();
  assert.deepEqual(h.revoked, ['blob:private-proof']); assert.equal(h.ctx.viewer, null);
  assert.equal(h.requests[0].options.signal.aborted, true); assert.equal(h.trigger.focused, true);
});

test('viewer rejects external, malicious and unrelated receipt URLs before requesting bytes', async () => {
  const h = viewerHarness(async () => png);
  for (const url of ['https://dropbox.com/private', 'javascript:alert(1)', '/api/receipts/not-listed', '/api/receipts/staff-proof?token=secret']) h.open(url);
  assert.equal(h.requests.length, 0); assert.equal(h.dialogs.length, 0);
});

test('delayed photo cannot appear after detail cleanup, logout or viewer close', async () => {
  for (const mode of ['cleanup', 'logout', 'close']) {
    const pending = deferred(), h = viewerHarness(() => pending.promise); h.open();
    if (mode === 'cleanup') { h.ctx.cleaned = true; h.ctx.viewer.close(); }
    if (mode === 'logout') h.s.owner = '';
    if (mode === 'close') h.ctx.viewer.close();
    pending.resolve(png); await tick();
    assert.equal(h.created.length, 0, mode); assert.equal(h.ctx.viewer, null, mode);
  }
});

test('expired and denied photos have clear safe errors with no image or automatic retry', async () => {
  for (const status of [401, 403]) {
    const h = viewerHarness(async () => { throw Object.assign(new Error('raw secret JSON'), { status }); });
    h.open(); await tick(); const dialog = h.ctx.viewer.dialog;
    assert.match(dialog.querySelector('.receipt-viewer-status').textContent, status === 401 ? /Sesi berakhir/ : /tidak memiliki akses/);
    assert.equal(dialog.querySelector('.receipt-viewer-retry').hidden, true);
    assert.equal(h.created.length, 0);
  }
});

test('network and non-image responses stay in-app and can be retried safely', async () => {
  for (const invalid of [null, new Blob(['{"error":"authentication_required"}'], { type: 'application/json' })]) {
    let calls = 0;
    const h = viewerHarness(async () => { calls++; if (calls === 1) { if (invalid) return invalid; throw new Error('network'); } return png; });
    h.open(); await tick(); const dialog = h.ctx.viewer.dialog;
    assert.equal(h.created.length, 0); assert.equal(dialog.querySelector('.receipt-viewer-retry').hidden, false);
    await dialog.querySelector('.receipt-viewer-retry').listeners.click();
    assert.equal(h.created.length, 1);
  }
});

test('receipt UI never navigates an authenticated endpoint into a new browser tab', () => {
  assert.match(source, /class="receipt-open" data-receipt-url=/);
  assert.doesNotMatch(source, /target="_blank"/);
  assert.match(source, /ctx\.viewer\?\.close\(\)/);
});
