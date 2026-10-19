import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const evidenceSource = fs.readFileSync(new URL('../site/report-evidence.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');

class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) { const on = force === undefined ? !this.values.has(name) : !!force; if (on) this.values.add(name); else this.values.delete(name); return on; }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.ownerDocument = null;
    this.listeners = {}; this.attributes = {}; this.style = {}; this.className = ''; this.classList = new FakeClassList();
    this.hidden = false; this.disabled = false; this.readOnly = false; this.isConnected = true; this.files = [];
    this.value = ''; this.checked = false; this.textContent = ''; this.src = '';
  }
  appendChild(child) { child.parentNode = this; child.ownerDocument = this.ownerDocument; child.isConnected = true; this.children.push(child); return child; }
  insertBefore(child, before) { child.parentNode = this; child.ownerDocument = this.ownerDocument; child.isConnected = true; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, child); return child; }
  remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
  replaceWith(next) { next.parentNode = this.parentNode; next.ownerDocument = this.ownerDocument; if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children[i] = next; } this.isConnected = false; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(x => x !== fn); }
  async dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) await fn({ type, target: this, preventDefault() {}, ...event }); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; }
  getAttribute(name) { return this.attributes[name]; }
  cloneNode() { const x = new FakeElement(this.tagName); x.ownerDocument = this.ownerDocument; return x; }
  focus() { this.focused = true; }
  contains(x) { return x === this || this.children.some(c => c.contains?.(x)); }
  matches(selector) { return selector === 'input,textarea' ? ['INPUT', 'TEXTAREA'].includes(this.tagName) : false; }
  closest() { return null; }
  querySelector(selector) { return this.parts?.[selector] || null; }
  querySelectorAll() { return []; }
  set innerHTML(value) {
    this.parts = {};
    const make = (selector, tag, key = selector) => { const x = new FakeElement(tag); x.ownerDocument = this.ownerDocument; this.parts[key] = x; return x; };
    make('.receipt-file', 'input'); make('.receipt-consent input', 'input'); make('.receipt-consent-error', 'p');
    make('.receipt-file-name', 'p'); make('.receipt-preview', 'img'); make('.receipt-status', 'p');
    make('.receipt-remove', 'button'); make('.receipt-retry', 'button'); make('.receipt-upload', 'button');
    this.parts['.receipt-consent-error'].hidden = true;
  }
}

function harness({ draft = null, api = () => { throw new Error('API must not be called'); } } = {}) {
  const storage = new Map();
  const revoked = [];
  const document = { body: new FakeElement('body'), createElement(tag) { const x = new FakeElement(tag); x.ownerDocument = document; return x; }, querySelectorAll() { return []; } };
  document.body.ownerDocument = document;
  const form = new FakeElement('form'); form.ownerDocument = document; form.querySelector = selector => selector === '.form-actions' ? null : null;
  const url = { createObjectURL(blob) { const value = `blob:test-${revoked.length + 1}`; return value; }, revokeObjectURL(value) { revoked.push(value); } };
  const sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  if (draft) storage.set('pangsuma:new-request-evidence:u1:petty_cash', JSON.stringify(draft));
  const sandbox = { console, document, URL: url, Blob, Uint8Array, AbortController, setTimeout, clearTimeout, sessionStorage, atob: value => Buffer.from(value, 'base64').toString('binary'), btoa: value => Buffer.from(value, 'binary').toString('base64'), crypto: globalThis.crypto, MutationObserver: undefined };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(evidenceSource, sandbox);
  sandbox.ReportEvidence.configure({ getUser: () => ({ id: 'u1', role: 'user' }), api, newKey: () => 'photo-key' });
  const mounted = sandbox.ReportEvidence.mountDraft(form, { ownerId: 'u1', type: 'petty_cash' });
  return { sandbox, evidence: sandbox.ReportEvidence, form, ctx: mounted.context, storage, revoked };
}

function seededDraft(overrides = {}) {
  return { ownerId: 'u1', type: 'petty_cash', dataBase64: 'AQID', filename: 'nota.jpg', mimeType: 'image/jpeg', width: 2, height: 2, publicConsent: false, uploadKey: 'photo-key', ...overrides };
}

test('stored drafts default public consent and prepare without API or a consent prompt', async () => {
  let calls = 0;
  const h = harness({ draft: seededDraft(), api: () => { calls++; return Promise.resolve({}); } });
  assert.equal(h.ctx.draft.publicConsent, true);
  const prepared = await h.evidence.prepareDraftSubmission(h.form);
  assert.equal(prepared.hasPhoto, true);
  assert.equal(h.ctx.draft.publicConsent, true);
  assert.equal(calls, 0);
  assert.equal(h.ctx.preparedForSubmission, true);
  assert.equal(h.ctx.uploading, false);
});

test('remove resets the draft completely without a consent control', async () => {
  const h = harness({ draft: seededDraft() });
  h.ctx.previewUrl = 'blob:test-existing'; h.ctx.preview.src = h.ctx.previewUrl; h.ctx.preview.hidden = false; h.ctx.status.textContent = 'Siap.';
  h.ctx.input.value = 'selected'; h.ctx.draft.publicConsent = true;
  await h.ctx.remove.dispatch('click');
  assert.equal(h.ctx.draft, null); assert.equal(h.ctx.status.textContent, '');
  assert.equal(h.ctx.preview.src, ''); assert.equal(h.ctx.preview.hidden, true); assert.ok(h.revoked.includes('blob:test-existing'));
  assert.equal(h.ctx.input.value, ''); assert.equal(h.storage.size, 0); assert.equal(h.evidence.hasPending(h.form), false);
});

test('remove is guarded while processing/uploading or after prepared submission is locked', async () => {
  const h = harness({ draft: seededDraft() });
  h.ctx.processing = true; await h.ctx.remove.dispatch('click'); assert.ok(h.ctx.draft);
  h.ctx.processing = false; h.ctx.uploading = true; await h.ctx.remove.dispatch('click'); assert.ok(h.ctx.draft);
  h.ctx.uploading = false; h.ctx.preparedForSubmission = true; await h.ctx.remove.dispatch('click'); assert.ok(h.ctx.draft);
  h.ctx.preparedForSubmission = false; h.ctx.draft.submissionId = 'submission-1'; await h.ctx.remove.dispatch('click'); assert.ok(h.ctx.draft);
});

test('friendlyError gives actionable consent guidance and keeps unknown errors generic', () => {
  const context = vm.createContext({ ApiFailure: class ApiFailure extends Error {}, console });
  const friendly = appSource.slice(appSource.indexOf('function friendlyError('), appSource.indexOf('\n\nasync function renderAfterMutation'));
  vm.runInContext(friendly, context);
  assert.match(context.friendlyError({ code: 'CONSENT_REQUIRED' }), /Setujui/);
  assert.doesNotMatch(context.friendlyError({ code: 'CONSENT_REQUIRED' }), /Koneksi|network/i);
  assert.equal(context.friendlyError(new Error('unexpected')), 'Koneksi ke layanan gagal. Periksa koneksi lalu coba lagi.');
});
