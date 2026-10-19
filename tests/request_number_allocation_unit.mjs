import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { LocalD1 } from './local_financial_db.mjs';
import { reserveRequestNumber } from '../functions/_lib/request-numbers.js';

const input = (overrides = {}) => ({
  id: 'id-1', createdBy: 'user-a', type: 'petty_cash',
  createdAt: '2028-01-31T17:00:00.000Z', idempotencyKey: 'key-1', payloadHash: null, ...overrides
});

function seedUsers(local) {
  for (const [id, role] of [['user-a', 'user'], ['manager-1', 'manager']]) {
    local.db.prepare("INSERT INTO users(id,name,email,position,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, id, `${id}@local`, 'Staff', role, 1, '2028-01-01', '2028-01-01');
  }
}

test('allocates category/month/year at sequence 000001 and retains original on retry with new UUID', async () => {
  const local = new LocalD1();
  seedUsers(local);
  const first = await reserveRequestNumber(local, input());
  assert.equal(first.requestNumber, 'PC022028000001'); // 00:00 WIB on Feb 1
  const retry = await reserveRequestNumber(local, input({ id: 'new-uuid' }));
  assert.deepEqual(retry, first);
  assert.equal(local.db.prepare('SELECT COUNT(*) n FROM request_number_reservations').get().n, 1);
  const rf = await reserveRequestNumber(local, input({ id: 'rf-1', type: 'finance_request', createdAt: '2029-03-01T00:00:00Z', idempotencyKey: 'rf-key' }));
  assert.equal(rf.requestNumber, 'RF032029000001');
});

test('rejects idempotency payload mismatch and preserves the winner', async () => {
  const local = new LocalD1();
  seedUsers(local);
  await reserveRequestNumber(local, input({ payloadHash: 'a'.repeat(64) }));
  await assert.rejects(() => reserveRequestNumber(local, input({ id: 'other', payloadHash: 'b'.repeat(64) })), e => e.status === 409 && e.code === 'idempotency_key_conflict');
  assert.equal(local.db.prepare('SELECT COUNT(*) n FROM request_number_reservations').get().n, 1);
});

test('reports exhaustion at 999999 without reusing an abandoned number', async () => {
  const local = new LocalD1();
  seedUsers(local);
  local.db.prepare('INSERT INTO request_number_sequences(type,year,month,next_value) VALUES (?,?,?,?)').run('petty_cash', 2028, 2, 999999);
  const last = await reserveRequestNumber(local, input({ id: 'last', idempotencyKey: 'last-key' }));
  assert.equal(last.requestNumber, 'PC022028999999');
  await assert.rejects(() => reserveRequestNumber(local, input({ id: 'overflow', idempotencyKey: 'overflow-key' })), e => e.status === 409 && e.code === 'request_number_exhausted');
  assert.equal(local.db.prepare("SELECT COUNT(*) n FROM request_number_reservations WHERE request_number LIKE '%999999'").get().n, 1);
});

test('returns schema-required 503 rather than masking an unapplied migration', async () => {
  const broken = { prepare() { return { bind() { return this; }, async first() { throw new Error('no such table: request_number_reservations'); } }; } };
  await assert.rejects(() => reserveRequestNumber(broken, input()), e => e.status === 503 && e.code === 'request_number_schema_required');
});

test('active user and manager parent permissions remain enforced by local submission guards', async () => {
  const local = new LocalD1();
  seedUsers(local);
  local.db.prepare("INSERT INTO users(id,name,email,position,role,is_active,created_at,updated_at) VALUES ('inactive','Inactive','inactive@local','Staff','user',0,'2028-01-01','2028-01-01')").run();
  const managerReservation = await reserveRequestNumber(local, input({ id: 'manager-request', createdBy: 'manager-1', idempotencyKey: 'manager-key' }));
  local.db.prepare(`INSERT INTO submissions(id,idempotency_key,created_by,type,status,amount_idr,date,description,note,decision_reason,created_at,updated_at,request_number)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(managerReservation.id, 'manager-key', 'manager-1', 'petty_cash', 'pending', 100, '2028-02-01', 'Manager request', '', '', '2028-01-31T17:00:00.000Z', '2028-01-31T17:00:00.000Z', managerReservation.requestNumber);
  const inactive = await reserveRequestNumber(local, input({ id: 'inactive-request', createdBy: 'inactive', idempotencyKey: 'inactive-key' }));
  assert.throws(() => local.db.prepare(`INSERT INTO submissions(id,idempotency_key,created_by,type,status,amount_idr,date,description,created_at,updated_at,request_number) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(inactive.id,'inactive-key','inactive','petty_cash','pending',100,'2028-02-01','Inactive request','2028-01-31T17:00:00.000Z','2028-01-31T17:00:00.000Z',inactive.requestNumber), /active_account_required_to_submit/);
});

test('npm test wrapper runs the offline migration suite as well', () => {
  const run = spawnSync('python3', ['-B', 'tests/request_numbers_migration_unit.py'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test('actual helper allocates unique concurrent reservations and coalesces simultaneous retries', async () => {
  const local = new LocalD1(); seedUsers(local);
  // D1 serializes transactional batches. Model that behavior around the local
  // SQLite adapter while leaving the production helper's reads/races intact.
  const batch = local.batch.bind(local); let queue = Promise.resolve();
  local.batch = statements => { const result = queue.then(() => batch(statements)); queue = result.catch(() => {}); return result; };
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => reserveRequestNumber(local, input({ id: `concurrent-${i}`, idempotencyKey: `concurrent-key-${i}` }))));
  assert.equal(new Set(results.map(row => row.requestNumber)).size, 24);
  assert.deepEqual(results.map(row => Number(row.requestNumber.slice(8, 14))).sort((a,b) => a-b), Array.from({ length: 24 }, (_, i) => i+1));
  assert.equal(local.db.prepare('SELECT COUNT(*) n FROM submissions').get().n, 0);
  const retries = await Promise.all(Array.from({ length: 8 }, (_, i) => reserveRequestNumber(local, input({ id: `retry-${i}`, idempotencyKey: 'one-shared-key' }))));
  assert.equal(new Set(retries.map(row => row.id)).size, 1);
  assert.equal(new Set(retries.map(row => row.requestNumber)).size, 1);
  assert.equal(retries[0].requestNumber, 'PC022028000025');
  assert.equal(local.db.prepare('SELECT COUNT(*) n FROM request_number_reservations').get().n, 25);
  assert.equal(local.db.prepare('SELECT next_value FROM request_number_sequences').get().next_value, 26);
});

test('category and every WIB month/year have independent sequences', async () => {
  const local = new LocalD1(); seedUsers(local);
  const specs = [
    ['pc-feb', 'petty_cash', '2028-02-01T00:00:00Z', 'PC022028000001'],
    ['rf-feb', 'finance_request', '2028-02-01T00:00:00Z', 'RF022028000001'],
    ['pc-mar', 'petty_cash', '2028-03-01T00:00:00Z', 'PC032028000001'],
    ['pc-next-year', 'petty_cash', '2029-02-01T00:00:00Z', 'PC022029000001'],
    ['pc-feb-again', 'petty_cash', '2028-02-02T00:00:00Z', 'PC022028000002'],
  ];
  for (const [id,type,createdAt,expected] of specs) assert.equal((await reserveRequestNumber(local, input({ id, type, createdAt, idempotencyKey: id }))).requestNumber, expected);
});
