import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../site/report-filters.js', import.meta.url), 'utf8');
test('report client uses bounded cursor pages and does not append an unbounded list', () => {
  assert.match(source, /const PAGE_SIZE = 25/);
  assert.match(source, /p\.set\('limit', String\(PAGE_SIZE\)\)/);
  assert.match(source, /AbortController/);
  assert.match(source, /data-manager-report-action="after"/);
  assert.doesNotMatch(source, /\[\.\.\.current\.items, \.\.\.result\.items\]/);
  assert.match(source, /aria-live="polite"/);
});
test('PDF URL is built from applied filters only, not cursor state', () => {
  assert.match(source, /function pdfUrl\(\).*params\(\)/s);
  assert.doesNotMatch(source, /pdfUrl[\s\S]{0,500}nextCursor/);
});

import vm from 'node:vm';
const settle = () => new Promise(resolve => setImmediate(resolve));
function clientHarness() {
  const events = {}, timers = new Map(), calls = []; let sequence = 0, actor = { id:'manager-1', role:'manager' };
  const context = vm.createContext({
    window:{}, document:{ activeElement:null, addEventListener:(name, handler) => { events[name] = handler; }, querySelector:() => null },
    URLSearchParams, AbortController, queueMicrotask,
    FormData:class { constructor(form) { this.form = form; } get(name) { return this.form.values[name] ?? null; } },
    setTimeout:fn => { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout:id => timers.delete(id),
  });
  vm.runInContext(source, context);
  const client = context.window.ManagerReportFilters;
  client.configure({ getUser:() => actor, renderCard:item => `<article>${item.id}</article>`, api:async path => {
    calls.push(path); const cursor = new URLSearchParams(path.split('?')[1]).get('cursor');
    return { items:[{ id:cursor ? 'second-page' : 'first-page' }], total:51, hasMore:true, nextCursor:'cursor-after', previousCursor:cursor ? 'cursor-before' : null };
  } });
  const form = { id:'managerReportFiltersForm', isConnected:true, values:{ q:'nota' }, reportValidity:() => true, checkValidity:() => true };
  const input = () => events.input({ target:{ form, name:'q', value:form.values.q } });
  const click = action => { const button = { dataset:{ managerReportAction:action } }; events.click({ target:{ closest:() => button } }); };
  const flushTimers = () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); };
  return { client, calls, events, timers, form, input, click, flushTimers, setUser:value => { actor = value; } };
}
test('submitting search then paging cancels the pending debounce and preserves cursor/PDF filters', async () => {
  const h = clientHarness(); h.client.render(); await settle();
  h.input(); assert.equal(h.timers.size, 1);
  h.events.submit({ target:h.form, preventDefault() {} }); await settle();
  assert.equal(h.timers.size, 0);
  h.click('after'); await settle(); h.flushTimers(); await settle();
  assert.equal(h.calls.length, 3);
  const last = new URLSearchParams(h.calls.at(-1).split('?')[1]);
  assert.equal(last.get('cursor'), 'cursor-after'); assert.equal(last.get('q'), 'nota');
  assert.equal(h.client.pdfUrl(), '/api/export.pdf?q=nota');
  assert.match(h.client.render(), /second-page/);
});
test('clearing a session cancels its pending search before a different actor can inherit it', async () => {
  const h = clientHarness(); h.client.render(); await settle(); h.input();
  h.client.clear(); h.setUser({ id:'user-2', role:'user' }); h.flushTimers(); await settle();
  assert.equal(h.calls.length, 1); assert.equal(h.client.render(), '');
  h.setUser({ id:'manager-2', role:'manager' });
  assert.equal(h.client.pdfUrl(), '/api/export.pdf');
});
test('a detached or incomplete custom-range form never auto-applies its stale draft', async () => {
  const h = clientHarness(); h.client.render(); await settle();
  h.input(); h.form.isConnected = false; h.flushTimers(); await settle();
  assert.equal(h.calls.length, 1);
  h.form.isConnected = true; h.form.checkValidity = () => false; h.input(); h.flushTimers(); await settle();
  assert.equal(h.calls.length, 1);
});
