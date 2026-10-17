import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { LocalD1 } from './local_financial_db.mjs';
import { createCashReconciliation, getCashReconciliations } from '../functions/_lib/cash-reconciliation.js';

const FILES = ['0001_initial.sql', '0002_passkey_auth.sql', '0003_user_profiles.sql', '0004_manager_submissions.sql', '0005_cash_topups.sql'];
const manager = { id: 'manager-1', name: 'Manager Test', role: 'manager' };
const regular = { id: 'user-a', name: 'User Alpha', role: 'user' };

// Migration is loaded explicitly so every test exercises the real 0006 file.
function makeDb() { const db = new LocalD1(FILES); db.db.exec(fs.readFileSync('migrations/0006_financial_controls.sql', 'utf8')); return db; }
function seed(db) {
  db.db.exec("INSERT INTO users (id,name,email,position,role,must_change_password,created_at,updated_at) VALUES ('manager-1','Manager Test','manager@test.local','Manager','manager',0,'2028-01-01T00:00:00.000Z','2028-01-01T00:00:00.000Z'),('user-a','User Alpha','alpha@test.local','Bendahara','user',0,'2028-01-01T00:00:00.000Z','2028-01-01T00:00:00.000Z'); INSERT INTO user_profiles(user_id) VALUES ('manager-1'),('user-a');");
}
function fresh() { const db = makeDb(); seed(db); return db; }
function req(body, key = 'recon-key') { return new Request('https://local.test/api/cash/reconciliations', { method: 'POST', headers: { Origin: 'https://local.test', 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }); }
async function create(db, body = { period: '2025-12', physicalCashIdr: 0, note: 'Tutup buku' }, key = 'recon-key', actor = manager) {
  const payload = { period: '2025-12', physicalCashIdr: 0, note: 'Tutup buku', ...body, confirmed: body.confirmed ?? true };
  return createCashReconciliation({ request: req(payload, key) }, db, actor);
}
async function errorOf(promise, status, code) { await assert.rejects(promise, e => { assert.equal(e.status, status); if (code) assert.equal(e.code, code); return true; }); }
function addLedger(db, amount, date = '2025-12-15T00:00:00.000Z', direction = 'credit') { db.db.prepare('INSERT INTO cash_ledger(event_type,direction,amount_idr,balance_after_idr,note,created_at) VALUES (?,?,?,?,?,?)').run('cash_topup', direction, amount, amount, 'fixture', date); }

test('aggregates whole ledger in 500-row pages with exact BigInt strings', async () => {
  const db = fresh();
  for (let i = 0; i < 501; i++) addLedger(db, 9007199254740 + (i === 500 ? 1 : 0));
  const total = 9007199254740n * 501n + 1n;
  db.db.prepare("UPDATE cash_accounts SET balance_idr=?, updated_at=? WHERE id='operational'").run(Number(total), '2025-12-31T00:00:00Z');
  const response = await create(db, { period: '2025-12', physicalCashIdr: total.toString(), note: 'BigInt page test' });
  assert.equal(response.status, 201);
  const row = (await response.json()).reconciliation;
  assert.equal(row.ledgerBalanceIdr, total.toString());
  assert.equal(row.physicalCashIdr, total.toString());
});

test('uses WIB historical cutoff and excludes future ledger rows', async () => {
  const db = fresh(); addLedger(db, 100, '2025-12-31T16:59:59.999Z'); addLedger(db, 900, '2026-01-01T00:00:00.000Z');
  db.db.prepare("UPDATE cash_accounts SET balance_idr=100 WHERE id='operational'").run();
  const row = (await (await create(db, { period: '2025-12', physicalCashIdr: 100, note: 'WIB cutoff' })).json()).reconciliation;
  assert.equal(row.ledgerBalanceIdr, '100'); assert.equal(row.ledgerCutoffId, 2);
  assert.equal(row.asOf, '2025-12-31T16:59:59.999Z');
});

test('records historical balance while current account legitimately differs', async () => {
  const db = fresh(); addLedger(db, 100); db.db.prepare("UPDATE cash_accounts SET balance_idr=150 WHERE id='operational'").run();
  const row = (await (await create(db, { physicalCashIdr: 100, note: 'Account differs' })).json()).reconciliation;
  assert.equal(row.ledgerBalanceIdr, '100'); assert.equal(row.accountBalanceIdr, '150'); assert.equal(row.discrepancyIdr, '0');
});

test('captures cutoff id snapshot and audit actor metadata', async () => {
  const db = fresh(); addLedger(db, 25); db.db.prepare("UPDATE cash_accounts SET balance_idr=25 WHERE id='operational'").run();
  const response = await create(db, { physicalCashIdr: 25, note: 'Snapshot metadata' }, 'snapshot-key'); const row = (await response.json()).reconciliation;
  assert.equal(row.ledgerCutoffId, 2); assert.equal(row.managerId, 'manager-1');
  const audit = db.db.prepare("SELECT actor_id,action,entity_id,created_at,details_json FROM audit_events WHERE action='cash.reconciled'").get();
  assert.equal(audit.actor_id, 'manager-1'); assert.equal(audit.entity_id, row.id); assert.equal(JSON.parse(audit.details_json).note, 'Snapshot metadata'); assert.ok(audit.created_at);
});

test('idempotency returns same record exactly once and rejects altered replay', async () => {
  const db = fresh(); const first = await create(db, undefined, 'same-key'); const p1 = await first.json();
  const retry = await create(db, undefined, 'same-key'); const p2 = await retry.json(); assert.equal(retry.status, 200); assert.equal(p2.alreadyApplied, true); assert.equal(p2.reconciliation.id, p1.reconciliation.id);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM cash_reconciliations").get().n, 1); assert.equal(db.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='cash.reconciled'").get().n, 1);
  await errorOf(create(db, { period: '2025-12', physicalCashIdr: 1, note: 'Altered replay' }, 'same-key'), 409, 'idempotency_key_reused');
});

