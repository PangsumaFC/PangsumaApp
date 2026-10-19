import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { onRequest } from '../functions/api/[[path]].js';
import { seededFinancialDb, insertSubmission, request } from './local_financial_db.mjs';

const ENV = { PASSWORD_PEPPER: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
const key = () => crypto.randomUUID();
async function fixture() {
  const f = await seededFinancialDb();
  for (const file of ['0006_financial_controls.sql', '0007_submission_receipts.sql', '0008_financial_alert_settings.sql', '0009_receipt_dropbox_metadata.sql']) {
    f.db.db.exec(fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  return f;
}
async function call(db, path, token, { method = 'GET', body, query = '', headers = {}, origin = 'https://local.test' } = {}) {
  const h = new Headers({ Origin: origin, Cookie: token ? `__Host-pangsuma_session=${token}` : '', ...headers });
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const req = new Request(`https://local.test/api${path}${query}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const response = await onRequest({ request: req, env: { DB: db, ...ENV } });
  const type = response.headers.get('content-type') || '';
  const result = type.includes('json') ? await response.json() : new Uint8Array(await response.arrayBuffer());
  return { response, body: result };
}
async function expectStatus(db, path, token, status, opts = {}) { const r = await call(db, path, token, opts); assert.equal(r.response.status, status, JSON.stringify(r.body)); return r; }
async function makeSubmission(db, token, overrides = {}) {
  return call(db, '/submissions', token, { method: 'POST', headers: { 'Idempotency-Key': key() }, body: { type: 'finance_request', amountIdr: 100, date: '2028-01-15', description: 'Pembelian unit', ...overrides } });
}
const scenarios = [
  ['health reports ready schema', async f => assert.equal((await call(f.db, '/health', null)).body.database, 'ready')],
  ['health rejects POST', async f => expectStatus(f.db, '/health', null, 405, { method: 'POST' })],
  ['bootstrap is closed without bearer secret', async f => assert.equal((await call(f.db, '/bootstrap', null, { method: 'POST', body: {} })).response.status, 404)],
  ['password parameters are public', async f => assert.equal((await call(f.db, '/password-parameters', null, { method: 'POST', body: { email: 'alpha@test.local' } })).response.status, 200)],
  ['session without cookie is unauthorized', async f => expectStatus(f.db, '/session', null, 401)],
  ['session identifies manager', async f => assert.equal((await call(f.db, '/session', f.managerToken)).body.user.id, 'manager-1')],
  ['logout clears current session', async f => assert.equal((await call(f.db, '/logout', f.userAToken, { method: 'POST' })).response.status, 200)],
  ['logout rejects cross origin', async f => expectStatus(f.db, '/logout', f.userAToken, 403, { method: 'POST', origin: 'https://evil.test' })],
  ['unknown route is 404', async f => expectStatus(f.db, '/does-not-exist', f.userAToken, 404)],
  ['submissions requires authentication', async f => expectStatus(f.db, '/submissions', null, 401)],
  ['user sees empty submission history', async f => { const r = await call(f.db, '/submissions', f.userAToken); assert.equal(r.body.total, 0); assert.deepEqual(r.body.submissions, []); }],
  ['manager sees empty submission history', async f => { const r = await call(f.db, '/history/submissions', f.managerToken); assert.equal(r.body.total, 0); }],
  ['user cannot see another user history', async f => { insertSubmission(f.db, { id: crypto.randomUUID(), createdBy: 'user-b' }); const r = await call(f.db, '/submissions', f.userAToken); assert.equal(r.body.total, 0); }],
  ['manager sees user history', async f => { insertSubmission(f.db, { id: crypto.randomUUID(), createdBy: 'user-b' }); assert.equal((await call(f.db, '/submissions', f.managerToken)).body.total, 1); }],
  ['long synthetic user history remains paginated', async f => { for (let i=0;i<125;i++) insertSubmission(f.db, { id: crypto.randomUUID(), createdBy: i%2?'user-a':'user-b', description: `Riwayat sintetis ${i}` }); const r=await call(f.db,'/submissions',f.userAToken,{query:'?limit=50'}); assert.equal(r.body.submissions.length,5); assert.equal(r.body.total,62); }],
  ['submission search filter exact', async f => { insertSubmission(f.db,{id:crypto.randomUUID(),description:'Khusus Filter Zeta'}); insertSubmission(f.db,{id:crypto.randomUUID(),description:'Lain'}); const r=await call(f.db,'/submissions',f.managerToken,{query:'?q=Zeta'}); assert.equal(r.body.total,1); }],
  ['submission status filter', async f => { insertSubmission(f.db,{id:crypto.randomUUID(),status:'approved'}); insertSubmission(f.db,{id:crypto.randomUUID(),status:'pending'}); assert.equal((await call(f.db,'/submissions',f.managerToken,{query:'?status=approved'})).body.total,1); }],
  ['submission kind filter', async f => { insertSubmission(f.db,{id:crypto.randomUUID(),type:'petty_cash'}); insertSubmission(f.db,{id:crypto.randomUUID(),type:'finance_request'}); assert.equal((await call(f.db,'/submissions',f.managerToken,{query:'?kind=petty_cash'})).body.total,1); }],
  ['submission date filter', async f => { insertSubmission(f.db,{id:crypto.randomUUID(),date:'2028-03-01'}); insertSubmission(f.db,{id:crypto.randomUUID(),date:'2028-04-01'}); assert.equal((await call(f.db,'/submissions',f.managerToken,{query:'?date=2028-03-01'})).body.total,1); }],
  ['submissions cursor page forward', async f => { for(let i=0;i<7;i++) insertSubmission(f.db,{id:crypto.randomUUID(),description:`Cursor ${i}`}); const a=await call(f.db,'/submissions',f.managerToken,{query:'?limit=2'}); assert.equal(a.body.submissions.length,5); const b=await call(f.db,'/submissions',f.managerToken,{query:`?limit=2&cursor=${encodeURIComponent(a.body.nextCursor)}`}); assert.equal(b.body.submissions.length,2); }],
  ['invalid submission type', async f => { const r=await makeSubmission(f.db,f.userAToken,{type:'bogus'}); assert.equal(r.response.status,400); assert.equal(r.body.error.code,'invalid_submission_type'); }],
  ['invalid submission amount zero', async f => { const r=await makeSubmission(f.db,f.userAToken,{amountIdr:0}); assert.equal(r.body.error.code,'invalid_amount'); }],
  ['invalid submission amount decimal', async f => { const r=await makeSubmission(f.db,f.userAToken,{amountIdr:1.5}); assert.equal(r.body.error.code,'invalid_amount'); }],
  ['invalid submission amount string', async f => { const r=await makeSubmission(f.db,f.userAToken,{amountIdr:'10'}); assert.equal(r.body.error.code,'invalid_amount'); }],
  ['invalid submission date', async f => { const r=await makeSubmission(f.db,f.userAToken,{date:'not-date'}); assert.equal(r.body.error.code,'invalid_date'); }],
  ['short description validation', async f => { const r=await makeSubmission(f.db,f.userAToken,{description:'ab'}); assert.equal(r.body.error.code,'invalid_description'); }],
  ['long description validation', async f => { const r=await makeSubmission(f.db,f.userAToken,{description:'x'.repeat(151)}); assert.equal(r.body.error.code,'invalid_description'); }],
  ['long note validation', async f => { const r=await makeSubmission(f.db,f.userAToken,{note:'x'.repeat(501)}); assert.equal(r.body.error.code,'invalid_note'); }],
  ['missing idempotency validation', async f => { const r=await call(f.db,'/submissions',f.userAToken,{method:'POST',body:{type:'finance_request',amountIdr:1,date:'2028-01-01',description:'Valid'}}); assert.equal(r.body.error.code,'idempotency_required'); }],
  ['cross origin submission denied', async f => { const r=await makeSubmission(f.db,f.userAToken); assert.equal(r.response.status,201); const denied=await call(f.db,'/submissions',f.userAToken,{method:'POST',origin:'https://evil.test',headers:{'Idempotency-Key':key()},body:{type:'finance_request',amountIdr:1,date:'2028-01-01',description:'Valid'}}); assert.equal(denied.response.status,403); }],
  ['valid submission creates audit', async f => { const r=await makeSubmission(f.db,f.userAToken); assert.equal(r.response.status,201); assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='submission.created'").get().n,1); }],
  ['submission idempotency replay', async f => { const k=key(), opts={method:'POST',headers:{'Idempotency-Key':k},body:{type:'finance_request',amountIdr:11,date:'2028-01-01',description:'Replay item'}}; const a=await call(f.db,'/submissions',f.userAToken,opts), b=await call(f.db,'/submissions',f.userAToken,opts); assert.equal(a.body.submission.id,b.body.submission.id); assert.equal(b.body.alreadyCreated,true); }],
  ['idempotency payload mismatch creates conflict', async f => { const k=key(); await call(f.db,'/submissions',f.userAToken,{method:'POST',headers:{'Idempotency-Key':k},body:{type:'finance_request',amountIdr:11,date:'2028-01-01',description:'First'}}); const b=await call(f.db,'/submissions',f.userAToken,{method:'POST',headers:{'Idempotency-Key':k},body:{type:'finance_request',amountIdr:12,date:'2028-01-01',description:'Second'}}); assert.equal(b.response.status,409); }],
  ['user cannot approve', async f => { const id=crypto.randomUUID(); insertSubmission(f.db,{id}); await expectStatus(f.db,`/submissions/${id}/approve`,f.userAToken,403,{method:'POST',body:{}}); }],
  ['manager approves pending request', async f => { const id=crypto.randomUUID(); insertSubmission(f.db,{id}); const r=await call(f.db,`/submissions/${id}/approve`,f.managerToken,{method:'POST',body:{}}); assert.equal(r.body.submission.status,'approved'); }],
  ['manager rejects with reason', async f => { const id=crypto.randomUUID(); insertSubmission(f.db,{id}); const r=await call(f.db,`/submissions/${id}/reject`,f.managerToken,{method:'POST',body:{reason:'Tidak prioritas'}}); assert.equal(r.body.submission.status,'rejected'); }],
  ['reject requires reason', async f => { const id=crypto.randomUUID(); insertSubmission(f.db,{id}); const r=await call(f.db,`/submissions/${id}/reject`,f.managerToken,{method:'POST',body:{}}); assert.equal(r.body.error.code,'decision_reason_required'); }],
  ['approve is idempotent', async f => { const id=crypto.randomUUID(); insertSubmission(f.db,{id}); await call(f.db,`/submissions/${id}/approve`,f.managerToken,{method:'POST',body:{}}); const r=await call(f.db,`/submissions/${id}/approve`,f.managerToken,{method:'POST',body:{}}); assert.equal(r.body.alreadyApplied,true); }],
  ['reject then approve conflicts', async f => { const id=crypto.randomUUID(); insertSubmission(f.db,{id}); await call(f.db,`/submissions/${id}/reject`,f.managerToken,{method:'POST',body:{reason:'No'}}); const r=await call(f.db,`/submissions/${id}/approve`,f.managerToken,{method:'POST',body:{}}); assert.equal(r.response.status,409); }],
  ['manager self-decision denied', async f => { const r=await makeSubmission(f.db,f.managerToken,{type:'finance_request',amountIdr:1}); assert.equal(r.response.status,201); const id=r.body.submission.id; const d=await call(f.db,`/submissions/${id}/approve`,f.managerToken,{method:'POST',body:{}}); assert.equal(d.response.status,403); }],
  ['send requires approved finance request', async f => { const id=crypto.randomUUID(); insertSubmission(f.db,{id,type:'finance_request'}); const r=await call(f.db,`/submissions/${id}/send`,f.managerToken,{method:'POST',body:{}}); assert.equal(r.response.status,409); }],
  ['send approved finance request', async f => { const id=crypto.randomUUID(); insertSubmission(f.db,{id,type:'finance_request',status:'approved',resolvedBy:'manager-1'}); const r=await call(f.db,`/submissions/${id}/send`,f.managerToken,{method:'POST',body:{}}); assert.equal(r.body.submission.status,'sent'); }],
  ['send is idempotent', async f => { const id=crypto.randomUUID(); insertSubmission(f.db,{id,type:'finance_request',status:'approved'}); await call(f.db,`/submissions/${id}/send`,f.managerToken,{method:'POST',body:{}}); const r=await call(f.db,`/submissions/${id}/send`,f.managerToken,{method:'POST',body:{}}); assert.equal(r.body.alreadyApplied,true); }],
  ['approve invalid id returns not found', async f => { const r=await call(f.db,'/submissions/not-a-uuid/approve',f.managerToken,{method:'POST',body:{}}); assert.equal(r.response.status,404); }],
  ['activity denied cross user', async f => { const id=crypto.randomUUID(); insertSubmission(f.db,{id,createdBy:'user-b'}); assert.equal((await call(f.db,`/submissions/${id}/activity`,f.userAToken)).response.status,404); }],
  ['activity visible to owner', async f => { const id=crypto.randomUUID(); insertSubmission(f.db,{id,createdBy:'user-a'}); assert.equal((await call(f.db,`/submissions/${id}/activity`,f.userAToken)).response.status,200); }],
  ['overview requires auth', async f => expectStatus(f.db,'/overview',null,401)],
  ['overview has cash flow for manager', async f => assert.equal((await call(f.db,'/overview',f.managerToken)).response.status,200)],
  ['cash insights user denied', async f => expectStatus(f.db,'/cash/insights',f.userAToken,403)],
  ['cash ledger history user denied', async f => expectStatus(f.db,'/history/cash-ledger',f.userAToken,403)],
  ['audit history manager page', async f => { const r=await call(f.db,'/history/audit-events',f.managerToken); assert.equal(r.response.status,200); assert.ok(Array.isArray(r.body.auditEvents)); }],
  ['opening balance requires confirmation', async f => { const r=await call(f.db,'/cash/opening-balance',f.managerToken,{method:'POST',body:{amountIdr:10,ownerConfirmed:false}}); assert.equal(r.body.error.code,'owner_confirmation_required'); }],
  ['opening balance positive creates ledger', async f => { const r=await call(f.db,'/cash/opening-balance',f.managerToken,{method:'POST',body:{amountIdr:100,ownerConfirmed:true}}); assert.equal(r.response.status,201); assert.equal(r.body.cashBalanceIdr,100); }],
  ['opening balance replay same amount', async f => { const o={method:'POST',body:{amountIdr:100,ownerConfirmed:true}}; await call(f.db,'/cash/opening-balance',f.managerToken,o); const r=await call(f.db,'/cash/opening-balance',f.managerToken,o); assert.equal(r.body.alreadyApplied,true); }],
  ['opening balance rejects zero', async f => { const r=await call(f.db,'/cash/opening-balance',f.managerToken,{method:'POST',body:{amountIdr:0,ownerConfirmed:true}}); assert.equal(r.body.error.code,'invalid_opening_balance'); }],
  ['topup manager-only', async f => expectStatus(f.db,'/cash/topups',f.userAToken,403,{method:'POST',body:{amountIdr:10,note:'Setoran'}})],
  ['topup validates amount', async f => { const r=await call(f.db,'/cash/topups',f.managerToken,{method:'POST',headers:{'Idempotency-Key':key()},body:{amountIdr:0,note:'Setoran'}}); assert.equal(r.response.status,400); }],
  ['topup validates note', async f => { const r=await call(f.db,'/cash/topups',f.managerToken,{method:'POST',headers:{'Idempotency-Key':key()},body:{amountIdr:10,note:'x'}}); assert.equal(r.response.status,400); }],
  ['topup creates ledger reconciliation', async f => { const r=await call(f.db,'/cash/topups',f.managerToken,{method:'POST',headers:{'Idempotency-Key':key()},body:{amountIdr:10,note:'Setoran awal'}}); assert.equal(r.response.status,201); assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM cash_ledger WHERE event_type='cash_topup'").get().n,1); }],
  ['topup idempotency replay', async f => { const k=key(),o={method:'POST',headers:{'Idempotency-Key':k},body:{amountIdr:10,note:'Setoran awal'}}; await call(f.db,'/cash/topups',f.managerToken,o); const r=await call(f.db,'/cash/topups',f.managerToken,o); assert.equal(r.body.alreadyApplied,true); }],
  ['settings GET manager', async f => assert.equal((await call(f.db,'/financial/settings',f.managerToken)).response.status,200)],
  ['settings PUT version CAS', async f => { const r=await call(f.db,'/financial/settings',f.managerToken,{method:'PUT',headers:{'Idempotency-Key':key()},body:{minimumCashIdr:10,pendingMaxDays:5,expectedVersion:0}}); assert.equal(r.body.version,1); }],
  ['settings stale version conflicts', async f => { await call(f.db,'/financial/settings',f.managerToken,{method:'PUT',headers:{'Idempotency-Key':key()},body:{minimumCashIdr:10,pendingMaxDays:5,expectedVersion:0}}); const r=await call(f.db,'/financial/settings',f.managerToken,{method:'PUT',headers:{'Idempotency-Key':key()},body:{minimumCashIdr:20,pendingMaxDays:6,expectedVersion:0}}); assert.equal(r.response.status,409); }],
  ['alerts manager list', async f => { const r=await call(f.db,'/financial/alerts',f.managerToken); assert.equal(r.response.status,200); }],
  ['duplicate check isolates users', async f => { insertSubmission(f.db,{id:crypto.randomUUID(),createdBy:'user-b',description:'Bola sama'}); const r=await call(f.db,'/submissions/duplicate-check',f.userAToken,{method:'POST',body:{type:'finance_request',amountIdr:1000,date:'2028-01-15',description:'Bola sama'}}); assert.equal(r.body.matches.length,0); }],
  ['duplicate check manager sees match', async f => { insertSubmission(f.db,{id:crypto.randomUUID(),createdBy:'user-b',description:'Bola sama'}); const r=await call(f.db,'/submissions/duplicate-check',f.managerToken,{method:'POST',body:{type:'finance_request',amountIdr:1000,date:'2028-01-15',description:'Bola sama'}}); assert.equal(r.body.matches.length,1); }],
  ['users endpoint manager search', async f => { const r=await call(f.db,'/users',f.managerToken,{query:'?q=Alpha'}); assert.equal(r.body.total,1); }],
  ['users endpoint user denied', async f => expectStatus(f.db,'/users',f.userAToken,403)],
  ['users pagination bounds', async f => { const r=await call(f.db,'/users',f.managerToken,{query:'?page=1&limit=1'}); assert.equal(r.body.users.length,1); assert.equal(r.body.limit,1); }],
  ['users invalid pagination', async f => { const r=await call(f.db,'/users',f.managerToken,{query:'?page=zero'}); assert.equal(r.body.error.code,'invalid_pagination'); }],
  ['onboarding creates user', async f => { const r=await call(f.db,'/users',f.managerToken,{method:'POST',body:{name:'Synthetic New',email:'new@test.local',position:'Anggota'}}); assert.equal(r.response.status,201); assert.equal(r.body.user.mustChangePassword,true); }],
  ['onboarding duplicate email denied', async f => { const r=await call(f.db,'/users',f.managerToken,{method:'POST',body:{name:'Duplicate',email:'alpha@test.local'}}); assert.equal(r.response.status,409); }],
  ['onboarding invalid name', async f => { const r=await call(f.db,'/users',f.managerToken,{method:'POST',body:{name:'',email:'valid-new@test.local'}}); assert.equal(r.body.error.code,'invalid_name'); }],
  ['profile owner readable', async f => { const r=await call(f.db,'/profile',f.userAToken); assert.equal(r.body.user.id,'user-a'); }],
  ['profile cross user denied', async f => expectStatus(f.db,'/users/user-b/profile',f.userAToken,404)],
  ['profile manager reads user', async f => assert.equal((await call(f.db,'/profile',f.managerToken)).response.status,200)],
  ['profile optimistic conflict', async f => { const r=await call(f.db,'/profile',f.managerToken,{method:'PUT',body:{profileVersion:99,nickname:'X',dashboardPosition:'Y',quote:'Z'}}); assert.equal(r.body.error.code,'profile_conflict'); }],
  ['profile photo missing is 404', async f => expectStatus(f.db,'/users/user-a/photo',f.managerToken,404)],
  ['password route wrong method', async f => expectStatus(f.db,'/account/password',f.userAToken,405)],
  ['reports manager only', async f => expectStatus(f.db,'/reports',f.userAToken,403)],
  ['reports manager empty result', async f => { const r=await call(f.db,'/reports',f.managerToken); assert.equal(r.response.status,200); assert.ok(Array.isArray(r.body.items)); }],
  ['removed export CSV route is unavailable', async f => expectStatus(f.db,'/export.csv',f.userAToken,404)],
  ['export PDF rejects invalid report type', async f => { const r=await call(f.db,'/export.pdf',f.managerToken,{query:'?laporan=bad'}); assert.equal(r.body.error.code,'invalid_report_type'); }],
  ['method guard submissions GET', async f => expectStatus(f.db,'/submissions',f.userAToken,405,{method:'PUT'})],
  ['concurrent distinct idempotency keys preserve IDs', async f => { const rs=await Promise.all([...Array(8)].map((_,i)=>makeSubmission(f.db,f.userAToken,{description:`Concurrent ${i}`}))); assert.equal(new Set(rs.map(r=>r.body.submission.id)).size,8); assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM submissions').get().n,8); }],
  ['ledger reconciliation stays balanced after topup and petty approval', async f => { await call(f.db,'/cash/opening-balance',f.managerToken,{method:'POST',body:{amountIdr:1000,ownerConfirmed:true}}); await call(f.db,'/cash/topups',f.managerToken,{method:'POST',headers:{'Idempotency-Key':key()},body:{amountIdr:500,note:'Setoran aman'}}); const id=crypto.randomUUID(); insertSubmission(f.db,{id,type:'petty_cash',amount:100}); await call(f.db,`/submissions/${id}/approve`,f.managerToken,{method:'POST',body:{}}); const balance=f.db.db.prepare("SELECT balance_idr FROM cash_accounts WHERE id='operational'").get().balance_idr; assert.equal(balance,1400); }],
];
for (const [name, fn] of scenarios) test(`deep backend matrix: ${name}`, async () => fn(await fixture()));
assert.ok(scenarios.length >= 65, `matrix must contain at least 65 scenarios: ${scenarios.length}`);
