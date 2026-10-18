import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function asyncLifecycle('), source.indexOf('\nfunction accountDraftKey('));
function harness() {
  const pending = [], calls = { renders: 0, toasts: [] };
  const c = vm.createContext({
    state: { user: { id: 'manager', role: 'manager' }, users: [], usersPage: { page: 1, query: '' } },
    authEpoch: 1, currentPage: 'users', document: { activeElement: null },
    api: url => new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
    friendlyError: error => error.message, renderApp: () => { calls.renders++; },
    showToast: text => calls.toasts.push(text)
  });
  vm.runInContext(code, c);
  return { c, pending, calls };
}
test('current account request exposes loading and keeps server pagination/query', async () => {
  const { c, pending } = harness();
  const p = c.refreshUsersPage(2, false, ' beta ');
  assert.equal(c.state.usersPage.loading, true);
  assert.match(pending[0].url, /page=2&limit=100&q=beta$/);
  pending[0].resolve({ users: [{ id: 'b' }], page: 2, total: 101, hasMore: false });
  assert.equal(await p, true);
  assert.equal(c.state.usersPage.query, 'beta');
  assert.equal(c.state.usersPage.page, 2);
  assert.equal(c.state.usersPage.loading, false);
});
test('new query invalidates an older success before debounce creates a new request', async () => {
  const { c, pending } = harness();
  const old = c.refreshUsersPage(1, false, 'alpha');
  vm.runInContext('usersPageLifecycle.cancel()', c);
  c.state.usersPage.query = 'beta';
  pending[0].resolve({ users: [{ id: 'wrong' }], total: 1 });
  assert.equal(await old, false);
  assert.equal(c.state.users.length, 0);
  assert.equal(c.state.usersPage.query, 'beta');
});
test('stale error cannot replace current results, show an alert, or reject unhandled', async () => {
  const { c, pending } = harness();
  const old = c.refreshUsersPage(1, false, 'alpha');
  const current = c.refreshUsersPage(1, false, 'beta');
  pending[1].resolve({ users: [{ id: 'beta' }], total: 1 }); await current;
  pending[0].reject(Error('old failure'));
  assert.equal(await old, false);
  assert.equal(c.state.users[0].id, 'beta');
  assert.equal(c.state.usersPage.error, '');
});
test('responses and failures from a previous login cannot mutate another account', async () => {
  for (const fail of [false, true]) {
    const { c, pending } = harness();
    const old = c.refreshUsersPage(1);
    c.authEpoch++; c.state.user = { id: 'new-manager', role: 'manager' };
    if (fail) pending[0].reject(Error('prior account'));
    else pending[0].resolve({ users: [{ id: 'private' }], total: 1 });
    assert.equal(await old, false);
    assert.equal(c.state.users.length, 0);
    assert.equal(c.state.usersPage.error, '');
  }
});
test('view loader renders loading and current error, then an explicit retry can recover', async () => {
  const { c, pending, calls } = harness();
  const first = c.loadUsersPageView(1, 'beta');
  assert.equal(c.state.usersPage.loading, true);
  assert.equal(calls.renders, 1);
  pending[0].reject(Error('offline')); assert.equal(await first, false);
  assert.equal(c.state.usersPage.error, 'offline');
  assert.equal(calls.renders, 2); assert.deepEqual(calls.toasts, ['offline']);
  const retry = c.loadUsersPageView(1, 'beta');
  pending[1].resolve({ users: [{ id: 'beta' }], total: 1 }); assert.equal(await retry, true);
  assert.equal(c.state.usersPage.error, '');
});
test('view loader cannot rerender another page after navigation', async () => {
  const { c, pending, calls } = harness();
  const p = c.loadUsersPageView(); c.currentPage = 'overview';
  vm.runInContext('usersPageLifecycle.cancel()', c);
  pending[0].resolve({ users: [{ id: 'not-shown' }] });
  assert.equal(await p, false); assert.equal(calls.renders, 1);
});
test('stored drafts allow navigation while changed or unpersisted values still warn', () => {
  const helper = source.slice(source.indexOf('function formDraftIsStored('), source.indexOf('\nfunction hasUnsavedDraft('));
  const draft = { type: 'finance_request', amountIdr: '1', date: '2026-10-19', description: 'Saved', note: '' };
  const account = { name: 'Saved User', email: 'id@local.invalid', position: '' };
  const c = vm.createContext({ state: { user: { role: 'manager' } }, validReportType: value => value === 'finance_request', readDraft: () => draft, readAccountDraft: () => account });
  vm.runInContext(helper, c);
  const form = (id, values) => ({ id, elements: { namedItem: name => ({ value: values[name] || '' }) } });
  assert.equal(c.formDraftIsStored(form('reportForm', draft)), true);
  assert.equal(c.formDraftIsStored(form('reportForm', { ...draft, note: 'not persisted' })), false);
  assert.equal(c.formDraftIsStored(form('userForm', account)), true);
  assert.equal(c.formDraftIsStored(form('userForm', { ...account, name: 'Other' })), false);
});
test('search rerender keeps keyboard focus and caret position while typing', () => {
  const { c } = harness();
  const calls = { focused: 0, selection: null };
  c.document.activeElement = { id: 'usersSearch', selectionStart: 2, selectionEnd: 4 };
  c.$ = () => ({ focus() { calls.focused++; }, setSelectionRange(start, end) { calls.selection = [start, end]; } });
  c.renderUsersPageView();
  assert.equal(calls.focused, 1);
  assert.deepEqual(calls.selection, [2, 4]);
});
test('profile reload guard warns only for transient unsaved work, not persisted text drafts', () => {
  const bind = source.slice(source.indexOf('function bindEvents('));
  assert.match(bind, /addEventListener\('beforeunload'/);
  assert.match(bind, /!profileDraftDirty\(\).*!profileDraft\?\.processing.*!profileDraft\?\.saving/);
  assert.match(bind, /event\.preventDefault\(\);\s+event\.returnValue = ''/);
});
