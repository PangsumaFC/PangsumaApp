import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { seededFinancialDb, insertSubmission } from './local_financial_db.mjs';
import { getFinancialSettings, updateFinancialSettings, getFinancialAlerts, findPotentialDuplicates } from '../functions/_lib/financial-alerts.js';

const manager = { id: 'manager-1', role: 'manager' };
const alpha = { id: 'user-a', role: 'user' };
const beta = { id: 'user-b', role: 'user' };
const uuid = n => `123e4567-e89b-12d3-a456-42661417400${n}`;

async function fixture(migrate = true) {
  const f = await seededFinancialDb();
  if (migrate) f.db.db.exec(fs.readFileSync(new URL('../migrations/0008_financial_alert_settings.sql', import.meta.url), 'utf8'));
  return f;
}
function code(status, expected) {
  return error => error?.status === status && error?.code === expected;
}
async function configure(db, { cash = '5000', days = 7, version = 0, key = uuid(1), nowISO = '2026-10-18T00:00:00.000Z' } = {}) {
  return updateFinancialSettings({ body: { minimumCashIdr: cash, pendingMaxDays: days, expectedVersion: version }, idempotencyKey: key, nowISO }, db, manager);
}

// Authorization and migration guards are deliberately tested through every public operation.
test('settings and alerts enforce manager-only authorization and migration readiness', async () => {
  const { db } = await fixture(false);
  await assert.rejects(() => getFinancialSettings({}, db, alpha), code(403, 'manager_required'));
  await assert.rejects(() => updateFinancialSettings({ body: { minimumCashIdr: '1', pendingMaxDays: 1, expectedVersion: 0 }, idempotencyKey: uuid(1) }, db, alpha), code(403, 'manager_required'));
  await assert.rejects(() => getFinancialAlerts({}, db, alpha), code(503, 'migration_required'));
  const partial = await fixture();
  partial.db.db.exec(fs.readFileSync(new URL('../migrations/0008_financial_alert_settings.sql', import.meta.url), 'utf8'));
  partial.db.db.exec('DROP TRIGGER financial_settings_manager_guard');
  await assert.rejects(() => getFinancialSettings({}, partial.db, manager), code(503, 'migration_required'));
});

test('settings validation rejects unsafe monetary/day/version/key input and preserves exact safe strings', async () => {
  const { db } = await fixture();
  const saved = await configure(db, { cash: '0000009007199254740991'.replace(/^0+/, ''), days: 3650 });
  assert.equal(saved.minimumCashIdr, '9007199254740991');
  assert.equal(saved.pendingMaxDays, 3650);
  const invalid = [
    [{ minimumCashIdr: 9007199254740992, pendingMaxDays: 1, expectedVersion: 1 }, 'invalid_minimum_cash'],
    [{ minimumCashIdr: '9007199254740992', pendingMaxDays: 1, expectedVersion: 1 }, 'invalid_minimum_cash'],
    [{ minimumCashIdr: '1.5', pendingMaxDays: 1, expectedVersion: 1 }, 'invalid_minimum_cash'],
    [{ minimumCashIdr: '-1', pendingMaxDays: 1, expectedVersion: 1 }, 'invalid_minimum_cash'],
    [{ minimumCashIdr: '', pendingMaxDays: 1, expectedVersion: 1 }, 'invalid_minimum_cash'],
    [{ minimumCashIdr: [], pendingMaxDays: 1, expectedVersion: 1 }, 'invalid_minimum_cash'],
    [{ minimumCashIdr: null, pendingMaxDays: 0, expectedVersion: 1 }, 'invalid_pending_max_days'],
    [{ minimumCashIdr: null, pendingMaxDays: 3651, expectedVersion: 1 }, 'invalid_pending_max_days'],
    [{ minimumCashIdr: null, pendingMaxDays: 1.2, expectedVersion: 1 }, 'invalid_pending_max_days'],
    [{ minimumCashIdr: null, pendingMaxDays: 1, expectedVersion: -1 }, 'invalid_expected_version'],
    [{ minimumCashIdr: null, pendingMaxDays: 1, expectedVersion: 1n }, 'invalid_expected_version'],
    [{ minimumCashIdr: null, pendingMaxDays: 1 }, 'invalid_expected_version'],
    [{ minimumCashIdr: null, pendingMaxDays: 1, expectedVersion: 1, extra: true }, 'invalid_settings'],
    [null, 'invalid_settings'],
    [[], 'invalid_settings']
  ];
  for (const [body, expected] of invalid) {
    await assert.rejects(() => updateFinancialSettings({ body, idempotencyKey: uuid(2) }, db, manager), code(400, expected));
  }
  await assert.rejects(() => updateFinancialSettings({ body: { minimumCashIdr: null, pendingMaxDays: 1, expectedVersion: 1 }, idempotencyKey: 'not-a-uuid' }, db, manager), code(400, 'invalid_idempotency_key'));
});

