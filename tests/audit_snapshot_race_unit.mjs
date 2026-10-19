import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { onRequest } from '../functions/api/[[path]].js';
import { getCashInsights } from '../functions/_lib/cash-insights.js';
import { seededFinancialDb, insertSubmission, request } from './local_financial_db.mjs';
const before = '2020-01-01T00:00:00.000Z';
function topup(db, amount = 1, at = before) {
  db.db.prepare('INSERT INTO cash_topups (id,manager_id,idempotency_key,payload_hash,amount_idr,note,created_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), 'manager-1', randomUUID(), 'a'.repeat(64), amount, 'Fixture lokal', at);
}
function intercept(db, matcher, operation, { method = 'all', once = true } = {}) {
  const prepare = db.prepare.bind(db); let calls = 0;
  db.prepare = sql => {
    const statement = prepare(sql);
    if (matcher(sql)) {
      const run = statement[method].bind(statement);
      statement[method] = async () => {
        const result = await run();
        if (!once || calls === 0) { calls++; operation(sql, result); }
        return result;
      };
    }
    return statement;
  };
  return () => calls;
}
async function call(db, token, path) { return onRequest({ request: request(path, token), env: { DB: db } }); }
async function exportFixture() {
  const fixture = await seededFinancialDb();
  for (let i = 0; i < 501; i++) insertSubmission(fixture.db, { id: `race${String(i).padStart(4, '0')}`, createdAt: before, date: '2020-01-01', description: `Snapshot record ${i}` });
  return fixture;
}
test('insights anchor keeps account and 500+ ledger rows coherent when a top-up commits between pages', async () => {
  const { db } = await seededFinancialDb();
  for (let i = 0; i < 501; i++) topup(db);
  const amount = db.db.prepare('SELECT balance_idr FROM cash_accounts').get().balance_idr;
  const anchor = db.db.prepare('SELECT MAX(id) AS id FROM cash_ledger').get().id;
  const mutations = intercept(db, sql => /FROM cash_ledger/.test(sql) && /ORDER BY id DESC LIMIT 500/.test(sql), () => topup(db, 70));
  const result = await getCashInsights(db);
  assert.equal(mutations(), 1); assert.equal(result.ledgerAnchorId, anchor);
  assert.equal(result.account.balanceIdr, String(amount));
  assert.equal(result.totals.topupsIdr, String(amount));
  assert.equal(result.accounting.discrepancyIdr, '0');
  assert.equal(db.db.prepare('SELECT balance_idr FROM cash_accounts').get().balance_idr, amount + 70);
  assert.equal((await getCashInsights(db)).accounting.discrepancyIdr, '0');
  db.db.prepare('UPDATE cash_accounts SET balance_idr=balance_idr+1').run();
  assert.equal((await getCashInsights(db)).accounting.discrepancyIdr, '1', 'real corruption must never be hidden');
});
test('overview balance, flow, ledger page and ledger total use one account/ledger boundary', async () => {
  const { db, managerToken } = await seededFinancialDb(); topup(db, 100);
  const anchor = db.db.prepare('SELECT MAX(id) AS id FROM cash_ledger').get().id;
  const mutations = intercept(db, sql => /ledger_high_water_id/.test(sql), () => topup(db, 70), { method: 'first' });
  const response = await call(db, managerToken, '/overview'); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(mutations(), 1);
  assert.equal(body.cashBalanceIdr, 100); assert.equal(body.cashFlow.incomingIdr, '100');
  assert.ok(body.cashLedger.every(row => row.id <= anchor));
  assert.equal(body.history.cashLedger.total, anchor);
});
for (const path of ['/export.pdf']) {
  test(`${path} retries the whole gather when a legacy pending submission is approved after first page`, async () => {
    const { db, managerToken } = await exportFixture();
    const mutations = intercept(db, sql => /FROM submissions s/.test(sql) && /LIMIT 500/.test(sql), () => {
      db.db.prepare("UPDATE submissions SET status='approved', resolved_by='manager-1', updated_by='manager-1', updated_at=? WHERE id='race0000'").run(before);
    });
    const response = await call(db, managerToken, path);
    assert.equal(response.status, 200); assert.equal(mutations(), 1);
    assert.ok(response.headers.get('X-Report-Snapshot-At'));
    const bytes = new Uint8Array(await response.arrayBuffer()); assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  });
  test(`${path} returns clean 409 rather than a partial success while source keeps changing`, async () => {
    const { db, managerToken } = await exportFixture();
    const mutations = intercept(db, sql => /FROM submissions s/.test(sql) && /LIMIT 500/.test(sql), () => topup(db), { once: false });
    const response = await call(db, managerToken, path);
    assert.equal(response.status, 409); assert.ok(mutations() >= 2);
    assert.match(response.headers.get('Content-Type'), /application\/json/);
    assert.equal((await response.json()).error.code, 'report_changed_retry');
    assert.equal(response.headers.get('Content-Disposition'), null);
  });
}
test('pending queue finds the old pending submission beyond latest 100 and User search totals stay owner scoped', async () => {
  const { db, managerToken, userAToken } = await seededFinancialDb();
  insertSubmission(db, { id: 'old-pending', createdAt: before, date: '2020-01-01', description: 'Target lama' });
  for (let i = 0; i < 105; i++) insertSubmission(db, { id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, status: 'approved', createdAt: '2020-02-01T00:00:00.000Z', date: '2020-02-01' });
  insertSubmission(db, { id: 'other-owner', createdBy: 'user-b', description: 'Target lama', createdAt: before, date: '2020-01-01' });
  const overview = await (await call(db, managerToken, '/overview')).json();
  assert.equal(overview.submissions.length, 5); assert.ok(overview.pendingSubmissions.some(row => row.id === 'old-pending'));
  const response = await call(db, userAToken, '/submissions?q=Target%20lama'); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.total, 1); assert.equal(body.submissions[0].id, 'old-pending');
  const pages = []; let cursor = '';
  do {
    const query = `/submissions?q=Disetujui&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await (await call(db, userAToken, query)).json();
    pages.push(...(page.items || page.submissions || [])); cursor = page.nextCursor || '';
    if (!page.hasMore) break;
  } while (cursor);
  assert.equal(pages.length, 105); assert.equal(new Set(pages.map(row => row.id)).size, 105);
  assert.ok(pages.every(row => row.status === 'approved'));
  assert.deepEqual(pages.map(row => row.createdAt), [...pages.map(row => row.createdAt)].sort().reverse());
  const raw = await (await call(db, userAToken, '/submissions?q=approved&limit=5')).json(); assert.equal((raw.items || raw.submissions).length, 5);
  const empty = await (await call(db, userAToken, '/submissions?pengaju=unknown')).json();
  assert.equal(empty.total, 0); assert.equal(empty.submissions.length, 0);
});
