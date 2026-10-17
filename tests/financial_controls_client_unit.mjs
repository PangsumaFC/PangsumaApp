import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/financial-controls.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(initialUser = { role:'manager', id:'m1' }, responder) {
  const calls = [], events = {}, storage = new Map(); let actor = initialUser, sequence = 0;
  const context = vm.createContext({
    window: { confirm:() => true }, document: { addEventListener:(name, handler) => { events[name] = handler; } },
    sessionStorage: { getItem:key => storage.get(key) || null, setItem:(key, value) => storage.set(key, value) },
    Intl, Date, URLSearchParams, Uint8Array, Math, JSON, console, queueMicrotask, crypto,
  });
  vm.runInContext(source, context);
  const control = context.window.FinancialControls;
  control.configure({ getUser:() => actor, newKey:() => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++sequence).padStart(12, '0')}`, api:async (path, options) => {
    calls.push({ path, options });
    if (responder) return responder(path, options);
    if (path.startsWith('/cash/reconciliations')) return { period:new URLSearchParams(path.split('?')[1]).get('period'), preview:{ ledgerBalanceIdr:'0' }, reconciliations:[], hasMore:false };
    if (path === '/financial/settings') return { version:0, minimumCashIdr:null, pendingMaxDays:null };
    return { cash:{ configured:false }, pending:{ configured:false } };
  } });
  const toggle = (section, open = true) => {
    const details = { dataset:{ fcSection:section }, open, isConnected:true }; details.closest = () => details;
    events.toggle({ target:details });
  };
  return { control, calls, events, storage, toggle, setUser:value => { actor = value; } };
}
function formOf(id, values) {
  const elements = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, key === 'confirmed' ? { checked:value } : { value }]));
  return { id, elements, closest:() => null, querySelector:() => ({ textContent:'' }) };
}
test('manager-only views and blank optional thresholds are real rendered output', () => {
  const h = harness({ role:'user', id:'u1' });
  assert.equal(h.control.renderFinance(), ''); assert.equal(h.control.renderOverview(), '');
  h.setUser({ role:'manager', id:'m1' });
  const html = h.control.renderFinance();
  assert.match(html, /Rekonsiliasi akhir bulan/);
  assert.match(html, /name="minimumCashIdr"[^>]+value=""/);
  assert.match(html, /name="pendingMaxDays"[^>]+max="3650"/);
  assert.match(html, /name="period"[^>]+max="\d{4}-\d{2}"/);
  assert.match(html, /name="confirmed" required/);
  assert.doesNotMatch(html, /Sesuaikan saldo/);
});
test('programmatic open toggles after render do not refetch or create a render loop', async () => {
  const h = harness(); h.control.renderFinance(); h.toggle('reconciliation'); await tick();
  assert.equal(h.calls.filter(c => c.path.startsWith('/cash/reconciliations')).length, 1);
  for (let i = 0; i < 10; i++) { h.control.renderFinance(); h.toggle('reconciliation'); }
  await tick();
  assert.equal(h.calls.filter(c => c.path.startsWith('/cash/reconciliations')).length, 1);
  h.toggle('reconciliation', false); h.toggle('reconciliation'); await tick();
  assert.equal(h.calls.filter(c => c.path.startsWith('/cash/reconciliations')).length, 2);
});
test('alerts are fetched once per refresh rather than once per render', async () => {
  const h = harness(); h.control.renderOverview(); await tick();
  for (let i = 0; i < 10; i++) h.control.renderOverview();
  await tick(); assert.equal(h.calls.filter(c => c.path === '/financial/alerts').length, 1);
  h.control.refresh(); h.control.renderOverview(); await tick();
  assert.equal(h.calls.filter(c => c.path === '/financial/alerts').length, 2);
});
test('stored notes are escaped and isolated per account', () => {
  const h = harness(); h.control.renderFinance();
  const form = formOf('fc-reconciliation-form', { physicalCashIdr:'125', note:'<img src=x onerror=alert(1)> & text', confirmed:false });
  h.events.input({ target:{ closest:() => form } });
  const html = h.control.renderFinance();
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; text/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.ok([...h.storage.keys()].every(key => key.endsWith(':m1')));
  h.control.clear(); h.setUser({ role:'manager', id:'m2' });
  assert.doesNotMatch(h.control.renderFinance(), /onerror/);
});
test('reconciliation retries retain the same payload key and never add a balance-change request', async () => {
  let posts = 0;
  const h = harness(undefined, async (path, options) => {
    if (options?.method === 'POST') { if (++posts === 1) throw new Error('Response lost'); return { alreadyApplied:true }; }
    return { reconciliations:[], preview:{ ledgerBalanceIdr:'0' }, hasMore:false };
  });
  const html = h.control.renderFinance();
  const period = html.match(/name="period"[^>]+value="([^"]+)"/)[1];
  const form = formOf('fc-reconciliation-form', { period, physicalCashIdr:'125', note:'Hasil hitung lokal', confirmed:true });
  h.events.submit({ target:form, preventDefault() {} }); await tick();
  assert.match(h.control.renderFinance(), /Response lost/);
  h.events.submit({ target:form, preventDefault() {} }); await tick();
  const requests = h.calls.filter(call => call.options?.method === 'POST');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers['Idempotency-Key'], requests[1].options.headers['Idempotency-Key']);
  assert.equal(requests[0].options.body.physicalCashIdr, 125);
  assert.ok(h.calls.every(call => call.path.startsWith('/cash/reconciliations')));
  assert.match(h.control.renderFinance(), /Rekonsiliasi tersimpan/);
});
