import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const build = JSON.parse(fs.readFileSync(new URL('../site/version.json', import.meta.url))).build;
const source = fs.readFileSync(new URL('../site/sw.js', import.meta.url), 'utf8');

function createWorker({ fail = new Set(), noStore = new Set(), holdPut = false } = {}) {
  const BrowserRequest = class extends Request {
    constructor(input, init) {
      const url = typeof input === 'string' && input.startsWith('/') ? `https://app.test${input}` : input?.url || input;
      super(url, init);
    }
  };
  const stores = new Map();
  const entries = new Map();
  const deleted = [];
  const messages = [];
  let releasePut;
  let putStarted;
  const putReady = new Promise(resolve => { releasePut = resolve; });
  const putSeen = new Promise(resolve => { putStarted = resolve; });
  let skipped = 0;
  const listeners = {};
  const cache = {
    async put(request, response) {
      if (holdPut) putStarted();
      if (holdPut) await putReady;
      entries.set(new BrowserRequest(request).url, response);
    },
    async match(request) { return entries.get(new BrowserRequest(request).url); },
  };
  const caches = {
    async open(name) { stores.set(name, stores.get(name) || new Map()); return cache; },
    async match(request) { return entries.get(new BrowserRequest(request).url) || entries.get('https://app.test/'); },
    async keys() { return ['old-shell', `pangsuma-app-shell-v27-${build}`]; },
    async delete(name) { deleted.push(name); if (name === `pangsuma-app-shell-v27-${build}`) entries.clear(); stores.delete(name); return true; },
  };
  const worker = {
    location: { origin: 'https://app.test' },
    clients: { claim: async () => {}, matchAll: async () => [{ postMessage: message => messages.push(message) }] },
    skipWaiting: async () => { skipped += 1; },
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  const context = {
    self: worker,
    caches,
    Request: BrowserRequest,
    Response,
    Headers,
    URL,
    fetch: async request => {
      const url = new URL(request.url).pathname + new URL(request.url).search;
      if (fail.has(url)) throw new Error(`offline: ${url}`);
      return new Response(`body:${url}`, {
        status: 200,
        headers: noStore.has(url) ? { 'Cache-Control': 'no-store' } : {},
      });
    },
    console,
  };
  vm.runInNewContext(source, context, { filename: 'sw.js' });
  return { listeners, stores, deleted, messages, fail, get skipped() { return skipped; }, caches, worker, putSeen, releasePut };
}

async function dispatch(worker, type, event = {}) {
  let promise;
  event.waitUntil = value => { promise = Promise.resolve(value); };
  worker.listeners[type](event);
  await promise;
  return event;
}

test('install tolerates optional precache failures, activates, and serves cached shell offline', async () => {
  const sw = createWorker({ fail: new Set(['/manifest.webmanifest']) });
  await dispatch(sw, 'install');
  assert.equal(sw.skipped, 1);
  assert.ok(sw.caches && sw.stores.has(`pangsuma-app-shell-v27-${build}`));

  await dispatch(sw, 'activate');
  assert.deepEqual(sw.deleted, ['old-shell']);
  assert.equal(sw.messages.length, 1);
  assert.equal(sw.messages[0].type, 'APP_UPDATE_AVAILABLE');
  assert.equal(sw.messages[0].build, build);

  const event = { request: { url: 'https://app.test/', method: 'GET', mode: 'navigate' } };
  // Simulate loss of connectivity after the successful install.
  sw.fail?.add('/');
  let response;
  event.respondWith = value => { response = Promise.resolve(value); };
  sw.listeners.fetch(event);
  assert.ok(response);
  assert.equal((await sw.caches.match('/')).status, 200);
});

test('mandatory shell failure rejects install, removes partial cache, and does not activate', async () => {
  const sw = createWorker({ fail: new Set([`/app.js?v=${build}`]) });
  await assert.rejects(dispatch(sw, 'install'), /Mandatory shell asset unavailable|offline/);
  assert.equal(sw.skipped, 0);
  assert.deepEqual(sw.deleted, [`pangsuma-app-shell-v27-${build}`]);
});

test('mandatory failure waits for all cache writes before deleting the cache', async () => {
  const sw = createWorker({ fail: new Set([`/app.js?v=${build}`]), holdPut: true });
  let install;
  sw.listeners.install({ waitUntil(value) { install = value; } });
  await sw.putSeen;
  assert.deepEqual(sw.deleted, []);
  sw.releasePut();
  await assert.rejects(install, /Mandatory shell asset unavailable|offline/);
  assert.deepEqual(sw.deleted, [`pangsuma-app-shell-v27-${build}`]);
  assert.equal(sw.stores.has(`pangsuma-app-shell-v27-${build}`), false);
});

test('no-store responses are never precached; mandatory no-store response fails safely', async () => {
  const optional = createWorker({ noStore: new Set(['/manifest.webmanifest']) });
  await dispatch(optional, 'install');
  assert.equal(optional.stores.has('https://app.test/manifest.webmanifest'), false);
  assert.equal(optional.skipped, 1);

  const mandatory = createWorker({ noStore: new Set(['/']) });
  await assert.rejects(dispatch(mandatory, 'install'), /Mandatory shell asset unavailable/);
  assert.equal(mandatory.skipped, 0);
});
