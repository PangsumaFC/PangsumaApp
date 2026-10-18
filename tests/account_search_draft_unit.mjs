import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { onRequest } from '../functions/api/[[path]].js';
import { request, seededFinancialDb } from './local_financial_db.mjs';
const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');

async function call(db, path, token) {
  const response = await onRequest({ request: request(path, token), env: { DB: db } });
  return { response, body: await response.json() };
}

test('account search is server-backed, parameterized, and retains query across pagination', () => {
  assert.match(app, /usersSearch/);
  assert.match(app, /setTimeout\(\(\) =>/);
  assert.match(app, /await loadUsersPageView\(next\)/);
  assert.match(app, /async function loadUsersPageView\(page = state\.usersPage\.page \|\| 1, query = state\.usersPage\.query \|\| ''\)/);
  assert.match(api, /users\.name LIKE \? ESCAPE/);
  assert.match(api, /users\.email LIKE \? ESCAPE/);
  assert.match(api, /SELECT COUNT\(\*\) AS count FROM users/);
  assert.match(api, /searchPattern/);
});

test('account form draft persists only non-password fields through form.elements', () => {
  assert.match(app, /function persistAccountDraft/);
  assert.match(app, /form\.elements/);
  assert.match(app, /namedItem\('name'\)/);
  assert.match(app, /clearDraft\(accountDraftKey\(\)\)/);
  assert.match(app, /Buang draf akun ini/);
  assert.doesNotMatch(app.slice(app.indexOf('function persistAccountDraft'), app.indexOf('function accountDraftPresent') + 80), /password/i);
});

test('users endpoint returns filtered totals and treats LIKE wildcards literally', async () => {
  const { db, managerToken } = await seededFinancialDb();
  db.db.prepare("UPDATE users SET name='100%_literal' WHERE id='user-b'").run();
  const literal = await call(db, '/users?page=1&limit=1&q=100%25_&', managerToken);
  assert.equal(literal.response.status, 200);
  assert.equal(literal.body.total, 1);
  assert.equal(literal.body.users[0].name, '100%_literal');
  const page = await call(db, '/users?page=2&limit=1&q=', managerToken);
  assert.equal(page.response.status, 200);
  assert.equal(page.body.page, 2);
  assert.equal(page.body.total, 3);
  assert.equal(page.body.hasMore, true);
});
