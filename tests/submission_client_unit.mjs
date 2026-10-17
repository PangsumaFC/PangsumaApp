import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function newSubmissionKey(');
const code = source.slice(start < 0 ? source.indexOf('async function performNewSubmission(') : start, source.indexOf('\nasync function downloadCsv('));
function harness({ crypto = webcrypto, refreshFails = false, saveFails = false } = {}) {
  const button = { isConnected: true, disabled: false };
  const form = { reportValidity: () => true, querySelector: () => button };
  const calls = { posts: [], toasts: [], renders: 0 };
  const context = vm.createContext({
    crypto, Uint8Array, Error, FormData: class { get(name) { return { type: 'finance_request', amountIdr: '125000', date: '2026-10-18', description: 'Laporan lokal', note: '' }[name]; } },
    ApiFailure: class extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } },
    $: () => form, state: { user: { role: 'manager' } }, submissionIdempotencyKey: '', currentPage: 'new-report',
    setButtonBusy: (target, busy) => { target.disabled = busy; },
    api: async (path, options) => { calls.posts.push(options); if (saveFails) throw Error('offline'); return { submission: { id: 'saved' } }; },
    refreshOverview: async () => { if (refreshFails) throw Error('refresh offline'); },
    renderApp: () => { calls.renders++; }, showToast: text => calls.toasts.push(text), friendlyError: error => error.message
  });
  vm.runInContext(code, context);
  return { calls, context, submit: () => context.performNewSubmission({ preventDefault() {} }) };
}

test('pengajuan tetap terkirim tanpa crypto.randomUUID dengan UUID acak aman', async () => {
  const h = harness({ crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } });
  await h.submit();
  assert.equal(h.calls.posts.length, 1);
  assert.match(h.calls.posts[0].headers['Idempotency-Key'], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('browser tanpa sumber acak aman menampilkan galat tanpa unhandled rejection atau POST', async () => {
  const h = harness({ crypto: {} });
  await h.submit();
  assert.equal(h.calls.posts.length, 0);
  assert.match(h.calls.toasts[0], /browser/i);
});

test('POST berhasil tetapi refresh gagal tidak meninggalkan form kirim duplikat', async () => {
  const h = harness({ refreshFails: true });
  await h.submit();
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.context.currentPage, 'overview');
  assert.equal(h.calls.renders, 1);
  assert.match(h.calls.toasts[0], /tersimpan/i);
  assert.match(h.calls.toasts[0], /ringkasan/i);
});

test('retry setelah POST gagal tetap memakai kunci idempotensi yang sama', async () => {
  const h = harness({ saveFails: true });
  await h.submit();
  await h.submit();
  assert.equal(h.calls.posts.length, 2);
  assert.equal(h.calls.posts[0].headers['Idempotency-Key'], h.calls.posts[1].headers['Idempotency-Key']);
  assert.equal(h.context.currentPage, 'new-report');
});
