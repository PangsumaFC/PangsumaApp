import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const downloadSource = source.slice(source.indexOf('async function downloadCsv('), source.indexOf('\nasync function loadMoreHistory('));
const actionSource = source.slice(source.indexOf('async function handleAction('), source.indexOf('\nasync function logout('));

function harness({ role = 'manager', response, fetchError, changeSession = false, bridge = false, nativeDownloads = false } = {}) {
  const calls = { requests: [], anchors: [], busy: [], toasts: [], login: [], timers: [], revoked: [] };
  const sandbox = {
    state: { user: { role } }, authEpoch: 1,
    window: {
      PangsumaFileBridge: bridge ? {} : undefined,
      __pangsumaNativeDownloads: nativeDownloads,
      setTimeout: (callback, delay) => calls.timers.push({ callback, delay })
    },
    URL: {
      createObjectURL: () => 'blob:legacy-apk-only',
      revokeObjectURL: url => calls.revoked.push(url)
    },
    setButtonBusy: (...args) => calls.busy.push(args),
    showToast: text => calls.toasts.push(text),
    friendlyError: error => error.message,
    showLogin: text => { calls.login.push(text); sandbox.authEpoch++; sandbox.state.user = null; },
    todayISO: () => '2026-10-18',
    ApiFailure: class extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } },
    fetch: async (...args) => {
      calls.requests.push(args);
      if (fetchError) throw fetchError;
      if (changeSession) sandbox.authEpoch++;
      return response;
    },
    document: {
      body: { append: anchor => { anchor.appended = true; } },
      createElement: tag => {
        assert.equal(tag, 'a');
        const anchor = { click() { this.clicked = true; }, remove() { this.removed = true; } };
        calls.anchors.push(anchor);
        return anchor;
      }
    }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(downloadSource, context);
  return { calls, sandbox, run: () => context.downloadCsv({ isConnected: true }) };
}

function csvResponse() {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="server-report.csv"' }
  });
  response.blob = () => { throw new Error('Must not buffer CSV into a blob'); };
  return { response, cancelled: () => cancelled };
}

test('CSV passes authenticated server URL to download handler, never a blob, and does not claim saved', async () => {
  const fixture = csvResponse();
  const h = harness(fixture);
  await h.run();
  assert.equal(fixture.cancelled(), true);
  assert.equal(h.calls.requests[0][0], '/api/export.csv');
  assert.equal(h.calls.requests[0][1].credentials, 'same-origin');
  assert.equal(h.calls.requests[0][1].cache, 'no-store');
  assert.equal(h.calls.anchors.length, 1);
  assert.equal(h.calls.anchors[0].href, '/api/export.csv');
  assert.equal(h.calls.anchors[0].download, 'server-report.csv');
  assert.equal(h.calls.anchors[0].clicked, true);
  assert.equal(h.calls.anchors[0].removed, true);
  assert.match(h.calls.toasts[0], /Permintaan unduh/);
  assert.equal(h.calls.busy.at(-1)[1], false);
});

test('new APK capability selects HTTPS even when the backwards-compatible CSV bridge exists', async () => {
  const fixture = csvResponse();
  const h = harness({ ...fixture, bridge: true, nativeDownloads: true });
  await h.run();
  assert.equal(fixture.cancelled(), true);
  assert.equal(h.calls.anchors[0].href, '/api/export.csv');
  assert.equal(h.calls.timers.length, 0);
});

test('old APK retains its existing blob bridge rather than receiving an unsupported HTTPS download', async () => {
  const h = harness({ bridge: true, response: new Response('csv bytes') });
  await h.run();
  assert.equal(h.calls.anchors[0].href, 'blob:legacy-apk-only');
  assert.equal(h.calls.timers[0].delay, 60_000);
  h.calls.timers[0].callback();
  assert.deepEqual(h.calls.revoked, ['blob:legacy-apk-only']);
});

test('User cannot start CSV request or receive a download URL', async () => {
  const h = harness({ role: 'user' });
  await h.run();
  assert.equal(h.calls.requests.length, 0);
  assert.equal(h.calls.anchors.length, 0);
});

test('expired session returns to login without triggering a file download', async () => {
  const h = harness({ response: new Response(JSON.stringify({ error: { code: 'authentication_required' } }), { status: 401 }) });
  await h.run();
  assert.equal(h.calls.login.length, 1);
  assert.equal(h.calls.anchors.length, 0);
  assert.equal(h.calls.toasts.length, 0);
  assert.equal(h.calls.busy.at(-1)[1], false);
});

test('403, server failures, and offline errors remain visible without a false success', async () => {
  for (const status of [403, 500]) {
    const h = harness({ response: new Response(JSON.stringify({ error: { message: `failure-${status}` } }), { status }) });
    await h.run();
    assert.equal(h.calls.anchors.length, 0);
    assert.deepEqual(h.calls.toasts, [`failure-${status}`]);
    assert.equal(h.calls.busy.at(-1)[1], false);
  }
  const h = harness({ fetchError: new Error('Offline') });
  await h.run();
  assert.deepEqual(h.calls.toasts, ['Offline']);
  assert.equal(h.calls.anchors.length, 0);
});

test('session changes during authorization cancel the stream and suppress stale download', async () => {
  const fixture = csvResponse();
  const h = harness({ ...fixture, changeSession: true });
  await h.run();
  assert.equal(fixture.cancelled(), true);
  assert.equal(h.calls.anchors.length, 0);
});

test('photo chooser click remains synchronous inside the original tap activation', async () => {
  let clicked = false;
  const context = vm.createContext({ $: selector => {
    assert.equal(selector, '#profilePhoto');
    return { click: () => { clicked = true; } };
  } });
  vm.runInContext(actionSource, context);
  const pending = context.handleAction({ dataset: { action: 'choose-profile-photo' } });
  assert.equal(clicked, true, 'Do not defer picker behind await or a timer');
  await pending;
});
