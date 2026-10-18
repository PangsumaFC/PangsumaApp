import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';
import { hashClientCredential } from '../functions/_lib/auth.js';
import { seededFinancialDb } from './local_financial_db.mjs';
const env = { PASSWORD_PEPPER: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
const credential = { version: 'client-pbkdf2-hmac-v1', iterations: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', derived: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', passwordLength: 24 };
async function runLogin({ race = false, deactivate = false } = {}) {
  const { db } = await seededFinancialDb();
  const hash = await hashClientCredential(credential, 'alpha@test.local', env);
  db.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, 'user-a');
  const prepare = db.prepare.bind(db); let inserted = 0;
  db.prepare = sql => {
    const statement = prepare(sql);
    if (/INSERT INTO sessions/.test(sql)) {
      const run = statement.run.bind(statement);
      statement.run = async () => {
        inserted++;
        if (race) {
          db.db.exec('BEGIN');
          if (deactivate) db.db.prepare('UPDATE users SET is_active=0 WHERE id=?').run('user-a');
          else db.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run('rotated-by-manager-before-insert', 'user-a');
          db.db.prepare('DELETE FROM sessions WHERE user_id=?').run('user-a');
          db.db.exec('COMMIT');
        }
        return run();
      };
    }
    return statement;
  };
  const response = await onRequest({ request: new Request('https://local.test/api/auth/login', { method: 'POST', headers: { Origin: 'https://local.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alpha@test.local', credential }) }), env: { DB: db, ...env } });
  return { db, response, inserted };
}
test('login endpoint refuses old credentials when reset commits after verification but before session INSERT', async () => {
  const { db, response, inserted } = await runLogin({ race: true });
  assert.equal(inserted, 1); assert.equal(response.status, 401);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get('user-a').count, 0);
});
test('login endpoint refuses session if account is deactivated at the same async boundary', async () => {
  const { db, response, inserted } = await runLogin({ race: true, deactivate: true });
  assert.equal(inserted, 1); assert.equal(response.status, 401);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get('user-a').count, 0);
});
test('unchanged password login still creates a secure session exactly once', async () => {
  const { response, inserted } = await runLogin();
  assert.equal(response.status, 200); assert.equal(inserted, 1);
  assert.match(response.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Strict/);
});
