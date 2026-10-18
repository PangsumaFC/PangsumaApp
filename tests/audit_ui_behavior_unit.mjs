import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
function extract(name) {
  const marker = `function ${name}(`;
  let start = source.indexOf(marker);
  assert.ok(start >= 0, name);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function load(context, names) { for (const name of names) vm.runInContext(extract(name), context); }
test('auditRow escapes untrusted rejection text as text, not executable markup', () => {
  const context = vm.createContext({ money: String, dateTimeLong: String });
  vm.runInContext(source.slice(source.indexOf('const escapeHTML ='), source.indexOf('const money =')), context);
  load(context, ['auditRow']);
  const html = context.auditRow({ action: 'submission.status_changed', details_json: JSON.stringify({ from: 'pending', to: 'rejected', reason: '<img src=x onerror="alert(1)">' }), actor_name: '<script>bad</script>', created_at: '2026-01-01' });
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;img/); assert.match(html, /Alasan:/);
});
test('manager user-only status change rerenders table even when financial data is unchanged', async () => {
  let renders = 0; const pages = [];
  const context = vm.createContext({
    state: { user: { id: 'm', role: 'manager' }, users: [{ id: 'u', active: true }], usersPage: { page: 2 } },
    managerSyncBusy: false, managerSyncLastAt: 0, managerSyncMinIntervalMs: 15000, managerSyncRerenderPending: false,
    currentPage: 'users', document: { hidden: false }, navigator: { onLine: true },
    refreshOverview: async () => {}, refreshUsersPage: async page => { pages.push(page); context.state.users[0].active = false; },
    managerSyncRenderSafe: () => true, renderApp: () => renders++,
  });
  load(context, ['managerOverviewSnapshot', 'refreshManagerOverview']);
  assert.equal(await context.refreshManagerOverview({ force: true }), true);
  assert.equal(renders, 1); assert.deepEqual(pages, [2]);
});
test('User poll refreshes the current server-query window and restores active search caret', async () => {
  const calls = []; let renders = 0; let focused = false; let selection;
  const input = { id: 'archiveSearch', selectionStart: 3, selectionEnd: 5, focus: () => { focused = true; }, setSelectionRange: (...args) => { selection = args; } };
  const context = vm.createContext({ state: { user: { id: 'u', role: 'user' }, archiveSearch: 'Disetujui' }, currentPage: 'my-reports', authEpoch: 1,
    navigator: { onLine: true }, document: { hidden: false, activeElement: input },
    refreshOverview: async options => calls.push(['overview', options.preserveHistory]),
    BoundedHistory: { load: async (...args) => calls.push(args) },
    renderApp: () => renders++, $: () => input,
  });
  load(context, ['requestUserOverviewRefresh']);
  assert.equal(await context.requestUserOverviewRefresh(), true);
  assert.equal(calls[1][0], 'submissions'); assert.equal(calls[1][1], 'refresh');
  assert.equal(context.state.archiveSearch, 'Disetujui'); assert.equal(renders, 1); assert.equal(focused, true); assert.deepEqual(selection, [3, 5]);
  context.currentPage = 'new-report'; calls.length = 0;
  assert.equal(await context.requestUserOverviewRefresh(), false); assert.equal(calls.length, 0);
});
test('threshold label distinguishes device override from server default without merging policies', () => {
  let stored = null;
  const context = vm.createContext({ state: { user: { id: 'm' } }, localStorage: { getItem: () => stored } });
  load(context, ['cashInsightMinimumKey', 'getCashInsightMinimum', 'cashInsightThresholdSourceLabel']);
  assert.match(context.cashInsightThresholdSourceLabel({ minimumIdr: '1000' }), /server/i);
  stored = '200'; assert.match(context.cashInsightThresholdSourceLabel({ minimumIdr: '1000' }), /lokal/i);
  assert.equal(context.getCashInsightMinimum({ minimumIdr: '1000' }), '200');
  stored = null; assert.equal(context.getCashInsightMinimum({ minimumIdr: null }), null);
});
