import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0);
  const next = source.indexOf('\n}', start);
  assert.ok(next > start);
  return source.slice(start, next + 2);
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function resetHarness() {
  const gate = deferred(), calls = [], messages = [];
  const form = { reportValidity: () => true, reset() {} };
  const context = vm.createContext({
    resetTargetId: 'account-a', state: { users: [{ id: 'account-a', email: 'a@local.test' }, { id: 'account-b', email: 'b@local.test' }] },
    $: selector => selector === '#userPasswordForm' ? form : { value: 'Only-a-local-test-password' },
    setButtonBusy() {}, PasswordCrypto: { deriveWithRandomSalt: () => gate.promise },
    api: async (...args) => { calls.push(args); }, closeDialogs() {}, renderAfterMutation: async () => {},
    friendlyError: e => e.message, showToast: text => messages.push(text), encodeURIComponent,
  });
  vm.runInContext(functionSource('performUserPasswordReset'), context);
  return { context, calls, messages, gate, run: () => context.performUserPasswordReset({ preventDefault() {} }) };
}
test('password reset never retargets an in-flight derivation from A to B', async () => {
  const h = resetHarness(); const pending = h.run();
  h.context.resetTargetId = 'account-b'; h.gate.resolve({ derived: 'fixture' }); await pending;
  assert.equal(h.calls.length, 0);
  assert.ok(h.messages.some(m => /Target akun berubah/.test(m)));
});
test('password reset also rejects changed account identity while target id stays stable', async () => {
  const h = resetHarness(); const pending = h.run();
  h.context.state.users[0].email = 'replacement@local.test'; h.gate.resolve({ derived: 'fixture' }); await pending;
  assert.equal(h.calls.length, 0);
});
test('stable reset target submits exactly once to the captured target', async () => {
  const h = resetHarness(); const pending = h.run(); h.gate.resolve({ derived: 'fixture' }); await pending;
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], '/users/account-a/password');
});
test('committed mutation with failed refresh retains success and explicit refresh warning', async () => {
  const messages = []; let renders = 0;
  const context = vm.createContext({ state: { user: { id: 'manager' } }, refreshOverview: async () => { throw new Error('offline'); }, renderApp: () => renders++, showToast: text => messages.push(text) });
  vm.runInContext(functionSource('renderAfterMutation'), context);
  assert.equal(await context.renderAfterMutation('Tersimpan', 'Tersimpan; ringkasan belum diperbarui'), false);
  assert.equal(renders, 1); assert.deepEqual(messages, ['Tersimpan; ringkasan belum diperbarui']);
});
test('refresh completing after account/session switch does not claim mutation success in new session', async () => {
  const messages = []; const error = Object.assign(new Error('changed'), { code: 'session_changed' });
  const context = vm.createContext({ state: { user: { id: 'other' } }, refreshOverview: async () => { throw error; }, renderApp() { throw new Error('must not render'); }, showToast: text => messages.push(text) });
  vm.runInContext(functionSource('renderAfterMutation'), context);
  assert.equal(await context.renderAfterMutation('Tersimpan'), false); assert.equal(messages.length, 0);
});
