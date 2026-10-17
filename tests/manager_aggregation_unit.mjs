import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}
function harness(summary = {}) {
  const submissions = [
    ['manager-petty', 'petty_cash', 'approved', 'manager'],
    ['user-petty-approved', 'petty_cash', 'approved', 'user'],
    ['user-petty-pending', 'petty_cash', 'pending', 'user'],
    ['user-petty-rejected', 'petty_cash', 'rejected', 'user'],
    ['manager-finance', 'finance_request', 'approved', 'manager'],
    ['user-finance-approved', 'finance_request', 'approved', 'user'],
    ['user-finance-pending', 'finance_request', 'pending', 'user'],
    ['user-finance-rejected', 'finance_request', 'rejected', 'user'],
    ['user-finance-sent', 'finance_request', 'sent', 'user']
  ].map(([id, type, status, createdBy]) => ({ id, type, status, createdBy, description: id, amountIdr: 1000 }));
  const context = vm.createContext({
    state: {
      user: { id: 'manager', role: 'manager' }, submissions, summary,
      cashBalanceIdr: 100000, cashLedger: [], history: { cashLedger: { loaded: 0, total: 0 } }
    },
    pageHeading: (title, subtitle, actions = '') => `${title} ${subtitle} ${actions}`,
    metricCard: (_icon, label, value) => `${label}=${value};`,
    submissionCard: item => `<card>${item.id}</card>`,
    money: String, compactMoney: String, escapeHTML: String,
    submissionMeta: () => '', historyControls: () => '', emptyState: title => title,
    ledgerRow: () => '', userOverview: () => 'user-only'
  });
  vm.runInContext(`${functionSource('financePage')}\n${functionSource('cashInfo')}`, context);
  return context;
}

test('Pengeluaran menggabungkan Manager otomatis approved dan User approved tanpa pending/rejected', () => {
  const html = vm.runInContext('cashInfo()', harness());
  assert.match(html, /<card>manager-petty<\/card>/);
  assert.match(html, /<card>user-petty-approved<\/card>/);
  assert.doesNotMatch(html, /user-petty-pending|user-petty-rejected|manager-finance/);
});

test('Fallback ringkasan Finance hanya menghitung approved sebagai siap dikirim', () => {
  const html = vm.runInContext('financePage()', harness());
  assert.match(html, /Belum dikirim=2;/);
  assert.match(html, /Terkirim=1;/);
  const sendIds = [...html.matchAll(/data-action="send-finance" data-id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(sendIds, ['manager-finance', 'user-finance-approved']);
  assert.match(html, /Menunggu Manager/); // Pending is visible with its own label, never ready to send.
});

test('Ringkasan Finance dari server tetap dipakai untuk riwayat berpaginasi', () => {
  const html = vm.runInContext('financePage()', harness({ financeWaiting: 25, financeTotal: 50, financeSent: 20 }));
  assert.match(html, /Belum dikirim=25;/);
  assert.match(html, /Total request=50;/);
  assert.match(html, /Terkirim=20;/);
});
