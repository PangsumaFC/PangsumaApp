import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function loadCashInsights(');
const code = source.slice(start, source.indexOf('\n}', start) + 2);
test('unchanged insights polls reuse bounded memo; ledger anchor, day and manual refresh invalidate it', async () => {
  let calls = 0, day = '2026-10-18';
  const context = vm.createContext({ state: { user: { id: 'm', role: 'manager' }, cashBalanceIdr: 100, cashLedgerAnchorId: 2 },
    authEpoch: 1, cashInsightsRequestBusy: false, cashInsightsRequestEpoch: 0, cashInsightsCacheKey: '', cashInsightsCachedAt: 0,
    todayISO: () => day, api: async () => { calls++; return { snapshotStable: true }; }, renderCashInsightsRegion() {}, friendlyError: String,
  });
  vm.runInContext(code, context);
  await context.loadCashInsights(); await context.loadCashInsights(); assert.equal(calls, 1);
  context.state.cashLedgerAnchorId++; // A net-zero top-up/spend still changes the append-only anchor.
  await context.loadCashInsights(); assert.equal(calls, 2);
  await context.loadCashInsights({ force: true }); assert.equal(calls, 3);
  day = '2026-10-19'; await context.loadCashInsights(); assert.equal(calls, 4);
  context.cashInsightsCachedAt = Date.now() - 61000; await context.loadCashInsights(); assert.equal(calls, 5);
});
