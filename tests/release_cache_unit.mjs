import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../site/sw.js', import.meta.url), 'utf8');

test('HTML and service worker precache the same release-specific executable assets', () => {
  const build = html.match(/name="app-build" content="([^"]+)"/)[1];
  assert.equal(JSON.parse(fs.readFileSync(new URL('../site/version.json', import.meta.url), 'utf8')).build, build);
  const executableAssets = [...html.matchAll(/(?:src|href)="\/([^"?]+\.(?:js|css))\?v=([^"&]+)"/g)];
  assert.ok(executableAssets.length >= 11);
  for (const [, asset, version] of executableAssets) {
    assert.equal(version, build, `${asset} must use the running build`);
    assert.ok(html.includes(`/${asset}?v=${build}`));
    assert.ok(worker.includes(`/${asset}?v=${build}`));
  }
  assert.ok(html.includes(`Versi ${build}`));
});

test('versioned shell fetch revalidates network and export is never intercepted', async () => {
  const events = {};
  const fetched = [];
  const context = {
    Request, Response, URL, Promise,
    self: { location: { origin: 'https://app.test' }, addEventListener: (name, fn) => events[name] = fn },
    caches: { open: async () => ({ put: async () => {} }), match: async () => new Response('stale') },
    fetch: async request => { fetched.push(request); return new Response('fresh'); },
  };
  vm.runInNewContext(worker, context);
  let response;
  events.fetch({ request: new Request('https://app.test/app.js?v=2026.10.18.2'), respondWith: promise => response = promise });
  assert.equal(await (await response).text(), 'fresh');
  assert.equal(fetched[0].cache, 'no-cache');
  let intercepted = false;
  events.fetch({ request: new Request('https://app.test/api/export.csv'), respondWith: () => intercepted = true });
  assert.equal(intercepted, false);
});
