import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
test('account search is server-backed and retains query across pagination', () => {
  assert.match(app, /usersSearch/);
  assert.match(app, /setTimeout\(\(\) =>/);
  assert.match(app, /refreshUsersPage\(next, false, state\.usersPage\.query\)/);
  assert.match(api, /users\.name LIKE \? COLLATE NOCASE/);
  assert.match(api, /users\.email LIKE \? COLLATE NOCASE/);
});
test('account form draft persists only non-password fields and clears on success/discard', () => {
  assert.match(app, /function persistAccountDraft/);
  assert.match(app, /name: String\(form\.name/);
  assert.match(app, /clearDraft\(accountDraftKey\(\)\)/);
  assert.match(app, /Buang draf akun ini/);
  assert.doesNotMatch(app.slice(app.indexOf('function persistAccountDraft'), app.indexOf('function accountDraftPresent') + 80), /password/i);
});
