import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../functions/api/[[path]].js';

const manager = { id: 'manager-1', name: 'Manager One', email: 'manager@example.test', position: 'Manager', role: 'manager', must_change_password: 0, nickname: '', dashboard_position: null, quote: '', has_photo: 0, profile_version: 1, expires_at: '2099-01-01T00:00:00.000Z', auth_method: 'password' };
function fakeDb(user = manager) {
  const calls = [];
  return { calls, prepare(sql) { calls.push(sql); const statement = { bind() { return statement; }, async all() { return { results: [] }; }, async first() { return /FROM sessions/.test(sql) ? user : null; }, async run() { return { meta: { changes: 0 } }; } }; return statement; } };
}
async function call(db, cookie = '__Host-pangsuma_session=local-test-token') {
  const request = new Request('https://local.test/api/export.csv', { headers: cookie ? { Cookie: cookie } : {} });
  return onRequest({ request, env: { DB: db } });
}

test('removed CSV endpoint is 404 for manager', async () => {
  const db = fakeDb(); const response = await call(db);
  assert.equal(response.status, 404);
});
test('removed CSV endpoint is 404 for regular user and anonymous requests', async () => {
  for (const cookie of ['__Host-pangsuma_session=local-test-token', '']) {
    const db = fakeDb(cookie ? { ...manager, role: 'user' } : manager);
    const response = await call(db, cookie);
    assert.equal(response.status, 404);
  }
});
