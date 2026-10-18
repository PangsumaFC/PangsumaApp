import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('function asyncLifecycle()'), source.indexOf('async function refreshUsersPage'));
function harness() { const context = vm.createContext({}); vm.runInContext(helper, context); return vm.runInContext('asyncLifecycle()', context); }
test('shared lifecycle ignores stale finish and failure while a newer page is active', () => {
  const lifecycle = harness(); const old = lifecycle.begin(); const current = lifecycle.begin();
  assert.equal(lifecycle.current(old), false); assert.equal(lifecycle.current(current), true);
  lifecycle.fail(old, new Error('old')); lifecycle.finish(old);
  assert.equal(lifecycle.busy, true); assert.equal(lifecycle.error, null);
  lifecycle.finish(current); assert.equal(lifecycle.busy, false);
});
test('shared lifecycle exposes current error and clears it on explicit retry', () => {
  const lifecycle = harness(); const token = lifecycle.begin(); const error = new Error('retryable');
  lifecycle.fail(token, error); lifecycle.finish(token); assert.equal(lifecycle.error, error);
  const retried = lifecycle.begin(); assert.equal(lifecycle.error, null); assert.equal(lifecycle.busy, true);
  assert.equal(lifecycle.current(token), false); lifecycle.finish(retried); assert.equal(lifecycle.busy, false);
});
test('shared lifecycle does not replace the independent cursor contracts', () => {
  assert.match(source, /const request = usersPageLifecycle\.begin\(\)/);
  assert.match(source, /const request = historyPageLifecycle\.begin\(\)/);
  assert.match(source, /BoundedHistory\.load\(collection, direction\)/);
  assert.match(source, /api\(`\/users\?page=\$\{page\}&limit=5&q=\$\{encodeURIComponent\(search\)\}`\)/);
});

test('cancellation invalidates in-flight result and leaves a clean retry lifecycle', () => {
  const lifecycle = harness(), token = lifecycle.begin();
  lifecycle.cancel(); assert.equal(lifecycle.current(token), false);
  assert.equal(lifecycle.busy, false); assert.equal(lifecycle.error, null);
  const retry = lifecycle.begin(); assert.equal(lifecycle.current(retry), true);
});

test('independent history collections finish their own controls and deduplicate same-collection loads', async () => {
  const pending = new Map(); const calls = [];
  const context = vm.createContext({ state: { user: { id: 'u' } }, BoundedHistory: { load(collection) { calls.push(collection); return new Promise(resolve => pending.set(collection, resolve)); } }, setButtonBusy(button, busy) { button.busy = busy; } });
  const start = source.indexOf('async function loadMoreHistory('), end = source.indexOf('\nfunction canCloseReportActivity', start);
  vm.runInContext(helper + '\n' + source.slice(start, end), context);
  const ledger = { isConnected: true }, submissions = { isConnected: true };
  context.ledgerButton = ledger; context.submissionsButton = submissions;
  const first = vm.runInContext("loadMoreHistory('cashLedger', ledgerButton)", context);
  const second = vm.runInContext("loadMoreHistory('submissions', submissionsButton)", context);
  await vm.runInContext("loadMoreHistory('cashLedger', ledgerButton)", context);
  assert.deepEqual(calls, ['cashLedger', 'submissions']);
  pending.get('submissions')(); await second;
  assert.equal(submissions.busy, false); assert.equal(ledger.busy, true);
  pending.get('cashLedger')(); await first; assert.equal(ledger.busy, false);
});
