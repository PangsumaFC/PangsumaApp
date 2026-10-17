import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../functions/api/[[path]].js';
import { sha256Hex } from '../functions/_lib/auth.js';

class LocalD1 {
  constructor(files) {
    this.db = new DatabaseSync(':memory:');
    for (const file of files) this.db.exec(fs.readFileSync(`migrations/${file}`, 'utf8'));
  }
  prepare(sql) {
    const db = this.db;
    let args = [];
    const statement = {
      bind(...values) { args = values; return statement; },
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes || 0) } }; }
    };
    return statement;
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { for (const statement of statements) await statement.run(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

async function seededDb(includeTopups = true) {
  const files = ['0001_initial.sql', '0002_passkey_auth.sql', '0003_user_profiles.sql', '0004_manager_submissions.sql'];
  if (includeTopups) files.push('0005_cash_topups.sql');
  const db = new LocalD1(files);
  const token = 'local-manager-token';
  const sessionHash = await sha256Hex(token);
  db.db.prepare(`INSERT INTO users (id,name,email,position,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run('manager-1', 'Manager Test', 'manager@test.local', 'Manager', 'manager', '2028-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z');
  db.db.prepare('INSERT INTO user_profiles (user_id) VALUES (?)').run('manager-1');
  db.db.prepare('INSERT INTO sessions (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
    .run(sessionHash, 'manager-1', '2028-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
  return { db, token };
}

async function call(db, token, body, key) {
  const response = await onRequest({
    request: new Request('https://local.test/api/cash/topups', {
      method: 'POST',
      headers: {
        Origin: 'https://local.test',
        Cookie: `__Host-pangsuma_session=${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key
      },
      body: JSON.stringify(body)
    }),
    env: { DB: db }
  });
  return { response, payload: await response.json() };
}

test('cash topup migration preserves opening row and atomically updates account, ledger, and audit', async () => {
  const { db, token } = await seededDb();
  const first = await call(db, token, { amountIdr: 12500, note: 'Tambahan kas operasional' }, 'topup-key-1');
  assert.equal(first.response.status, 201);
  assert.equal(first.payload.alreadyApplied, false);
  assert.equal(first.payload.topup.amountIdr, 12500);
  assert.equal(first.payload.topup.actorName, 'Manager Test');
  assert.equal(db.db.prepare("SELECT balance_idr FROM cash_accounts WHERE id='operational'").get().balance_idr, 12500);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM cash_ledger WHERE event_type='cash_topup'").get().n, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='cash.topup_created'").get().n, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM cash_ledger WHERE event_type='opening_balance'").get().n, 1);

  const retry = await call(db, token, { amountIdr: 12500, note: 'Tambahan kas operasional' }, 'topup-key-1');
  assert.equal(retry.response.status, 200);
  assert.equal(retry.payload.alreadyApplied, true);
  assert.equal(retry.payload.topup.id, first.payload.topup.id);
  assert.equal(db.db.prepare("SELECT balance_idr FROM cash_accounts WHERE id='operational'").get().balance_idr, 12500);

  const mismatch = await call(db, token, { amountIdr: 13000, note: 'Isi berbeda' }, 'topup-key-1');
  assert.equal(mismatch.response.status, 409);
  assert.equal(mismatch.payload.error.code, 'idempotency_key_reused');
  assert.throws(() => db.db.prepare('UPDATE cash_topups SET note=?').run('mutated'), /cash_topups_are_append_only/);
  assert.throws(() => db.db.prepare('UPDATE cash_ledger SET note=?').run('mutated'), /cash_ledger_is_append_only/);
});

test('topup route fails closed when 0005 is absent', async () => {
  const { db, token } = await seededDb(false);
  const result = await call(db, token, { amountIdr: 100, note: 'Kas' }, 'missing-migration');
  assert.equal(result.response.status, 503);
  assert.equal(result.payload.error.code, 'migration_required');
});

test('topup rejects invalid amounts and notes without changing any financial data', async () => {
  const { db, token } = await seededDb();
  for (const amountIdr of [0, -1, 1.5, '100', Number.MAX_SAFE_INTEGER + 1]) {
    const result = await call(db, token, { amountIdr, note: 'Dana operasional' }, `invalid-${amountIdr}`);
    assert.equal(result.response.status, 400);
  }
  for (const note of ['', 'ab', 'a'.repeat(501)]) {
    assert.equal((await call(db, token, { amountIdr: 100, note }, 'invalid-note')).response.status, 400);
  }
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM cash_topups').get().n, 0);
  assert.equal(db.db.prepare("SELECT balance_idr FROM cash_accounts WHERE id='operational'").get().balance_idr, 0);
});

