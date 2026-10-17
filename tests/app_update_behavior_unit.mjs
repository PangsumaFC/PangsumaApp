import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function hasUnsavedDraft()'), source.indexOf('\nfunction profileAvatar('));
function field(value = '', defaultValue = '', extra = {}) { return { value, defaultValue, type: 'text', ...extra }; }
function form(fields, { closed = false, hidden = false } = {}) {
  return { elements: fields, closest: selector => selector === 'dialog' ? (closed ? { open: false } : null) : hidden ? {} : null };
}
function harness({ forms = [], busy = false, role = 'manager', confirm = false, draft = null } = {}) {
  const calls = { reloaded: 0, confirmed: 0, fetched: [], toasts: [] };
  const banner = { hidden: true }, label = { textContent: '' }, button = { disabled: false };
  const context = vm.createContext({
    profileDraft: draft, APP_BUILD: '2026.10.18.3', updateCheckBusy: false, availableBuild: '',
    state: { user: { role } },
    document: { hidden: false, querySelectorAll: () => forms, querySelector: () => busy ? {} : null },
    navigator: { onLine: true },
    $: selector => ({ '#appUpdateBanner': banner, '#appUpdateVersion': label, '#appUpdateReload': button })[selector],
    window: { confirm: () => { calls.confirmed++; return confirm; }, location: { reload: () => calls.reloaded++ } },
    showToast: message => calls.toasts.push(message),
    fetch: async (url, options) => { calls.fetched.push({ url, options }); return { ok: true, json: async () => ({ build: '2026.10.18.4' }) }; }
  });
  vm.runInContext(code, context);
  return { context, calls, banner, label };
}
test('draft checks include main forms, checkboxes, and pending photo but ignore closed dialogs', () => {
  assert.equal(harness({ forms: [form([field('edited')])] }).context.hasUnsavedDraft(), true);
  assert.equal(harness({ forms: [form([field('edited')], { closed: true })] }).context.hasUnsavedDraft(), false);
  assert.equal(harness({ forms: [form([field('preset', 'preset')])] }).context.hasUnsavedDraft(), false);
  assert.equal(harness({ forms: [form([field('', '', { type: 'checkbox', checked: true, defaultChecked: false })])] }).context.hasUnsavedDraft(), true);
  assert.equal(harness({ draft: { photoDataUrl: 'data:image/png;fixture' } }).context.hasUnsavedDraft(), true);
});
test('active save and photo processing prevent reload even if discard would be accepted', async () => {
  for (const options of [{ busy: true }, { draft: { saving: true } }, { draft: { processing: true } }]) {
    const h = harness({ ...options, confirm: true });
    await h.context.reloadToLatestBuild();
    assert.equal(h.calls.reloaded, 0);
    assert.equal(h.calls.confirmed, 0);
    assert.equal(h.calls.toasts.length, 1);
  }
});
test('cancelling discard preserves draft and accepting reloads exactly once', async () => {
  for (const confirm of [false, true]) {
    const h = harness({ forms: [form([field('draft')])], confirm });
    await h.context.reloadToLatestBuild();
    assert.equal(h.calls.reloaded, confirm ? 1 : 0);
    assert.equal(h.calls.confirmed, 1);
  }
});
test('version detection bypasses cache, never reloads and only displays the banner to Manager', async () => {
  for (const role of ['manager', 'user']) {
    const h = harness({ role });
    assert.equal(await h.context.checkForAppUpdate(), true);
    assert.equal(h.calls.fetched[0].options.cache, 'no-store');
    assert.equal(h.calls.reloaded, 0);
    assert.equal(h.banner.hidden, role !== 'manager');
  }
});
