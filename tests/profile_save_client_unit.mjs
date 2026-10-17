import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function performUserProfileSave('), source.indexOf('\nfunction setConfirm('));
function harness({ conflict = false } = {}) {
  const calls = { closed: 0, toasts: [], renders: 0 };
  const controls = [{ disabled: false }];
  const errorBox = { hidden: true };
  const form = { reportValidity: () => true, querySelectorAll: () => controls };
  const updated = { id: 'target', nickname: 'Baru', profileVersion: 2, photoUrl: '/api/users/target/photo?v=2' };
  const draft = { id: 'target', profileVersion: 1, photoDataUrl: 'data:image/jpeg;base64,local' };
  const context = vm.createContext({
    profileDraft: draft, authEpoch: 1,
    state: { user: { id: 'manager', role: 'manager' }, users: [{ id: 'target', active: true, profileVersion: 1 }] },
    $: selector => selector === '#userProfileForm' ? form : selector === '#profileError' ? errorBox : selector === '#userProfileDialog' ? { close() { calls.closed++; } } : { value: '', focus() {} },
    setButtonBusy() {},
    api: async () => { if (conflict) throw Object.assign(Error('conflict'), { code: 'profile_conflict' }); return { user: updated }; },
    refreshOverview: async () => { throw Error('refresh offline'); },
    renderApp() { calls.renders++; }, showToast(text) { calls.toasts.push(text); }, friendlyError: e => e.message
  });
  vm.runInContext(code, context);
  return { calls, errorBox, draft, context, save: () => context.performUserProfileSave({ preventDefault() {} }) };
}
test('profil tersimpan tetap dikonfirmasi ketika refresh ringkasan gagal', async () => {
  const h = harness();
  await h.save();
  assert.equal(h.calls.closed, 1);
  assert.equal(h.errorBox.hidden, true);
  assert.equal(h.context.state.users[0].profileVersion, 2);
  assert.equal(h.context.state.users[0].active, true);
  assert.match(h.calls.toasts[0], /tersimpan/i);
});
test('konflik profil asli tetap mempertahankan dialog dan draf', async () => {
  const h = harness({ conflict: true });
  await h.save();
  assert.equal(h.calls.closed, 0);
  assert.equal(h.draft.conflicted, true);
  assert.equal(h.errorBox.hidden, false);
});
