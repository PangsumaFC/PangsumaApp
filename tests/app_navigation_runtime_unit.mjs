import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const navigation = source.slice(source.indexOf("let currentPage = 'overview';"), source.indexOf('let reportTypePreset'));
function runtime({ standalone = false, role = 'manager', historyAvailable = true } = {}) {
  const entries = [{ state: null, external: true }, { state: null }];
  let index = 1, listener = null;
  const host = { renders: [], unsaved: false, confirm: true, dialog: null };
  const history = {
    get state() { return entries[index].state; },
    pushState(state) { entries.splice(index + 1); entries.push({ state }); index++; },
    replaceState(state) { entries[index] = { ...entries[index], state }; },
    back() { if (index > 0) { index--; listener?.({ state: entries[index].state }); } },
    forward() { if (index + 1 < entries.length) { index++; listener?.({ state: entries[index].state }); } },
  };
  const window = {
    ...(historyAvailable ? { history } : {}),
    location: { href: 'https://app.test/' },
    matchMedia: query => ({ matches: standalone && query.includes('standalone') }),
    addEventListener(type, cb) { if (type === 'popstate') listener = cb; },
    confirm: () => host.confirm,
  };
  const ctx = vm.createContext({ window, document: { querySelector: () => host.dialog }, navigator: { standalone },
    state: { user: { role, id: 'owner', mustChangePassword: false } },
    renderApp: () => host.renders.push(vm.runInContext('currentPage', ctx)),
    hasUnsavedDraft: () => host.unsaved, canCloseReportActivity: () => host.confirm,
  });
  vm.runInContext(navigation + '\nif(navigationHistoryAvailable())window.addEventListener("popstate",handleNavigationPop);resetNavigationSession();', ctx);
  return { host, history, entries, ctx, get index() { return index; },
    go: (page, options = {}) => vm.runInContext(`navigateToPage(${JSON.stringify(page)},${JSON.stringify(options)})`, ctx),
    value: expression => vm.runInContext(expression, ctx) };
}
for (const standalone of [false, true]) test(`actual navigation functions restore Back/Forward and permit native boundary (${standalone ? 'PWA' : 'tab'})`, () => {
  const r = runtime({ standalone });
  r.go('finance'); r.go('users');
  assert.equal(r.index, 3);
  r.history.back(); assert.equal(r.value('currentPage'), 'finance');
  r.history.back(); assert.equal(r.value('currentPage'), 'overview');
  r.history.forward(); assert.equal(r.value('currentPage'), 'finance');
  r.history.back(); r.history.back();
  assert.equal(r.index, 0, 'external/native boundary must not be pushed away');
  assert.equal(r.entries.length, 4, 'popstate must not grow history');
  assert.deepEqual(Object.keys(r.entries[2].state).sort(), ['page', 'pangsumaNavigation', 'session']);
});
test('actual navigation denies inaccessible pages and retains synchronous fallback without History API', () => {
  const r = runtime({ role: 'user' });
  assert.equal(r.go('finance'), false); assert.equal(r.index, 1);
  assert.equal(r.go('my-reports'), true); assert.equal(r.index, 2);
  const fallback = runtime({ role: 'user', historyAvailable: false });
  assert.equal(fallback.go('my-reports'), true);
  assert.equal(fallback.value('currentPage'), 'my-reports');
  assert.deepEqual(fallback.host.renders, ['my-reports']);
});
test('actual navigation retains unsaved-draft guard and session invalidation', () => {
  const r = runtime(); r.go('finance'); r.go('new-report');
  r.host.unsaved = true; r.host.confirm = false;
  r.history.back(); assert.equal(r.index, 3); assert.equal(r.value('currentPage'), 'new-report');
  r.host.confirm = true; r.history.back(); assert.equal(r.value('currentPage'), 'finance');
  const oldSession = r.value('navigationSession');
  r.value('state.user=null;resetNavigationSession();');
  assert.notEqual(r.value('navigationSession'), oldSession);
  const renders = r.host.renders.length;
  r.history.back(); assert.equal(r.host.renders.length, renders, 'stale protected entry cannot render after logout');
});
test('actual Back closes a report dialog before changing the underlying menu', () => {
  const r = runtime(); r.go('finance');
  let closed = 0; r.host.dialog = { close() { closed++; r.host.dialog = null; } };
  r.history.back();
  assert.equal(closed, 1); assert.equal(r.index, 2); assert.equal(r.value('currentPage'), 'finance');
  r.history.back(); assert.equal(r.value('currentPage'), 'overview');
});