test('CAS distinguishes stale fresh keys, idempotent replay, wrong payload, and cross-manager replay', async () => {
  const { db } = await fixture();
  await configure(db, { cash: '100', days: 7, key: uuid(1) });
  await assert.rejects(() => configure(db, { cash: '200', days: 7, version: 0, key: uuid(2) }), code(409, 'version_conflict'));
  const replay = await configure(db, { cash: '100', days: 7, version: 0, key: uuid(1) });
  assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.version, 1);
  await assert.rejects(() => configure(db, { cash: '999', days: 7, version: 0, key: uuid(1) }), code(409, 'idempotency_conflict'));
  const same = await configure(db, { cash: '100', days: 7, version: 0, key: uuid(3) });
  assert.equal(same.version, 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM financial_settings_changes').get().n, 1);
  await assert.rejects(() => updateFinancialSettings({ body: { minimumCashIdr: '300', pendingMaxDays: 7, expectedVersion: 1 }, idempotencyKey: uuid(4) }, db, { id: 'user-a', role: 'user' }), code(403, 'manager_required'));
});

test('each real preference change creates exactly one immutable audit record', async () => {
  const { db } = await fixture();
  await configure(db, { cash: '1000', days: 7, key: uuid(1) });
  await configure(db, { cash: '2000', days: 8, version: 1, key: uuid(2) });
  const changes = db.db.prepare('SELECT * FROM financial_settings_changes ORDER BY id').all();
  const audits = db.db.prepare("SELECT * FROM audit_events WHERE action='financial.settings_updated' ORDER BY id").all();
  assert.equal(changes.length, 2);
  assert.equal(audits.length, 2);
  assert.equal(changes[0].version_before, 0);
  assert.equal(changes[1].version_after, 2);
  assert.throws(() => db.db.prepare('UPDATE financial_settings_changes SET manager_id=? WHERE id=1').run('user-a'));
  assert.throws(() => db.db.prepare('DELETE FROM financial_settings_changes WHERE id=1').run());
  assert.throws(() => db.db.prepare("UPDATE financial_alert_settings SET updated_by='user-a'").run());
});

test('unconfigured alerts expose no threshold/items, users receive privacy-safe cash, and account absence is unavailable', async () => {
  const { db } = await fixture();
  insertSubmission(db, { id: 'pending-a', createdBy: 'user-a', createdAt: '2026-10-01T00:00:00.000Z' });
  insertSubmission(db, { id: 'pending-b', createdBy: 'user-b', createdAt: '2026-10-01T00:00:00.000Z' });
  const before = await getFinancialAlerts({ nowISO: '2026-10-18T00:00:00.000Z' }, db, alpha);
  assert.deepEqual(before.pending.items, []);
  assert.equal(before.cash.balanceIdr, null);
  await configure(db, { cash: null, days: 7 });
  const user = await getFinancialAlerts({ nowISO: '2026-10-18T00:00:00.000Z' }, db, alpha);
  assert.equal(user.pending.totalPending, 1);
  assert.equal(user.pending.items[0].id, 'pending-a');
  assert.equal(user.cash.balanceIdr, null);
  db.db.prepare("DELETE FROM cash_accounts WHERE id='operational'").run();
  await assert.rejects(() => getFinancialAlerts({}, db, manager), code(503, 'account_unavailable'));
});

test('alerts use created_at, strict threshold boundary, user scoping, and stable 25-row cursor pages', async () => {
  const { db } = await fixture();
  await configure(db, { cash: '0', days: 7 });
  db.db.prepare("UPDATE cash_accounts SET balance_idr=0 WHERE id='operational'").run();
  insertSubmission(db, { id: 'boundary', createdBy: 'user-a', date: '2026-01-01', createdAt: '2026-10-11T00:00:00.000Z' });
  insertSubmission(db, { id: 'overdue', createdBy: 'user-a', date: '2020-01-01', createdAt: '2026-10-10T23:59:59.000Z' });
  for (let i = 0; i < 26; i++) {
    const createdAt = new Date(Date.parse('2026-09-10T00:00:00.000Z') + i * 86400000).toISOString();
    insertSubmission(db, { id: `page-${String(i).padStart(2, '0')}`, createdBy: 'user-a', createdAt });
  }
  insertSubmission(db, { id: 'other-owner', createdBy: 'user-b', createdAt: '2026-10-01T00:00:00.000Z' });
  const first = await getFinancialAlerts({ nowISO: '2026-10-18T00:00:00.000Z' }, db, alpha);
  const managerView = await getFinancialAlerts({ nowISO: '2026-10-18T00:00:00.000Z' }, db, manager);
  assert.equal(managerView.cash.isLow, false); // strict balance < threshold, equality is not low
  assert.equal(first.pending.totalPending, 28);
  assert.equal(first.pending.overdueCount, 28);
  assert.equal(first.pending.items.length, 25);
  assert.equal(first.pending.items[0].id, 'page-00');
  assert.equal(first.pending.items[0].waitingDays, 38);
  assert.equal(first.pending.hasMore, true);
  const second = await getFinancialAlerts({ nowISO: '2030-01-01T00:00:00.000Z', cursor: first.pending.nextCursor }, db, alpha);
  assert.equal(second.checkedAt, first.checkedAt);
  assert.equal(second.pending.items.length, 3);
  assert.equal(new Set([...first.pending.items, ...second.pending.items].map(x => x.id)).size, 28);
  await assert.rejects(() => getFinancialAlerts({ cursor: first.pending.nextCursor }, db, beta), code(400, 'invalid_cursor'));
  await assert.rejects(() => getFinancialAlerts({ cursor: first.pending.nextCursor.slice(0, -1) + '!' }, db, alpha), code(400, 'invalid_cursor'));
});

