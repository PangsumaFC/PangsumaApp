import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
function renderWelcome(user) {
  const sandbox = { document: { querySelector: () => null }, Intl, Date, String, Number, Boolean, Array, JSON, Math };
  vm.createContext(sandbox);
  vm.runInContext(source.replace('initialize();', `state.user=${JSON.stringify(user)}; globalThis.__html=welcomePanel();`), sandbox);
  return sandbox.__html;
}

test('dashboard avatar is one accessible preview trigger for Manager and User', () => {
  for (const role of ['manager', 'user']) {
    const html = renderWelcome({ id: `${role}-1`, role, name: role === 'manager' ? 'Manager' : 'User' });
    assert.equal((html.match(/data-action="preview-avatar"/g) || []).length, 1);
    assert.match(html, /aria-label="Lihat foto profil"/);
    assert.doesNotMatch(html, /data-action="edit-user-profile"/);
  }
});

test('Manager profile edit remains available only from Users actions, not dashboard avatar', () => {
  const sourceWithDialog = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(source, /data-action="edit-user-profile" data-id=/);
  assert.match(sourceWithDialog, /id="avatarPreviewDialog"[^>]+aria-labelledby="avatarPreviewTitle"/);
  assert.match(sourceWithDialog, /id="avatarPreviewClose"[^>]+data-action="close-dialog"/);
  assert.match(source, /action === 'preview-avatar'/);
  assert.match(source, /avatarPreviewTrigger = null/);
});

test('Finance has no top-up trigger while dashboard places it below balance description', () => {
  const sandbox = { document: { querySelector: () => null }, window: {}, Intl, Date };
  vm.createContext(sandbox);
  vm.runInContext(source.replace('initialize();', "state.user={id:'m',role:'manager'}; state.summary={}; state.cashFlow={openingConfigured:true}; globalThis.__dashboard=managerOverview(); globalThis.__finance=financePage();"), sandbox);
  assert.equal((sandbox.__dashboard.match(/data-action="open-cash-topup"/g) || []).length, 1);
  assert.ok(sandbox.__dashboard.indexOf('Saldo tersedia') < sandbox.__dashboard.indexOf('data-action="open-cash-topup"'));
  assert.equal((sandbox.__finance.match(/data-action="open-cash-topup"/g) || []).length, 0);
});
