import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/sw.js', import.meta.url), 'utf8');

function makeWorker({ cached = {}, networkBody = 'online', offline = false, cacheControl = '' } = {}) {
  const listeners = {};
  const puts = [];
  const fetches = [];
  const lifecycle = { skipWaiting: 0, claim: 0, deleted: [] };
  const cache = {
    match(request) {
      const key = typeof request === 'string' ? request : request.url;
      return Promise.resolve(cached[key]);
    },
    put(request, response) {
      const key = typeof request === 'string' ? request : request.url;
      puts.push([key, response]);
      return Promise.resolve();
    },
    addAll() { return Promise.resolve(); },
  };
  const context = {
    URL,
    Promise,
    console,
    self: {
      location: { origin: 'https://app.test' },
      addEventListener(type, callback) { listeners[type] = callback; },
      skipWaiting() { lifecycle.skipWaiting += 1; return Promise.resolve(); },
      clients: { claim() { lifecycle.claim += 1; return Promise.resolve(); } },
    },
    caches: {
      open() { return Promise.resolve(cache); },
      match(request) { return cache.match(request); },
      keys() { return Promise.resolve(['old-cache']); },
      delete(key) { lifecycle.deleted.push(key); return Promise.resolve(true); },
    },
    fetch(request) {
      fetches.push(request);
      if (offline) return Promise.reject(new Error('offline'));
      return Promise.resolve(new Response(networkBody, {
        status: 200,
        headers: { 'Content-Type': 'application/javascript', 'Cache-Control': cacheControl },
      }));
    },
    Request,
    Response,
  };
  vm.runInNewContext(source, context, { filename: 'site/sw.js' });
  return { listeners, puts, fetches, lifecycle };
}

function dispatchFetch(worker, request) {
  let responsePromise;
  worker.listeners.fetch({
    request,
    respondWith(value) { responsePromise = Promise.resolve(value); },
  });
  return responsePromise;
}

test('shell executable assets use the online response before a stale cache entry', async () => {
  const worker = makeWorker({
    cached: { 'https://app.test/app.js': new Response('old-app.js', { status: 200 }) },
    networkBody: 'new-app.js',
  });
  const response = await dispatchFetch(worker, new Request('https://app.test/app.js', { mode: 'same-origin' }));
  assert.equal(await response.text(), 'new-app.js');
  assert.equal(worker.fetches[0].cache, 'no-cache');
});

test('shell keeps its cached offline fallback when the network is unavailable', async () => {
  const worker = makeWorker({
    cached: { 'https://app.test/app.js': new Response('offline-shell') },
    offline: true,
  });
  const response = await dispatchFetch(worker, new Request('https://app.test/app.js'));
  assert.equal(await response.text(), 'offline-shell');
  assert.equal(worker.fetches.length, 1);
});

test('a no-store network response is delivered but never persisted', async () => {
  const worker = makeWorker({ networkBody: 'private', cacheControl: 'private, NO-STORE' });
  const response = await dispatchFetch(worker, new Request('https://app.test/app.js'));
  assert.equal(await response.text(), 'private');
  assert.deepEqual(worker.puts, []);
});

test('API requests are not intercepted or cached', async () => {
  const worker = makeWorker({ cached: { 'https://app.test/api/session': new Response('cached') } });
  let responded = false;
  worker.listeners.fetch({
    request: new Request('https://app.test/api/session'),
    respondWith() { responded = true; },
  });
  assert.equal(responded, false);
  assert.deepEqual(worker.puts, []);
});

test('install activates the new worker and activate claims clients while retiring old caches', async () => {
  const worker = makeWorker();
  let installWait;
  worker.listeners.install({ waitUntil(value) { installWait = value; } });
  await installWait;
  let activateWait;
  worker.listeners.activate({ waitUntil(value) { activateWait = value; } });
  await activateWait;
  assert.equal(worker.lifecycle.skipWaiting, 1);
  assert.equal(worker.lifecycle.claim, 1);
  assert.deepEqual(worker.lifecycle.deleted, ['old-cache']);
});

test('registration checks for updates without an automatic reload that could erase a draft', () => {
  const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  assert.match(app, /register\('\/sw\.js'\)[\s\S]*?\.then\(registration => registration\.update\(\)\)/);
  assert.doesNotMatch(app, /registration\.update\(\)[\s\S]{0,120}(?:location\.reload|window\.location)/);
});