test('duplicate search is bounded, private, date/amount/type exact, normalized, and read-only', async () => {
  const { db } = await fixture();
  const before = {
    submissions: db.db.prepare('SELECT COUNT(*) n FROM submissions').get().n,
    audits: db.db.prepare('SELECT COUNT(*) n FROM audit_events').get().n,
    ledger: db.db.prepare('SELECT COUNT(*) n FROM cash_ledger').get().n
  };
  insertSubmission(db, { id: 'unicode', createdBy: 'user-a', type: 'finance_request', amount: 501, date: '2024-02-29', description: 'Kopi—dan  café untuk tim' });
  insertSubmission(db, { id: 'wrong-amount', createdBy: 'user-a', type: 'finance_request', amount: 502, date: '2024-02-29', description: 'Kopi dan cafe untuk tim' });
  insertSubmission(db, { id: 'wrong-type', createdBy: 'user-a', type: 'petty_cash', amount: 501, date: '2024-02-29', description: 'Kopi dan cafe untuk tim' });
  insertSubmission(db, { id: 'wrong-date', createdBy: 'user-a', type: 'finance_request', amount: 501, date: '2024-03-04', description: 'Kopi dan cafe untuk tim' });
  insertSubmission(db, { id: 'private', createdBy: 'user-b', type: 'finance_request', amount: 501, date: '2024-02-29', description: 'Kopi dan cafe untuk tim' });
  for (let i = 0; i < 31; i++) insertSubmission(db, { id: `many-${i}`, createdBy: 'user-a', type: 'finance_request', amount: 501, date: '2024-03-01', description: 'Kopi dan cafe untuk tim' });
  const result = await findPotentialDuplicates({ body: { type: 'finance_request', amountIdr: 501, date: '2024-03-01', description: 'KOPI & café untuk tim', excludeId: 'many-0' } }, db, alpha);
  assert.equal(result.matches.length, 20);
  assert.equal(result.hasMoreCandidates, true);
  assert.equal(result.matchingCount, 32);
  assert.equal(result.matches.some(x => x.id === 'private'), false);
  assert.equal(result.matches.some(x => x.id === 'unicode'), true);
  assert.equal(result.matches.some(x => x.id === 'many-0'), false);
  const managerResult = await findPotentialDuplicates({ body: { type: 'finance_request', amountIdr: 501, date: '2024-03-01', description: 'Kopi dan cafe untuk tim' } }, db, manager);
  assert.equal(managerResult.matchingCount, 34);
  assert.equal(managerResult.matches.length, 20);
  const after = {
    submissions: db.db.prepare('SELECT COUNT(*) n FROM submissions').get().n,
    audits: db.db.prepare('SELECT COUNT(*) n FROM audit_events').get().n,
    ledger: db.db.prepare('SELECT COUNT(*) n FROM cash_ledger').get().n
  };
  assert.equal(after.submissions, before.submissions + 36);
  assert.equal(after.audits, before.audits);
  assert.equal(after.ledger, before.ledger); // duplicate checking never writes
});

test('duplicate input rejects injection/control data and invalid calendar dates', async () => {
  const { db } = await fixture();
  const base = { type: 'finance_request', amountIdr: 1, date: '2024-03-01', description: 'dua kata valid' };
  for (const body of [
    { ...base, type: "finance_request' OR 1=1 --" },
    { ...base, amountIdr: 9007199254740992 },
    { ...base, date: '2024-02-30' },
    { ...base, description: 'x' },
    { ...base, excludeId: 'x\nOR 1=1' }
  ]) await assert.rejects(() => findPotentialDuplicates({ body }, db, alpha), code(400, 'invalid_duplicate_check'));
});
