import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/pdf-browser.js', import.meta.url), 'utf8');
function harness(search = '', options = {}) {
  const nodes = new Map();
  const events = {};
  const window = { location: { search, origin: 'https://app.test' }, addEventListener(type, fn) { (events[type] ||= []).push(fn); }, PdfBrowser: null, ...options.window };
  const document = {
    readyState: 'complete', visibilityState: 'visible', addEventListener() {},
    getElementById(id) {
      if (nodes.has(id)) return nodes.get(id);
      const node = { hidden: false, dataset: {}, attrs: {}, children: [], listeners: {}, textContent: '', disabled: false,
        setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
        appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
        addEventListener(k, fn) { this.listeners[k] = fn; }, focus() {}, select() {} };
      nodes.set(id, node); return node;
    },
    createElement() { return { textContent: '', dataset: {}, children: [], appendChild() {} }; }
  };
  const responses = [];
  const context = { window, document, URLSearchParams, Date, Promise, setTimeout, clearTimeout, navigator: options.navigator,
    fetch: () => Promise.resolve(responses.shift()), console };
  vm.runInNewContext(source, context);
  return { ...context, nodes, responses, events, api: window.PdfBrowser };
}
function response(status, body) { return { status, ok: status >= 200 && status < 300, json: async () => body }; }

for (const [name, status, body, expected] of [
  ['manager enables link', 200, { user: { role: 'manager' } }, true],
  ['401 asks login', 401, {}, false],
  ['403 clears link', 403, {}, false],
  ['nonmanager clears link', 200, { user: { role: 'user' } }, false],
  ['must change password clears link', 200, { user: { role: 'manager', mustChangePassword: true } }, false]
]) test(name, async () => {
  const h = harness('?q=approved&jenis=petty_cash'); h.responses.push(response(status, body)); await h.api.checkSession();
  assert.equal(h.nodes.get('downloadPdf').hidden, !expected);
  assert.equal(h.nodes.get('downloadPdf').attrs.href || '', expected ? '/api/export.pdf?q=approved&jenis=petty_cash' : '');
  assert.match(h.nodes.get('sessionStatus').textContent, expected ? /terverifikasi|siap/ : /login|akses|bukan|password/);
});

test('network error is not success and clears old link', async () => {
  const h = harness(); h.responses.push(Promise.reject(new Error('offline'))); await h.api.checkSession();
  assert.equal(h.nodes.get('downloadPdf').hidden, true); assert.match(h.nodes.get('sessionStatus').textContent, /jaringan/);
});

test('only seven filters survive and hostile values are text, not markup', async () => {
  const h = harness('?q=%3Cimg%20src=x%20onerror=1%3E&periode=customWIB&jenis=petty_cash&status=approved&pengaju=A%26B&start=2026-01-01&end=2026-01-31&token=secret&redirect=https%3A%2F%2Fevil.test');
  assert.equal(h.api.exportUrl(), '/api/export.pdf?q=%3Cimg+src%3Dx+onerror%3D1%3E&periode=customWIB&jenis=petty_cash&status=approved&pengaju=A%26B&start=2026-01-01&end=2026-01-31');
  const values = h.nodes.get('filterList').children.map(x => x.textContent); assert.equal(values.length, 7); assert.ok(values[0].includes('<img')); assert.equal(h.nodes.get('downloadPdf').attrs.href, undefined);
  assert.doesNotMatch(JSON.stringify(h.nodes), /evil\.test|secret/);
});

test('stale response cannot restore an old manager link', async () => {
  const h = harness(); let resolveOld; h.responses.push(new Promise(resolve => { resolveOld = resolve; }), response(401, {}));
  const old = h.api.checkSession(); const newer = h.api.checkSession(); await newer; resolveOld(response(200, { user: { role: 'manager' } })); await old;
  assert.equal(h.nodes.get('downloadPdf').hidden, true); assert.match(h.nodes.get('sessionStatus').textContent, /login/);
});

test('wrapper manager blocks PDF link and exposes canonical filtered URL', async () => {
  const h = harness('?q=approved&token=secret', { window: { PangsumaFileBridge: {} } });
  h.responses.push(response(200, { user: { role: 'manager' } })); await h.api.checkSession();
  assert.equal(h.nodes.get('downloadPdf').hidden, true);
  assert.equal(h.nodes.get('wrapperHandoff').hidden, false);
  assert.equal(h.nodes.get('canonicalUrl').value, 'https://app.test/pdf-browser.html?q=approved');
  assert.match(h.nodes.get('sessionStatus').textContent, /masih di APK/);
});

test('clipboard failure selects canonical URL and gives manual-copy instructions', async () => {
  const h = harness('?periode=2026&redirect=https%3A%2F%2Fevil.test', { window: { PangsumaFileBridge: {} }, navigator: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } } });
  await h.api.copyCanonicalUrl();
  assert.equal(h.nodes.get('canonicalUrl').value, 'https://app.test/pdf-browser.html?periode=2026');
  assert.match(h.nodes.get('sessionStatus').textContent, /manual/);
});

test('no external login destination and no storage or bridge references', () => {
  const html = fs.readFileSync(new URL('../site/pdf-browser.html', import.meta.url), 'utf8');
  assert.match(html, /href="\/"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|window\.open|https?:\/\//);
});

test('handoff hidden controls cannot be exposed by button display styles', () => {
  const css = fs.readFileSync(new URL('../site/pdf-browser.css', import.meta.url), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('empty filter handoff states its full-report scope explicitly', () => {
  const h = harness();
  assert.equal(h.nodes.get('filterList').children[0].textContent, 'Seluruh periode · semua pengajuan');
  assert.equal(h.api.canonicalUrl(), 'https://app.test/pdf-browser.html');
});
