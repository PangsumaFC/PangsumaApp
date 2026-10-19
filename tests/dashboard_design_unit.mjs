import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
function helpers() {
  const context = { document: { querySelector: () => null }, Intl, Date, String, Number, Boolean, Array, JSON, Math };
  vm.createContext(context);
  const injected = source.replace('initialize();', 'globalThis.__dashboard = { submissionTimeline, managerOverview, financePage, userOverview, navByRole };');
  vm.runInContext(injected, context);
  return context.__dashboard;
}
const item = (status, extra = {}) => ({ id: status, status, type: 'finance_request', description: `fixture-${status}`, date: '2026-10-18', amountIdr: 1000, createdAt: '2026-10-18T01:00:00.000Z', updatedAt: '2026-10-18T02:00:00.000Z', decisionReason: '', ...extra });

test('submissionTimeline uses real timestamps and never fabricates approval time for sent', () => {
  const { submissionTimeline } = helpers();
  const sent = submissionTimeline(item('sent'));
  assert.match(sent, /Dikirim/);
  assert.match(sent, /Disetujui/);
  assert.match(sent, /Terkirim ke Finance/);
  assert.equal((sent.match(/<small>/g) || []).length, 2, 'created and sent timestamps only; approval must be untimestamped');
  const rejected = submissionTimeline(item('rejected', { decisionReason: 'Tidak sesuai bukti.' }));
  assert.match(rejected, /Ditolak/);
  assert.match(rejected, /Tidak sesuai bukti/);
});

test('managerOverview renders server summary pending count before action queue and balance', () => {
  const { managerOverview } = helpers();
  const context = helpers();
  void context;
  // Re-evaluate with a controllable state by extracting the function's lexical scope.
  const sandbox = { document: { querySelector: () => null }, window: {}, Intl, Date };
  vm.createContext(sandbox);
  vm.runInContext(source.replace('initialize();', "state.user={id:'m',role:'manager',name:'Manager'}; state.cashBalanceIdr=125000; state.submissions=[]; state.summary={pending:7,financeWaiting:3,today:4}; globalThis.__html=managerOverview();"), sandbox);
  const html = sandbox.__html;
  assert.match(html, /125\.000/);
  assert.match(html, /Menunggu persetujuan/);
  assert.match(html, />7<\/strong>/);
  assert.equal((html.match(/data-action="open-cash-topup"/g) || []).length, 1, 'top up appears once on the Manager overview');
  assert.ok(html.indexOf('Saldo tersedia') < html.indexOf('data-action="open-cash-topup"'), 'top up sits below the balance description');
  assert.doesNotMatch(html, />Lihat Finance</, 'overview does not mirror the Finance navigation link');
  assert.ok(html.indexOf('Saldo petty cash') < html.indexOf('Buat pengajuan'));
  assert.doesNotMatch(html, /Antrean tindakan|Lihat Finance/);
  assert.equal((html.match(/class=\"recent-section\"/g) || []).length, 1);
  assert.equal((html.match(/class=\"item-row\"/g) || []).length, 0);
});

test('financePage removes the duplicate petty cash top-up action while retaining opening balance action', () => {
  const sandbox = { document: { querySelector: () => null }, window: {}, Intl, Date };
  vm.createContext(sandbox);
  vm.runInContext(source.replace('initialize();', "state.user={id:'m',role:'manager'}; state.cashFlow={openingConfigured:false}; globalThis.__finance=financePage();"), sandbox);
  assert.equal((sandbox.__finance.match(/data-action=\"open-cash-topup\"/g) || []).length, 0);
  assert.match(sandbox.__finance, /data-action=\"open-opening-balance\"/);
});

test('userOverview keeps report creation canonical in navigation without a duplicate CTA', () => {
  const sandbox = { document: { querySelector: () => null }, window: {}, Intl, Date };
  vm.createContext(sandbox);
  vm.runInContext(source.replace('initialize();', "state.user={id:'u',role:'user',name:'User'}; state.submissions=[]; state.summary={}; globalThis.__html=userOverview();"), sandbox);
  const html = sandbox.__html;
  assert.equal((html.match(/data-action=\"open-report-choice\"/g) || []).length, 0);
  assert.equal((html.match(/data-action=\"open-cash-topup\"/g) || []).length, 0, 'User tidak melihat action Manager');
  assert.match(html, /Buat laporan/);
  assert.doesNotMatch(html, /status metadata/i);
  assert.equal((html.match(/class=\"user-status-section\"/g) || []).length, 1);
});
test('user responsive navigation has one report destination and keeps password in the header', () => {
  const { navByRole } = helpers();
  assert.deepEqual([...navByRole.user.map(item => item.id)], ['overview', 'new-report', 'my-reports']);
  assert.equal(navByRole.user.filter(item => item.id === 'new-report').length, 1);
  assert.equal(navByRole.user.filter(item => item.id === 'change-password').length, 0);
});

test('offline notice copy is explicit that no queued data is promised', () => {
  const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(html, /Koneksi terputus\. Data terakhir tetap tampil; sambungkan kembali sebelum mengirim\./);
  assert.doesNotMatch(html, /akan dikirim otomatis|masuk antrean/i);
});


test('submission cards expose finance action only for manager-approved finance requests', () => {
  const sandbox = { document: { querySelector: () => null }, window: {}, Intl, Date }; vm.createContext(sandbox);
  vm.runInContext(source.replace('initialize();', "state.user={id:'m',role:'manager'}; globalThis.__approved=submissionCard({id:'approved',type:'finance_request',status:'approved',description:'Approved',amountIdr:1000,date:'2026-10-18',createdAt:'2026-10-18T01:00:00Z'}, {financeActions:true}); globalThis.__pending=submissionCard({id:'pending',type:'petty_cash',status:'approved',description:'Petty',amountIdr:1000,date:'2026-10-18',createdAt:'2026-10-18T01:00:00Z'}, {financeActions:true});"), sandbox);
  assert.match(sandbox.__approved, /data-action=\"send-finance\"/);
  assert.doesNotMatch(sandbox.__pending, /send-finance/);
});
