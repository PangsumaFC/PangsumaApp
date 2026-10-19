import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const controls = fs.readFileSync(new URL('../site/financial-controls.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../site/financial-controls.css', import.meta.url), 'utf8');

test('Finance keeps reports, filters, ledger, reconciliation, alerts, and settings in a small hierarchy', () => {
  assert.match(app, /class="finance-page"/);
  assert.match(app, /id="managerReportsRegion"/);
  assert.match(app, /data-panel="cash-ledger"/);
  assert.match(controls, /data-fc-section="reconciliation"/);
  assert.match(controls, /data-fc-section="settings"/);
  assert.match(controls, /aria-label="Peringatan keuangan"/);
  assert.doesNotMatch(app, /data-panel="cash-insights"/);
  assert.match(app, /class="cash-trend-details"/);
  assert.match(app, /cashInsightMoney\(account\)/);
  assert.match(app, /financialAlertsFinance/);
});

test('Finance exposes PDF actions only and has no frontend CSV export handler or UI', () => {
  assert.match(app, /data-action="download-pdf"/);
  assert.match(app, /data-report-type="petty_cash"/);
  assert.match(app, /data-report-type="finance_request"/);
  assert.doesNotMatch(app, /data-action="download-csv"|export\.csv|Unduh CSV|CSV only/i);
});

test('Finance controls remain manager-only and preserve keyboard focus affordances', () => {
  assert.match(controls, /if \(!manager\(\)\) return ''/);
  assert.match(css, /button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible/);
  assert.match(css, /@media \(max-width:720px\)/);
  assert.match(css, /@media \(max-width:420px\)/);
  assert.match(css, /cash-health-card/);
  assert.match(css, /cash-trend-details/);
});

test('Petty Cash balance remains on the dashboard and is not added to Finance controls', () => {
  assert.match(app, /<span>Saldo Petty Cash<\/span>/);
  assert.doesNotMatch(controls, /Saldo Petty Cash/);
});
