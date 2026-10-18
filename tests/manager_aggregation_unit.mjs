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
function harness() {
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
      user: { id: 'manager', role: 'manager' }, submissions,
      summary: { financeWaiting: 25, financeTotal: 50, financeSent: 20 },
      cashBalanceIdr: 100000, cashLedger: [], history: { cashLedger: { loaded: 0, total: 0 } }
    },
    pageHeading: (title, subtitle, actions = '') => `${title} ${subtitle} ${actions}`,
    metricCard: (_icon, label, value) => `${label}=${value};`,
    submissionCard: (item, options = {}) => `<card>${item.id}</card>${options.financeActions && item.type === 'finance_request' && item.status === 'approved' ? `<button data-action="send-finance" data-id="${item.id}">Send</button>` : ''}`,
    money: String, compactMoney: String, escapeHTML: String,
    submissionMeta: () => '', historyControls: () => '', emptyState: title => title,
    cashInsightsRegion: () => '<cash-insights/>', ledgerRow: () => '', userOverview: () => 'user-only'
  });
  context.window = {};
  vm.runInContext(source.slice(source.indexOf('function isPangsumaApkWrapper() {'), source.indexOf('async function downloadPdf(button) {')), context);
  vm.runInContext(`${functionSource('financePage')}\n${functionSource('cashInfo')}`, context);
  return context;
}

test('Pengeluaran menggabungkan Manager dan User approved tanpa pending atau rejected', () => {
  const html = vm.runInContext('cashInfo()', harness());
  assert.match(html, /<card>manager-petty<\/card>/);
  assert.match(html, /<card>user-petty-approved<\/card>/);
  assert.doesNotMatch(html, /user-petty-pending|user-petty-rejected|manager-finance/);
});

test('Finance fallback renders each report once and only approved finance requests can be sent', () => {
  const context = harness();
  const html = vm.runInContext('financePage()', context);
  for (const item of context.state.submissions) assert.equal(html.split(`<card>${item.id}</card>`).length - 1, 1);
  const sendIds = [...html.matchAll(/data-action="send-finance" data-id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(sendIds, ['manager-finance', 'user-finance-approved']);
  assert.match(html, /data-panel="cash-insights"/);
});

test('filtered workspace is the only Finance list, without duplicate totals or cards', () => {
  const context = harness();
  context.ManagerReportFilters = { render: () => '<filtered-workspace/>', pdfUrl: () => '/api/export.pdf?q=applied' };
  const html = vm.runInContext('financePage()', context);
  assert.equal(html.split('<filtered-workspace/>').length - 1, 1);
  assert.doesNotMatch(html, /<card>|Ringkasan Finance|Belum dikirim=|Total request=|Terkirim=/);
  assert.match(html, /id="managerPdfFallback" hidden/);
  assert.equal(context.ManagerReportFilters.pdfUrl(), '/api/export.pdf?q=applied');
  assert.match(html, /id="financeReportsTitle">Laporan/);
  assert.match(html, /id="financeCashTitle">Pengelolaan kas/);
  assert.equal((html.match(/data-action="download-pdf"/g) || []).length, 1);
  assert.equal((html.match(/data-action="open-cash-topup"/g) || []).length, 1);
});

test('Finance APK fallback is status only, even without PwaFiles helper', () => {
  const context = harness();
  context.window.PangsumaFileBridge = { saveCsv() { throw new Error('must not call CSV bridge'); } };
  const html = vm.runInContext('financePage()', context);
  assert.match(html, /Unduh PDF langsung memerlukan APK yang diperbarui\./);
  assert.doesNotMatch(html, /managerPdfFallbackLink|Chrome|Safari|intent:|Salin tautan|\/api\/export\.pdf/);
});
