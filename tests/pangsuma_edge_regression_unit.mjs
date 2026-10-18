import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encode } from 'fast-png';
import { onRequest } from '../functions/api/[[path]].js';
import { seededFinancialDb, insertSubmission, request } from './local_financial_db.mjs';

async function fixture() {
  const f = await seededFinancialDb();
  for (const name of ['0006_financial_controls.sql', '0007_submission_receipts.sql', '0008_financial_alert_settings.sql'])
    f.db.db.exec(fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  return f;
}
async function call(db, path, token, options = {}) {
  const base = request(path, token, options);
  const headers = new Headers(base.headers);
  for (const [name, value] of Object.entries(options.headers || {})) headers.set(name, value);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const req = new Request(base, { headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  const response = await onRequest({ request: req, env: { DB: db } });
  const body = response.headers.get('content-type')?.includes('application/json')
    ? await response.json() : new Uint8Array(await response.arrayBuffer());
  return { response, body };
}
const uuid = () => crypto.randomUUID();
const png = (value) => encode({ width: 2, height: 2, channels: 4, depth: 8, data: new Uint8Array(16).fill(value) });
const receiptBody = (bytes, filename = 'nota.png') => ({ filename, mimeType: 'image/png', dataBase64: Buffer.from(bytes).toString('base64') });

 test('cash insights missing operational account is recoverable 503 and no-store', async () => {
  const f = await fixture();
  f.db.db.prepare("INSERT INTO cash_ledger(event_type,direction,amount_idr,balance_after_idr,note,created_at,actor_id) VALUES ('cash_topup','credit',1000,1000,'Nonzero orphan ledger fixture','2025-01-01T00:00:00.000Z','manager-1')").run();
  f.db.db.prepare("DELETE FROM cash_accounts WHERE id='operational'").run();
  const result = await call(f.db, '/cash/insights', f.managerToken);
  assert.equal(result.response.status, 503);
  assert.equal(result.body.error.code, 'operational_cash_unavailable');
  assert.match(result.response.headers.get('cache-control') || '', /no-store/);
});

test('same-key receipt races reject different metadata or bytes, preserve one row and cash ledger', async () => {
  const f = await fixture();
  const submissionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  insertSubmission(f.db, { id: submissionId, createdBy: 'user-a' });
  const path = `/submissions/${submissionId}/receipts`;
  const key = uuid();
  const bytesA = png(10), bytesB = png(20);
  const [first, second] = await Promise.all([
    call(f.db, path, f.userAToken, { method: 'POST', body: receiptBody(bytesA, 'first.png'), headers: { 'Idempotency-Key': key } }),
    call(f.db, path, f.userAToken, { method: 'POST', body: receiptBody(bytesA, 'second.png'), headers: { 'Idempotency-Key': key } })
  ]);
  assert.ok([first.response.status, second.response.status].includes(201));
  assert.ok([first.response.status, second.response.status].includes(409));
  const winner = first.response.status === 201 ? first : second;
  const winnerFilename = first.response.status === 201 ? 'first.png' : 'second.png';
  assert.equal(winner.body.filename, winnerFilename);
  const byteConflict = await call(f.db, path, f.userAToken, { method: 'POST', body: receiptBody(bytesB, 'different-bytes.png'), headers: { 'Idempotency-Key': key } });
  assert.equal(byteConflict.response.status, 409);
  const identical = await call(f.db, path, f.userAToken, { method: 'POST', body: receiptBody(bytesA, winnerFilename), headers: { 'Idempotency-Key': key } });
  assert.equal(identical.response.status, 200);
  assert.deepEqual(identical.body, winner.body);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM submission_receipts').get().n, 1);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM cash_ledger').get().n, 1);
  assert.equal(f.db.db.prepare("SELECT balance_idr FROM cash_accounts WHERE id='operational'").get().balance_idr, 0);
});

for (const section of ['submissions', 'ledger', 'audits']) {
  test(`PDF handles oversized ${section}: guards report sources, excludes audit dump`, async () => {
    const f = await fixture();
    if (section === 'submissions') {
      for (let i = 0; i < 1001; i++) insertSubmission(f.db, { id: `pdf-sub-${i}`, createdBy: 'user-a', status: 'approved', date: '2025-01-15', createdAt: `2025-01-15T04:${String(i % 60).padStart(2, '0')}:00.000Z`, description: `Long description ${'x'.repeat(120)}` });
    } else if (section === 'ledger') {
      for (let i = 0; i < 1001; i++) f.db.db.prepare("INSERT INTO cash_ledger(event_type,direction,amount_idr,balance_after_idr,note,created_at,actor_id) VALUES ('cash_topup','credit',1,1,?,?,'manager-1')").run(`Long ledger note ${'x'.repeat(120)}`, `2025-01-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`);
    } else {
      for (let i = 0; i < 1001; i++) f.db.db.prepare("INSERT INTO audit_events(actor_id,action,entity_type,entity_id,details_json,created_at) VALUES ('manager-1','test','other',?,?,?)").run(`audit-${i}`, JSON.stringify({ detail: 'x'.repeat(160) }), `2025-01-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`);
    }
    const originalPrepare = f.db.prepare.bind(f.db); const collections = [];
    f.db.prepare = sql => { if (/ORDER BY (?:s.created_at DESC, s.id|l.id|a.id) DESC LIMIT 500/.test(sql)) collections.push(sql); return originalPrepare(sql); };
    const result = await call(f.db, '/export.pdf', f.managerToken);
    if (section === 'audits') {
      assert.equal(result.response.status, 200);
      assert.ok(!collections.some(sql => /FROM audit_events/.test(sql)));
      return;
    }
    assert.equal(collections.length, 0, 'oversized report source must fail before collection');
    assert.equal(result.response.status, 413, `${section}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error.code, 'report_too_large');
    assert.match(result.response.headers.get('cache-control') || '', /no-store/);
  });
}

for (const [label, sameBytes] of [['identical replay', true], ['different image bytes', false]]) {
  test(`concurrent receipt ${label} is deterministic and persists exactly once`, async () => {
    const f = await fixture(); const id = uuid(); insertSubmission(f.db, { id, createdBy: 'user-a' });
    const key = uuid(); const before = f.db.db.prepare('SELECT COUNT(*) AS n FROM cash_ledger').get().n;
    const results = await Promise.all([10, sameBytes ? 10 : 20].map(value => call(f.db, `/submissions/${id}/receipts`, f.userAToken,
      { method: 'POST', body: receiptBody(png(value)), headers: { 'Idempotency-Key': key } })));
    assert.deepEqual(results.map(r => r.response.status).sort(), sameBytes ? [200,201] : [201,409]);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM submission_receipts').get().n, 1);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM cash_ledger').get().n, before);
  });
}
test('manager reads user evidence but cannot upload, including existing SHA and key replay paths', async () => {
  const f = await fixture(); const id = uuid(); insertSubmission(f.db, { id, createdBy: 'user-a' });
  const key = uuid(), path = `/submissions/${id}/receipts`, bytes = png(44);
  const first = await call(f.db, path, f.userAToken, { method: 'POST', body: receiptBody(bytes, 'user.png'), headers: { 'Idempotency-Key': key } });
  assert.equal(first.response.status, 201);
  for (const replayKey of [key, uuid()]) {
    const blocked = await call(f.db, path, f.managerToken, { method: 'POST', body: receiptBody(bytes, 'manager.png'), headers: { 'Idempotency-Key': replayKey } });
    assert.equal(blocked.response.status, 403);
    assert.equal(blocked.body.error.code, 'forbidden');
  }
  const visible = await call(f.db, path, f.managerToken);
  assert.equal(visible.response.status, 200);
  assert.equal(visible.body.items.length, 1);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM submission_receipts').get().n, 1);
});