test('authorization rejects regular users, missing actors, and non-manager parent roles', async () => {
  const db = fresh(); await errorOf(create(db, undefined, 'user-key', regular), 403, 'manager_only');
  await errorOf(create(db, undefined, 'missing-key', null), 403, 'manager_only');
  await errorOf(getCashReconciliations(db, { id: 'manager-1', role: 'owner' }), 403, 'manager_only');
});

test('fails closed when migration 0006 is missing', async () => {
  const db = new LocalD1(FILES); seed(db); await errorOf(create(db), 503, 'migration_required');
});

test('rejects invalid periods, current/future periods, physical values, and notes', async () => {
  const db = fresh();
  for (const period of ['2028-13', '2026-10', '2027-01', 'nope']) await errorOf(create(db, { period, physicalCashIdr: 0, note: 'Valid note' }, `period-${period}`), 400);
  for (const physicalCashIdr of [-1, 1.5, '1.2', '9007199254740992', Number.MAX_SAFE_INTEGER + 1]) await errorOf(create(db, { physicalCashIdr, note: 'Valid note' }, `physical-${String(physicalCashIdr)}`), 400);
  for (const note of ['', 'ab', 'x'.repeat(1001)]) await errorOf(create(db, { physicalCashIdr: 0, note }, `note-${note.length}`), 400);
});

test('reconciliation rows are append-only', async () => {
  const db = fresh(); const row = (await (await create(db)).json()).reconciliation;
  assert.throws(() => db.db.prepare('UPDATE cash_reconciliations SET note=? WHERE id=?').run('mutated', row.id), /cash_reconciliations_are_append_only/);
  assert.throws(() => db.db.prepare('DELETE FROM cash_reconciliations WHERE id=?').run(row.id), /cash_reconciliations_are_append_only/);
});

test('GET paginates 21 records with stable cursor and period filter-compatible unique rows', async () => {
  const db = fresh();
  for (let i = 0; i < 21; i++) await create(db, { period: '2025-12', physicalCashIdr: i, note: `Record ${i}` }, `page-${i}`);
  const first = await getCashReconciliations(db, manager, new URLSearchParams('limit=20')); const p1 = await first.json();
  assert.equal(p1.reconciliations.length, 20); assert.ok(p1.nextCursor);
  const second = await getCashReconciliations(db, manager, new URLSearchParams(`limit=20&cursor=${encodeURIComponent(p1.nextCursor)}`)); const p2 = await second.json();
  assert.equal(p2.reconciliations.length, 1); assert.equal(p2.nextCursor, null);
  const ids = [...p1.reconciliations, ...p2.reconciliations].map(x => x.id); assert.equal(new Set(ids).size, 21);
  assert.deepEqual(p2.reconciliations[0].period, '2025-12');
});