test('topup rejects unauthorized, cross-origin, and unsupported-method requests', async () => {
  const { db, token } = await seededDb();
  const send = (method, origin, cookie) => onRequest({ request: new Request('https://local.test/api/cash/topups', {
    method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'security-test' },
    body: method === 'POST' ? JSON.stringify({ amountIdr: 100, note: 'Dana operasional' }) : undefined
  }), env: { DB: db } });
  const cookie = `__Host-pangsuma_session=${token}`;
  assert.equal((await send('POST', 'https://local.test', '')).status, 401);
  assert.equal((await send('POST', 'https://evil.invalid', cookie)).status, 403);
  assert.equal((await send('GET', 'https://local.test', cookie)).status, 405);
  db.db.prepare("UPDATE users SET role='user' WHERE id='manager-1'").run();
  assert.equal((await send('POST', 'https://local.test', cookie)).status, 403);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM cash_topups').get().n, 0);
});

test('overflow and failed audit insertion roll back the entire topup transaction', async () => {
  const { db, token } = await seededDb();
  db.db.prepare("UPDATE cash_accounts SET balance_idr=? WHERE id='operational'").run(Number.MAX_SAFE_INTEGER);
  assert.equal((await call(db, token, { amountIdr: 1, note: 'Dana overflow' }, 'overflow')).response.status, 409);
  db.db.prepare("UPDATE cash_accounts SET balance_idr=0 WHERE id='operational'").run();
  db.db.exec("CREATE TRIGGER test_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action='cash.topup_created' BEGIN SELECT RAISE(ABORT, 'fixture_audit_failure'); END;");
  assert.equal((await call(db, token, { amountIdr: 100, note: 'Dana rollback' }, 'rollback')).response.status, 500);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM cash_topups').get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM cash_ledger WHERE event_type='cash_topup'").get().n, 0);
  assert.equal(db.db.prepare("SELECT balance_idr FROM cash_accounts WHERE id='operational'").get().balance_idr, 0);
});

test('migration preserves nonempty financial history and approval debit triggers continue working', async () => {
  const { db } = await seededDb(false);
  db.db.exec(`UPDATE cash_accounts SET balance_idr=1000 WHERE id='operational';
    INSERT INTO cash_ledger(event_type,direction,amount_idr,balance_after_idr,note,created_at) VALUES('opening_balance','credit',1000,1000,'Saldo aktual','2028-01-01T00:00:00.000Z');
    INSERT INTO submissions(id,idempotency_key,created_by,type,status,amount_idr,date,description,created_at,updated_at) VALUES('existing-report','existing-key','manager-1','petty_cash','pending',100,'2028-01-01','Pembelian lama','2028-01-01T00:00:00.000Z','2028-01-01T00:00:00.000Z');
    UPDATE submissions SET status='approved',updated_by='manager-1' WHERE id='existing-report';`);
  const columns = 'id,event_type,direction,amount_idr,balance_after_idr,submission_id,actor_id,note,created_at';
  const before = db.db.prepare(`SELECT ${columns} FROM cash_ledger ORDER BY id`).all();
  const audits = db.db.prepare('SELECT id,action,entity_id,details_json FROM audit_events ORDER BY id').all();
  db.db.exec(fs.readFileSync('migrations/0005_cash_topups.sql', 'utf8'));
  assert.deepEqual(db.db.prepare(`SELECT ${columns} FROM cash_ledger ORDER BY id`).all(), before);
  assert.deepEqual(db.db.prepare('SELECT id,action,entity_id,details_json FROM audit_events ORDER BY id').all(), audits);
  db.db.exec(`INSERT INTO submissions(id,idempotency_key,created_by,type,status,amount_idr,date,description,created_at,updated_at) VALUES('after-migration','after-key','manager-1','petty_cash','pending',200,'2028-01-01','Pembelian baru','2028-01-01T00:00:00.000Z','2028-01-01T00:00:00.000Z'); UPDATE submissions SET status='approved',updated_by='manager-1' WHERE id='after-migration';`);
  assert.equal(db.db.prepare("SELECT balance_idr FROM cash_accounts WHERE id='operational'").get().balance_idr, 700);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM cash_ledger WHERE submission_id='after-migration'").get().n, 1);
  assert.equal(db.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('partially applied migration without the posting trigger fails closed', async () => {
  const { db, token } = await seededDb();
  db.db.exec('DROP TRIGGER cash_topup_ledger_and_account');
  const result = await call(db, token, { amountIdr: 100, note: 'Dana operasional' }, 'partial-migration');
  assert.equal(result.response.status, 503);
  assert.equal(result.payload.error.code, 'migration_required');
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM cash_topups').get().n, 0);
});
