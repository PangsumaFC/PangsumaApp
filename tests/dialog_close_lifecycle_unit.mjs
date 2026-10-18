import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function closeDialogs('), source.indexOf('\nfunction renderProfilePreview('));
function harness(allowed) {
  let confirms = 0, closed = 0;
  const context = vm.createContext({
    $$: () => [{ close() { closed++; } }],
    canCloseAppDialog: () => { confirms++; return allowed; }
  });
  vm.runInContext(code, context);
  return { context, calls: () => ({ confirms, closed }) };
}
test('ordinary shared close preserves dirty dialog when discard is cancelled', () => {
  const h = harness(false);
  assert.equal(h.context.closeDialogs(), false);
  assert.deepEqual(h.calls(), { confirms: 1, closed: 0 });
});
test('ordinary shared close closes once after accepted confirmation', () => {
  const h = harness(true);
  assert.equal(h.context.closeDialogs(), true);
  assert.deepEqual(h.calls(), { confirms: 1, closed: 1 });
});
test('authorized forced close does not ask twice or block a committed cash topup', () => {
  const h = harness(false);
  assert.equal(h.context.closeDialogs({ force: true }), true);
  assert.deepEqual(h.calls(), { confirms: 0, closed: 1 });
});
test('session invalidation, confirmed logout, and successful topup use explicit forced cleanup', () => {
  const login = source.slice(source.indexOf('function showLogin('), source.indexOf('\nfunction hidePreloader('));
  assert.match(login, /closeDialogs\(\{ force: true \}\)/);
  const logout = source.slice(source.indexOf('async function logout('), source.indexOf('\nfunction bindEvents('));
  assert.match(logout, /hasUnsavedDraft\(\).*window\.confirm/);
  assert.match(logout, /closeDialogs\(\{ force: true \}\)/);
  const topup = source.slice(source.indexOf('async function performCashTopup('), source.indexOf('\nasync function performLogin('));
  assert.ok(topup.indexOf('closeDialogs({ force: true })') > topup.indexOf("clearDraft('cash-topup', '')"));
});
