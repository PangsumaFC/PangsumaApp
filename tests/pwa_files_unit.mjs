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
    const all = []; const visit = (node) => { for (const child of node.children || []) { all.push(child); visit(child); } }; visit(this);
    if (selector === '.pwa-files-download') return all.find((x) => x.className === selector.slice(1));
    if (selector === '.pwa-files-share' || selector === '.pwa-files-retry' || selector === '.pwa-files-close') return all.find((x) => x.className === selector.slice(1));
    return null;
  }
}
class Document {
  constructor() { this.body = new Element('body'); this.activeElement = new Element('button'); }
  createElement(tag) { return new Element(tag); }
}
function harness(response, extras = {}) {
  const document = new Document(); const revoked = []; const shared = [];
  class BrowserURL extends NodeURL {}
  BrowserURL.createObjectURL = () => 'blob:test-pdf';
  BrowserURL.revokeObjectURL = (url) => revoked.push(url);
  const context = {
    window: null, document, location: { href: 'https://app.example.test/finance', origin: 'https://app.example.test' },
    URL: BrowserURL,
    AbortController: class { constructor() { this.signal = {}; this.aborted = false; } abort() { this.aborted = true; } },
    File: class { constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts.type; this.size = parts.reduce((n, x) => n + (x.size || 0), 0); } },
    navigator: { canShare: () => true, share: (data) => { shared.push(data); return Promise.resolve(); } },
    fetch: async (url, init) => { context.fetchArgs = [url, init]; return response; },
    setTimeout, clearTimeout
  };
  Object.assign(context, extras);
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'pwa-files.js' });
  return { context, document, revoked, shared };
}
function response({ status = 200, type = 'application/pdf', bytes = '%PDF-1.7\nbody' } = {}) {
  const blob = new Blob([bytes], { type });
  return { status, ok: status >= 200 && status < 300, headers: { get: (name) => name === 'content-type' ? type : '' }, blob: async () => blob };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

 test('prepare fetches same-origin PDF and exposes download and share actions', async () => {
  const h = harness(response());
  const before = h.document.activeElement;
  await h.context.PwaFiles.prepare({ url: '/api/export.pdf?x=1', filename: 'laporan:final', isCurrent: () => true });
  await tick();
  assert.equal(h.context.fetchArgs[0], 'https://app.example.test/api/export.pdf?x=1');
  assert.equal(h.context.fetchArgs[1].credentials, 'same-origin');
  assert.equal(h.context.fetchArgs[1].cache, 'no-store');
  const dialog = h.document.body.children[0];
  const download = dialog.query('.pwa-files-download');
  const share = dialog.query('.pwa-files-share');
  assert.equal(download.textContent, 'Simpan PDF');
  assert.equal(download.download, 'laporan-final.pdf');
  assert.equal(download.href, 'blob:test-pdf');
  assert.equal(share.hidden, false);
  share.dispatch('click');
  assert.equal(h.shared.length, 1);
  assert.equal(h.shared[0].files[0].name, 'laporan-final.pdf');
  dialog.query('.pwa-files-close')?.dispatch('click');
  assert.deepEqual(h.revoked, ['blob:test-pdf']);
  assert.equal(before.focused, true);
});

test('unauthorized response calls parent callback and supports user-gesture retry', async () => {
  let calls = 0; let unauthorized = 0;
  const h = harness(response({ status: 401, type: 'application/json', bytes: '{}' }));
  await h.context.PwaFiles.prepare({ url: '/api/export.pdf', filename: 'x.pdf', onUnauthorized: () => unauthorized++, onError: () => calls++ });
  await tick();
  assert.equal(unauthorized, 1); assert.equal(calls, 1);
  const dialog = h.document.body.children[0];
  assert.equal(dialog.query('.pwa-files-retry').hidden, false);
  dialog.query('.pwa-files-retry').dispatch('click');
  await tick();
  assert.equal(calls, 2);
});

test('rejects non-PDF and empty responses, rejects cross-origin URLs, and cleanup revokes pending result', async () => {
  const bad = harness(response({ type: 'text/plain' }));
  await bad.context.PwaFiles.prepare({ url: '/api/export.pdf', filename: 'bad' }); await tick();
  assert.match(bad.document.body.children[0].children[1].textContent, /bukan PDF/);
  const cross = harness(response()); let crossError = 0;
  await cross.context.PwaFiles.prepare({ url: 'https://other.example/file.pdf', onError: () => crossError++ });
  assert.equal(crossError, 1); assert.equal(cross.document.body.children.length, 0);
  const pending = harness(response());
  const task = await pending.context.PwaFiles.prepare({ url: '/api/export.pdf', filename: 'pending' });
  pending.context.PwaFiles.cleanup();
  await tick();
  assert.equal(pending.document.body.children.length, 0);
  assert.deepEqual(pending.revoked, []);
  assert.equal(typeof task.close, 'function');
});

function byId(node, id) {
  if (node.id === id) return node;
  for (const child of node.children || []) { const found = byId(child, id); if (found) return found; }
}

test('CSV-only APK bridge gets a browser URL without sending any PDF to native saveCsv', async () => {
  let bridgeCalls = 0;
  const h = harness(response(), { PangsumaFileBridge: { saveCsv() { bridgeCalls++; throw new Error('CSV only'); } } });
  assert.equal(h.context.PwaFiles.isAndroidWebView(), true);
  const result = h.context.PwaFiles.openBrowserExport({ url: '/api/export.pdf?q=Latihan%20pagi&jenis=petty_cash&token=private&redirect=https://evil.test&cursor=old' });
  assert.ok(result.dialog.open);
  assert.equal(bridgeCalls, 0);
  assert.equal(h.context.fetchArgs, undefined);
  const link = byId(result.dialog, 'pwaPdfBrowserLink');
  assert.equal(link.value, 'https://app.example.test/pdf-browser.html?q=Latihan+pagi&jenis=petty_cash');
  const chrome = byId(result.dialog, 'pwaPdfOpenChrome');
  assert.match(chrome.href, /^intent:\/\/app\.example\.test\/pdf-browser\.html\?/);
  assert.match(chrome.href, /package=com\.android\.chrome/);
  assert.ok(chrome.href.includes('S.browser_fallback_url=' + encodeURIComponent(link.value)));
  assert.doesNotMatch(chrome.href, /private|evil\.test|cursor|blob:/);
  assert.match(byId(result.dialog, 'pwaPdfBrowserStatus').textContent, /belum didukung/);
  h.context.PwaFiles.cleanup();
  assert.equal(h.document.body.children.length, 0);
});

test('browser handoff rejects foreign origins and non-report paths', () => {
  const h = harness(response());
  for (const url of ['https://evil.test/api/export.pdf', '/api/users', 'javascript:alert(1)']) {
    assert.equal(h.context.PwaFiles.browserExportUrl(url), null);
    assert.equal(h.context.PwaFiles.openBrowserExport({ url }), null);
  }
  assert.equal(h.document.body.children.length, 0);
});

test('ordinary Android browsers are not incorrectly detected as WebView', () => {
  for (const userAgent of ['Mozilla Android 14 Chrome/130 Mobile Safari', 'Mozilla Android 14 Firefox/130', 'Mozilla iPhone AppleWebKit']) {
    const h = harness(response(), { navigator: { userAgent } });
    assert.equal(h.context.PwaFiles.isAndroidWebView(), false, userAgent);
  }
});

test('clipboard success is reported only after actual copy, failure selects the manual URL', async () => {
  let resolveCopy;
  const copied = [];
  const h = harness(response(), { navigator: { clipboard: { writeText(value) { copied.push(value); return new Promise(resolve => { resolveCopy = resolve; }); } } } });
  const { dialog } = h.context.PwaFiles.openBrowserExport({ url: '/api/export.pdf?status=approved' });
  byId(dialog, 'pwaPdfCopyBrowserLink').dispatch('click');
  assert.equal(copied[0], 'https://app.example.test/pdf-browser.html?status=approved');
  assert.doesNotMatch(byId(dialog, 'pwaPdfBrowserStatus').textContent, /Tautan disalin/);
  resolveCopy(); await tick();
  assert.match(byId(dialog, 'pwaPdfBrowserStatus').textContent, /Tautan disalin/);
  h.context.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  byId(dialog, 'pwaPdfCopyBrowserLink').dispatch('click'); await tick();
  assert.match(byId(dialog, 'pwaPdfBrowserStatus').textContent, /secara manual/);
  assert.equal(byId(dialog, 'pwaPdfBrowserLink').selected, true);
});

test('browser handoff cancels a stale Manager session before opening Chrome or copying', () => {
  const h = harness(response()); let current = true;
  const { dialog } = h.context.PwaFiles.openBrowserExport({ url: '/api/export.pdf', isCurrent: () => current });
  current = false; let prevented = false;
  byId(dialog, 'pwaPdfOpenChrome').listeners.click[0]({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.document.body.children.length, 0);
});
