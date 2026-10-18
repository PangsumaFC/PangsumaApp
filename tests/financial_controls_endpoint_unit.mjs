import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encode } from 'fast-png';
import { onRequest } from '../functions/api/[[path]].js';
import { seededFinancialDb, insertSubmission, request } from './local_financial_db.mjs';
async function fixture() {
  const f = await seededFinancialDb();
  for (const name of ['0006_financial_controls.sql', '0007_submission_receipts.sql', '0008_financial_alert_settings.sql']) f.db.db.exec(fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  return f;
}
async function call(db, path, token, options = {}) {
  const base = request(path, token, options);
  const headers = new Headers(base.headers);
  for (const [name, value] of Object.entries(options.headers || {})) headers.set(name, value);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const req = new Request(base, { headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  const response = await onRequest({ request: req, env: { DB: db } });
  const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer());
  return { response, body };
}
const key = () => crypto.randomUUID();
test('organization controls are manager-only and changing them is origin-protected', async () => {
  const f = await fixture();
  for (const path of ['/financial/settings', '/financial/alerts', '/cash/reconciliations']) {
    assert.equal((await call(f.db, path, f.userAToken)).response.status, 403);
    assert.equal((await call(f.db, path, null)).response.status, 401);
    assert.equal((await call(f.db, path, f.managerToken)).response.status, 200);
  }
  const body = { minimumCashIdr: 5000, pendingMaxDays: 7, expectedVersion: 0 };
  const denied = await call(f.db, '/financial/settings', f.managerToken, { method: 'PUT', body, headers: { Origin: 'https://untrusted.example', 'Idempotency-Key': key() } });
  assert.equal(denied.response.status, 403);
  const accepted = await call(f.db, '/financial/settings', f.managerToken, { method: 'PUT', body, headers: { 'Idempotency-Key': key() } });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.version, 1);
  assert.equal(accepted.body.minimumCashIdr, '5000');
  assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='financial.settings_updated'").get().n, 1);
  assert.equal(f.db.db.prepare("SELECT balance_idr FROM cash_accounts WHERE id='operational'").get().balance_idr, 0);
});
test('monthly record keeps ledger/account untouched and appears in its real audit', async () => {
  const f = await fixture();
  const before = f.db.db.prepare('SELECT COUNT(*) n FROM cash_ledger').get().n;
  const payload = { period: '2025-12', physicalCashIdr: 125, note: 'Hasil hitung lokal', confirmed: true };
  const headers = { 'Idempotency-Key': key() };
  const result = await call(f.db, '/cash/reconciliations', f.managerToken, { method: 'POST', body: payload, headers });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.reconciliation.discrepancyIdr, '125');
  assert.equal((await call(f.db, '/cash/reconciliations', f.managerToken, { method: 'POST', body: payload, headers })).body.alreadyApplied, true);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM cash_ledger').get().n, before);
  assert.equal(f.db.db.prepare("SELECT balance_idr FROM cash_accounts WHERE id='operational'").get().balance_idr, 0);
  assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='cash.reconciled'").get().n, 1);
  const listed = await call(f.db, '/cash/reconciliations?period=2025-12&limit=20', f.managerToken);
  assert.equal(listed.body.preview.ledgerBalanceIdr, '0');
  assert.equal(listed.body.reconciliations.length, 1);
});
test('actual receipt routes protect metadata and binary and reject cross-origin uploads', async () => {
  const f = await fixture();
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  insertSubmission(f.db, { id, createdBy: 'user-a', type: 'finance_request', amount: 100, date: '2025-12-31' });
  const png = encode({ width: 2, height: 2, channels: 4, depth: 8, data: new Uint8Array(16).fill(255) });
  const body = { filename: 'nota.png', mimeType: 'image/png', dataBase64: Buffer.from(png).toString('base64') };
  const path = `/submissions/${id}/receipts`, headers = { 'Idempotency-Key': key() };
  assert.equal((await call(f.db, path, f.userBToken, { method: 'POST', body, headers })).response.status, 404);
  assert.equal((await call(f.db, path, f.userAToken, { method: 'POST', body, headers: { ...headers, Origin: 'https://untrusted.example' } })).response.status, 403);
  const created = await call(f.db, path, f.userAToken, { method: 'POST', body, headers });
  assert.equal(created.response.status, 201);
  const binaryPath = created.body.url.replace(/^\/api/, '');
  assert.equal((await call(f.db, binaryPath, f.userBToken)).response.status, 404);
  assert.equal((await call(f.db, binaryPath, null)).response.status, 401);
  const binary = await call(f.db, binaryPath, f.managerToken);
  assert.equal(binary.response.status, 200);
  assert.match(binary.response.headers.get('cache-control'), /private, no-store/);
  assert.equal(binary.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(binary.body.byteLength, created.body.sizeBytes);
  assert.equal((await call(f.db, path, f.userAToken)).body.count, 1);
  f.db.db.prepare('DROP TRIGGER submission_receipt_created_audit').run();
  assert.equal((await call(f.db, path, f.userAToken, { method: 'POST', body, headers: { 'Idempotency-Key': key() } })).response.status, 503);
});
test('duplicate-check endpoint warns without leaking another User or blocking insertion', async () => {
  const f = await fixture();
  insertSubmission(f.db, { id: 'dup-private', createdBy: 'user-b', type: 'finance_request', amount: 1000, date: '2025-12-31', description: 'Bola untuk latihan' });
  const body = { type: 'finance_request', amountIdr: 1000, date: '2025-12-31', description: 'Pembelian bola latihan' };
  assert.equal((await call(f.db, '/submissions/duplicate-check', f.userAToken, { method: 'POST', body })).body.matches.length, 0);
  assert.equal((await call(f.db, '/submissions/duplicate-check', f.managerToken, { method: 'POST', body })).body.matches.length, 1);
  assert.equal((await call(f.db, '/submissions/duplicate-check', null, { method: 'POST', body })).response.status, 401);
  assert.equal((await call(f.db, '/submissions/duplicate-check', f.userAToken)).response.status, 405);
  insertSubmission(f.db, { id: 'dup-allowed', createdBy: 'user-b', type: 'finance_request', amount: 1000, date: '2025-12-31', description: 'Bola untuk latihan' });
  assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM submissions WHERE created_by='user-b'").get().n, 2);
});

test('overview totals and opening flag use all ledger rows, not the visible 100', async () => {
  const f = await fixture();
  f.db.db.prepare("INSERT INTO cash_ledger(event_type,direction,amount_idr,balance_after_idr,note,created_at,actor_id) VALUES ('opening_balance','credit',5000,5000,'Saldo awal uji','2025-01-01T00:00:00.000Z','manager-1')").run();
  f.db.db.prepare("UPDATE cash_accounts SET balance_idr=5000 WHERE id='operational'").run();
  let expectedIncoming = 5000n;
  for (let i = 0; i < 600; i++) {
    f.db.db.prepare('INSERT INTO cash_topups(id,idempotency_key,manager_id,amount_idr,note,payload_hash,created_at) VALUES (?,?,?,?,?,?,?)').run(`flow-${i}`, `flow-key-${i}`, 'manager-1', 2, 'Setoran lokal', 'a'.repeat(64), '2025-01-02T00:00:00.000Z');
    expectedIncoming += 2n;
  }
  const created = await call(f.db, '/submissions', f.managerToken, { method:'POST', headers:{ 'Idempotency-Key':key() }, body:{ type:'petty_cash', amountIdr:3, date:'2025-01-03', description:'Biaya arus kas lokal' } });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const overview = await call(f.db, '/overview', f.managerToken);
  assert.equal(overview.body.cashLedger.length, 5);
  assert.equal(overview.body.history.cashLedger.total, f.db.db.prepare('SELECT COUNT(*) n FROM cash_ledger').get().n);
  assert.equal(overview.body.cashFlow.incomingIdr, expectedIncoming.toString());
  assert.equal(overview.body.cashFlow.outgoingIdr, '3');
  assert.equal(overview.body.cashFlow.openingConfigured, true);
  assert.equal(BigInt(overview.body.cashBalanceIdr), expectedIncoming - 3n);
  assert.ok(overview.body.cashLedger.every(row => row.event_type !== 'opening_balance'));
  assert.equal(Object.hasOwn((await call(f.db, '/overview', f.userAToken)).body, 'cashFlow'), false);
});
