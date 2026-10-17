import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const helperSource = source.slice(source.indexOf('function managerOverviewSnapshot('), source.indexOf('\nclass ApiFailure'));

function makeHarness({ role = 'manager', hidden = false, online = true } = {}) {
  const context = {
    Date,
    JSON,
    navigator: { onLine: online },
    document: {
      hidden,
      activeElement: { matches: () => false }
    },
    renderCount: 0,
    overviewCalls: 0,
    toastCount: 0
  };
  vm.createContext(context);
  vm.runInContext(`
    let state = {
      user: { id: 'manager-1', role: ${JSON.stringify(role)}, mustChangePassword: false },
      cashBalanceIdr: 0, submissions: [], summary: {}, cashLedger: [], auditEvents: [], history: {}
    };
    let currentPage = 'overview';
    let managerSyncBusy = false;
    let managerSyncLastAt = 0;
    let managerSyncRerenderPending = false;
    const managerSyncMinIntervalMs = 15_000;
    const $$ = selector => selector === 'dialog[open]' ? (document.querySelector?.() || []) : [];
    async function refreshOverview() {
      overviewCalls += 1;
      if (globalThis.overviewError) throw globalThis.overviewError;
      if (globalThis.nextOverview) Object.assign(state, globalThis.nextOverview);
    }
    function renderApp() { renderCount += 1; }
    ${helperSource}
    globalThis.configure = (patch = {}) => {
      if (patch.state) Object.assign(state, patch.state);
      if (patch.page) currentPage = patch.page;
      if (patch.dialog) document.querySelector = () => patch.dialog ? [{}] : [];
      if (patch.input) document.activeElement = { matches: selector => selector.includes('input') };
      if (patch.busy) managerSyncBusy = true;
      if (patch.pending) managerSyncRerenderPending = true;
      if (patch.error) globalThis.overviewError = patch.error;
      if (patch.next) globalThis.nextOverview = patch.next;
    };
    globalThis.inspect = () => ({
      state, currentPage, managerSyncBusy, managerSyncRerenderPending,
      renderCount, overviewCalls
    });
  `, context);
  return context;
}

async function poll(context, options) {
  return vm.runInContext(`refreshManagerOverview(${JSON.stringify(options || {})})`, context);
}

test('manager polling hanya berjalan untuk manager yang terlihat dan online', async () => {
  for (const options of [{ role: 'user' }, { hidden: true }, { online: false }]) {
    const context = makeHarness(options);
    assert.equal(await poll(context), false);
    assert.equal(context.inspect().overviewCalls, 0);
  }
});

test('polling tidak menggandakan request saat request sebelumnya masih berjalan', async () => {
  const context = makeHarness();
  vm.runInContext('managerSyncBusy = true', context);
  assert.equal(await poll(context), false);
  assert.equal(context.inspect().overviewCalls, 0);
});

test('polling berubah merender overview, tanpa toast, dan tidak merender saat tidak berubah', async () => {
  const context = makeHarness();
  vm.runInContext('nextOverview = { summary: { pending: 1 }, submissions: [{ id: "new" }] }', context);
  assert.equal(await poll(context, { force: true }), true);
  assert.equal(context.inspect().renderCount, 1);
  assert.equal(context.inspect().overviewCalls, 1);
  assert.equal(context.toastCount, 0);
  assert.equal(await poll(context, { force: true }), false);
  assert.equal(context.inspect().renderCount, 1);
});

test('dialog atau input aktif menunda rerender sampai aman dan management page tidak dirusak', async () => {
  const context = makeHarness();
  vm.runInContext('nextOverview = { summary: { pending: 2 } }', context);
  vm.runInContext('document.querySelector = () => [{}]', context);
  assert.equal(await poll(context, { force: true }), true);
  assert.equal(context.inspect().renderCount, 0);
  assert.equal(context.inspect().managerSyncRerenderPending, true);

  vm.runInContext('document.querySelector = () => []; currentPage = "users"', context);
  assert.equal(await poll(context, { force: true }), false);
  assert.equal(context.inspect().renderCount, 0);
  vm.runInContext('currentPage = "overview"', context);
  assert.equal(await poll(context, { force: true }), false);
  assert.equal(context.inspect().renderCount, 1);
});

test('session/auth guard menelan session_changed tanpa toast atau render', async () => {
  const context = makeHarness();
  vm.runInContext('overviewError = { code: "session_changed" }', context);
  assert.equal(await poll(context, { force: true }), false);
  assert.equal(context.inspect().renderCount, 0);
  assert.equal(context.toastCount, 0);
});
