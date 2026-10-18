import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class FakeElement {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {}; this.style = {}; this.hidden = false; this.isConnected = true; this.files = []; this.ownerDocument = null; this.className = ''; }
  appendChild(child) { child.parentNode = this; child.ownerDocument = this.ownerDocument; this.children.push(child); return child; }
  remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
  replaceWith(next) { next.parentNode = this.parentNode; next.ownerDocument = this.ownerDocument; if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children[i] = next; } this.isConnected = false; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  async dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) await fn({ type, target: this, preventDefault() {}, ...event }); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  cloneNode() { const x = new FakeElement(this.tagName); x.ownerDocument = this.ownerDocument; return x; }
  contains(x) { return x === this || this.children.some(c => c.contains?.(x)); }
  closest() { return null; }
  querySelector(selector) {
    if (selector.startsWith('.')) return this.parts?.[selector] || null;
    return null;
  }
  querySelectorAll() { return []; }
  set innerHTML(value) {
    this.parts = {};
    for (const [selector, tag] of [['.receipt-file', 'input'], ['.receipt-upload', 'button'], ['.receipt-file-name', 'p'], ['.receipt-preview', 'img'], ['.receipt-status', 'p'], ['.receipt-count', 'span'], ['.receipt-list-region', 'div']]) { const x = new FakeElement(tag); x.ownerDocument = this.ownerDocument; this.parts[selector] = x; }
  }
}

function harness(apiImpl) {
  const document = { body: new FakeElement('body'), createElement(tag) { const x = new FakeElement(tag); x.ownerDocument = document; return x; }, querySelectorAll() { return []; } };
  const sandbox = { console, URL, crypto: globalThis.crypto, setTimeout, clearTimeout, AbortController, document, Image: class {}, btoa: x => Buffer.from(x, 'binary').toString('base64') };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(new URL('../site/report-evidence.js', import.meta.url), 'utf8'), sandbox);
  sandbox.ReportEvidence.configure({ getUser: () => ({ id: 'u1', role: 'user' }), api: apiImpl, newKey: () => 'race-key' });
  const container = new FakeElement('div'); container.ownerDocument = document; container.isConnected = true;
  document.body.appendChild(container);
  return { evidence: sandbox.ReportEvidence, container };
}

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

 test('delayed initial GET cannot unlock picker during POST and max count survives finally', async () => {
  const initial = deferred(), post = deferred(), refresh = deferred();
  let getCount = 0;
  const api = (path, options = {}) => {
    if (options.method === 'POST') return post.promise;
    getCount++;
    return getCount === 1 ? initial.promise : refresh.promise;
  };
  const { evidence, container } = harness(api);
  const result = evidence.mountReceipts(container, { id: 's1', createdById: 'u1' });
  const ctx = result.context;
  ctx.prepared = { filename: 'nota.jpg', mimeType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) };
  ctx.input.files = [{ name: 'nota.jpg' }];
  ctx.input.disabled = false;

  const upload = ctx.file.dispatch('click');
  await Promise.resolve();
  assert.equal(evidence.isBusy(container), true);
  assert.equal(ctx.input.disabled, true);

  initial.resolve({ items: [{ url: '/api/receipts/old', filename: 'old.jpg', sizeBytes: 3 }], count: 1, maxCount: 2 });
  await Promise.resolve();
  assert.equal(ctx.input.disabled, true, 'late initial list must not unlock while POST is active');

  post.resolve({ ok: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(getCount, 2, 'successful POST starts a follow-up list request');
  refresh.resolve({ items: [{ url: '/api/receipts/old', filename: 'old.jpg', sizeBytes: 3 }, { url: '/api/receipts/new', filename: 'nota.jpg', sizeBytes: 3 }], count: 2, maxCount: 2 });
  await upload;
  assert.equal(evidence.isBusy(container), false);
  assert.equal(ctx.uploading, false);
  assert.equal(ctx.input.disabled, true, 'max receipt count remains enforced after finally');
  assert.match(ctx.status.textContent, /berhasil diunggah/);
});
