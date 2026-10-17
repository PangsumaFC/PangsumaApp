import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
function helpers() {
  const context = { document: { querySelector: () => null }, Intl, Date, String, Number, Boolean, Array, JSON, Math };
  vm.createContext(context);
  const injected = source.replace('initialize();', 'globalThis.__dashboard = { submissionTimeline, managerOverview, userOverview };');
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
  const sandbox = { document: { querySelector: () => null }, Intl, Date };
  vm.createContext(sandbox);
  vm.runInContext(source.replace('initialize();', "state.user={id:'m',role:'manager',name:'Manager'}; state.cashBalanceIdr=125000; state.submissions=[]; state.summary={pending:7,financeWaiting:3,today:4}; globalThis.__html=managerOverview();"), sandbox);
  const html = sandbox.__html;
  assert.match(html, /125\.000/);
  assert.match(html, /Menunggu persetujuan/);
  assert.match(html, />7<\/strong>/);
  assert.ok(html.indexOf('Saldo petty cash') < html.indexOf('Buat pengajuan'));
  assert.ok(html.indexOf('Menunggu persetujuan') < html.indexOf('Antrean tindakan'));
});

test('userOverview exposes exactly one primary CTA and concise intro', () => {
  const sandbox = { document: { querySelector: () => null }, Intl, Date };
  vm.createContext(sandbox);
  vm.runInContext(source.replace('initialize();', "state.user={id:'u',role:'user',name:'User'}; state.submissions=[]; state.summary={}; globalThis.__html=userOverview();"), sandbox);
  const html = sandbox.__html;
  assert.equal((html.match(/class=\"primary-button home-report-cta\"/g) || []).length, 1);
  assert.match(html, /Kirim kebutuhan, pantau status\./);
  assert.doesNotMatch(html, /status metadata/i);
});

test('offline notice copy is explicit that no queued data is promised', () => {
  const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(html, /Koneksi terputus\. Data terakhir tetap tampil; sambungkan kembali sebelum mengirim\./);
  assert.doesNotMatch(html, /akan dikirim otomatis|masuk antrean/i);
});
