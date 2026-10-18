import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { URL as NodeURL } from 'node:url';

const source = fs.readFileSync(new URL('../site/pwa-files.js', import.meta.url), 'utf8');

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = {}; this.hidden = false; this.className = ''; this.classList = { toggle: (name, on) => { this.attributes[`class:${name}`] = !!on; } }; }
  append(...items) { this.children.push(...items); for (const item of items) item.parentNode = this; }
  appendChild(item) { this.append(item); return item; }
  removeChild(item) { this.children = this.children.filter((child) => child !== item); item.parentNode = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = String(value); if (name === 'download') this.download = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  dispatch(name) { for (const fn of this.listeners[name] || []) fn({ preventDefault() {} }); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  query(selector) {
    const all = []; const visit = node => { for (const child of node.children || []) { all.push(child); visit(child); } }; visit(this);
    if (selector.startsWith('#')) return all.find(x => x.id === selector.slice(1));
    if (selector.startsWith('.')) return all.find(x => x.className === selector.slice(1));
    return null;
  }
}
class Document { constructor() { this.body = new Element('body'); this.activeElement = new Element('button'); } createElement(tag) { return new Element(tag); } }
function harness(response, extras = {}) {
  const document = new Document(); const revoked = []; const shared = []; let opens = 0; const copied = [];
  class BrowserURL extends NodeURL {}
  BrowserURL.createObjectURL = () => 'blob:test-pdf';
  BrowserURL.revokeObjectURL = url => revoked.push(url);
  const context = {
    window: null, document, location: { href: 'https://app.example.test/finance', origin: 'https://app.example.test' }, URL: BrowserURL,
    AbortController: class { constructor() { this.signal = {}; this.aborted = false; } abort() { this.aborted = true; } },
    File: class { constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts.type; this.size = parts.reduce((n, x) => n + (x.size || 0), 0); } },
    navigator: { canShare: () => true, share: data => { shared.push(data); return Promise.resolve(); }, clipboard: { writeText: value => { copied.push(value); return Promise.resolve(); } } },
    fetch: async (url, init) => { context.fetchArgs = [url, init]; return response; }, open: () => { opens++; }, setTimeout, clearTimeout
  };
  Object.assign(context, extras); context.window = context;
  vm.runInNewContext(source, context, { filename: 'pwa-files.js' });
  return { context, document, revoked, shared, copied, get opens() { return opens; } };
}
function response({ status = 200, type = 'application/pdf', bytes = '%PDF-1.7\nbody' } = {}) {
  const blob = new Blob([bytes], { type });
  return { status, ok: status >= 200 && status < 300, headers: { get: name => name === 'content-type' ? type : '' }, blob: async () => blob };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function byId(node, id) { if (node.id === id) return node; for (const child of node.children || []) { const found = byId(child, id); if (found) return found; } }

test('prepare fetches same-origin PDF and exposes only the local download action', async () => {
  const h = harness(response()); await h.context.PwaFiles.prepare({ url: '/api/export.pdf', filename: 'laporan-final.pdf' }); await tick();
  const dialog = h.document.body.children[0]; const download = dialog.query('.pwa-files-download');
  assert.equal(download.textContent, 'Simpan PDF'); assert.equal(download.download, 'laporan-final.pdf'); assert.equal(download.href, 'blob:test-pdf');
  assert.equal(dialog.query('.pwa-files-browser'), undefined); assert.equal(dialog.query('.pwa-files-share'), undefined);
  assert.equal(h.shared.length, 0); assert.equal(h.copied.length, 0); assert.equal(h.opens, 0);
});
test('unauthorized response calls parent callback and supports user-gesture retry', async () => {
  let calls = 0; let unauthorized = 0; const h = harness(response({ status: 401, type: 'application/json', bytes: '{}' }));
  await h.context.PwaFiles.prepare({ url: '/api/export.pdf', filename: 'x.pdf', onUnauthorized: () => unauthorized++, onError: () => calls++ }); await tick();
  assert.equal(unauthorized, 1); assert.equal(calls, 1); const dialog = h.document.body.children[0]; assert.equal(dialog.query('.pwa-files-retry').hidden, false);
  dialog.query('.pwa-files-retry').dispatch('click'); await tick(); assert.equal(calls, 2);
});

test('rejects non-PDF and cross-origin URLs, and cleanup revokes no pending result', async () => {
  const bad = harness(response({ type: 'text/plain' })); await bad.context.PwaFiles.prepare({ url: '/api/export.pdf', filename: 'bad' }); await tick(); assert.match(bad.document.body.children[0].children[1].textContent, /bukan PDF/);
  const cross = harness(response()); let crossError = 0; await cross.context.PwaFiles.prepare({ url: 'https://other.example/file.pdf', onError: () => crossError++ }); assert.equal(crossError, 1); assert.equal(cross.document.body.children.length, 0);
  const pending = harness(response()); const task = await pending.context.PwaFiles.prepare({ url: '/api/export.pdf', filename: 'pending' }); pending.context.PwaFiles.cleanup(); await tick(); assert.equal(pending.document.body.children.length, 0); assert.deepEqual(pending.revoked, []); assert.equal(typeof task.close, 'function');
});

test('APK detection is bridge-only, never inferred from user agent', () => {
  assert.equal(harness(response(), { PangsumaFileBridge: {} }).context.PwaFiles.isAndroidWebView(), true);
  for (const userAgent of ['Mozilla Android 14 Chrome/130 Mobile Safari', 'Mozilla Android 14; wv Chrome/130', 'Mozilla iPhone AppleWebKit']) {
    const h = harness(response(), { navigator: { userAgent } }); assert.equal(h.context.PwaFiles.isAndroidWebView(), false, userAgent);
  }
});

test('APK PDF status dialog is the only action and never opens browser or clipboard', async () => {
  const h = harness(response(), { PangsumaFileBridge: {} });
  const result = h.context.PwaFiles.showApkDownloadStatus({});
  assert.ok(result.dialog.open); assert.equal(result.dialog.id, 'pwaPdfApkDialog');
  assert.equal(byId(result.dialog, 'pwaPdfApkStatus').textContent, 'Unduh PDF langsung memerlukan APK yang diperbarui.');
  assert.equal(result.dialog.query('.pwa-files-close').textContent, 'Tutup');
  assert.equal(result.dialog.children.filter(x => x.className === 'pwa-files-close').length, 1);
  assert.equal(h.context.fetchArgs, undefined); assert.equal(h.shared.length, 0); assert.equal(h.copied.length, 0); assert.equal(h.opens, 0);
  assert.equal(typeof h.context.PwaFiles.openBrowserExport, 'undefined'); assert.equal(typeof h.context.PwaFiles.browserExportUrl, 'undefined');
  result.dialog.query('.pwa-files-close').dispatch('click'); assert.equal(h.document.body.children.length, 0);
});

test('prepare guard in APK shows status without fetch, share, blob, clipboard, or browser open', async () => {
  const h = harness(response(), { PangsumaFileBridge: {} });
  const result = await h.context.PwaFiles.prepare({ url: '/api/export.pdf', filename: 'x.pdf' }); await tick();
  assert.equal(result.dialog.id, 'pwaPdfApkDialog'); assert.equal(h.context.fetchArgs, undefined); assert.equal(h.shared.length, 0); assert.equal(h.copied.length, 0); assert.equal(h.opens, 0);
  assert.equal(byId(result.dialog, 'pwaPdfApkStatus').textContent, 'Unduh PDF langsung memerlukan APK yang diperbarui.');
});

test('ordinary Android and standalone-like PWA contexts are not treated as APK wrapper', () => {
  for (const extras of [{ navigator: { userAgent: 'Android 14 Chrome/130' } }, { navigator: { userAgent: 'Mozilla Chrome/130' }, matchMedia: () => ({ matches: true }) }]) {
    const h = harness(response(), extras); assert.equal(h.context.PwaFiles.isAndroidWebView(), false);
  }
});
