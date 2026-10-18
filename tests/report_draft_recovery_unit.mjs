import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function draftKey('), source.indexOf('\nfunction hasUnsavedDraft('));
const formCode = source.slice(source.indexOf('function reportForm('), source.indexOf('\nfunction cashInfo('));
function harness() {
  const storage = new Map();
  const form = Object.fromEntries(Object.entries({ type: 'finance_request', amountIdr: '125000', date: '2026-10-19', description: 'Draf Finance', note: 'Catatan Finance' }).map(([key, value]) => [key, { value }]));
  const context = vm.createContext({
    state: { user: { id: 'manager-a', role: 'manager' } }, reportTypePreset: 'finance_request', submissionIdempotencyKey: 'finance-key',
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    $: selector => selector === '#reportForm' ? form : null,
    pageHeading: () => '', escapeHTML: value => String(value), todayISO: () => '2026-10-19'
  });
  vm.runInContext(helpers + '\n' + formCode, context);
  return { context, form, storage };
}
test('Finance selection and fields recover together after a fresh runtime', () => {
  const { context: c } = harness();
  c.persistReportDraft();
  c.reportTypePreset = 'petty_cash';
  c.reportTypePreset = c.restoreReportType();
  const html = c.reportForm();
  assert.equal(c.reportTypePreset, 'finance_request');
  assert.match(html, /value="finance_request" selected/);
  assert.match(html, /Draf Finance/);
  assert.match(html, /125000/);
});
test('Petty cash selection is remembered even when both drafts exist', () => {
  const { context: c } = harness();
  c.persistReportDraft('finance_request');
  c.writeDraft('report', 'petty_cash', { description: 'Petty only' });
  c.rememberReportType('petty_cash');
  assert.equal(c.restoreReportType(), 'petty_cash');
  assert.equal(c.reportDraft('finance_request').description, 'Draf Finance');
});
test('legacy Finance-only draft recovers without deleting or rewriting it', () => {
  const { context: c, storage } = harness();
  c.writeDraft('report', 'finance_request', { description: 'Legacy Finance' });
  const before = [...storage.entries()];
  assert.equal(c.restoreReportType(), 'finance_request');
  assert.deepEqual([...storage.entries()], before);
});
test('legacy ambiguous drafts use safe default without destroying either', () => {
  const { context: c } = harness();
  c.writeDraft('report', 'finance_request', { description: 'Finance' });
  c.writeDraft('report', 'petty_cash', { description: 'Petty' });
  assert.equal(c.restoreReportType(), 'petty_cash');
  assert.equal(c.reportDraft('finance_request').description, 'Finance');
});
test('change saves outgoing fields to old type, never the already changed select', () => {
  const { context: c, form } = harness();
  form.type.value = 'petty_cash';
  c.persistReportDraft('finance_request');
  assert.equal(c.reportDraft('finance_request').description, 'Draf Finance');
  assert.equal(c.readDraft('report', 'petty_cash'), null);
  c.rememberReportType('petty_cash');
  assert.equal(c.restoreReportType(), 'petty_cash');
});
test('rendering a type with no draft clears the previous idempotency key and fields', () => {
  const { context: c } = harness();
  c.persistReportDraft();
  c.reportTypePreset = 'petty_cash';
  const html = c.reportForm();
  assert.equal(c.submissionIdempotencyKey, '');
  assert.doesNotMatch(html, /Draf Finance|Catatan Finance|125000/);
});
test('each type recovers its own idempotency key and fingerprint', () => {
  const { context: c } = harness();
  c.writeDraft('report', 'finance_request', { description: 'Finance', idempotencyKey: 'fin', submittedFingerprint: 'fin-fingerprint' });
  c.writeDraft('report', 'petty_cash', { description: 'Petty', idempotencyKey: 'petty', submittedFingerprint: 'petty-fingerprint' });
  c.reportForm(); assert.equal(c.submissionIdempotencyKey, 'fin');
  c.reportTypePreset = 'petty_cash'; c.reportForm(); assert.equal(c.submissionIdempotencyKey, 'petty');
  c.persistReportDraft();
  assert.equal(c.reportDraft('petty_cash').submittedFingerprint, 'petty-fingerprint');
  assert.equal(c.reportDraft('finance_request').submittedFingerprint, 'fin-fingerprint');
});
test('drafts and selected type are isolated by signed-in account', () => {
  const { context: c } = harness();
  c.persistReportDraft();
  c.state.user = { id: 'user-b', role: 'user' };
  assert.equal(c.restoreReportType(), 'petty_cash');
  assert.equal(c.readDraft('report', 'finance_request'), null);
  c.state.user = { id: 'manager-a', role: 'manager' };
  assert.equal(c.restoreReportType(), 'finance_request');
});
test('corrupt or unsupported selection metadata never creates an invalid request type', () => {
  const { context: c, storage } = harness();
  storage.set(c.draftKey('report-selection'), '{broken');
  assert.equal(c.restoreReportType(), 'petty_cash');
  c.writeDraft('report-selection', '', { type: 'not-a-request' });
  assert.equal(c.restoreReportType(), 'petty_cash');
  c.rememberReportType('not-a-request');
  c.persistReportDraft('not-a-request');
  assert.equal(c.readDraft('report', 'not-a-request'), null);
});
test('storage unavailable is handled without crashing or leaking an old selection', () => {
  const { context: c } = harness();
  c.sessionStorage.getItem = () => { throw Error('unavailable'); };
  c.sessionStorage.setItem = () => { throw Error('quota'); };
  assert.doesNotThrow(() => c.persistReportDraft());
  assert.equal(c.restoreReportType(), 'petty_cash');
});
test('selection metadata contains only request type, never form contents', () => {
  const { context: c } = harness();
  c.persistReportDraft();
  assert.deepEqual(JSON.parse(JSON.stringify(c.readDraft('report-selection'))), { type: 'finance_request' });
});
test('both password/passkey login and restored sessions initialize their own selection', () => {
  assert.match(source.slice(source.indexOf('async function completeLogin('), source.indexOf('async function performPasskeyLogin(')), /state\.user = result\.user;\s+reportTypePreset = restoreReportType\(\)/);
  assert.match(source.slice(source.indexOf('async function initialize(')), /state\.user = result\.user;\s+reportTypePreset = restoreReportType\(\)/);
  const change = source.slice(source.indexOf("document.addEventListener('change', event => {"));
  assert.ok(change.indexOf('persistReportDraft(reportTypePreset)') < change.indexOf('reportTypePreset = String(event.target.value)'));
});
