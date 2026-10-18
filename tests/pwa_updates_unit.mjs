import test from 'node:test';
import assert from 'node:assert/strict';
import { createPwaUpdateCoordinator, isNewerBuild } from '../site/pwa-updates.js';

function harness({ hidden = false, online = true } = {}) {
  const listeners = new Map();
  const swListeners = new Map();
  const calls = [];
  const win = {
    location: { reload: () => calls.push('reload') },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const document = {
    hidden,
    addEventListener(type, fn) { listeners.set(`document:${type}`, fn); },
    removeEventListener(type) { listeners.delete(`document:${type}`); },
  };
  const serviceWorker = {
    addEventListener(type, fn) { swListeners.set(type, fn); },
    removeEventListener(type) { swListeners.delete(type); },
    async getRegistration() { return registration; },
  };
  let resolveUpdate;
  const registration = { update: () => { calls.push('update-start'); return new Promise(resolve => { resolveUpdate = () => { calls.push('update-done'); resolve(); }; }); } };
  const nav = { onLine: online, serviceWorker };
  return { window: win, document, navigator: nav, calls, listeners, swListeners, registration, releaseUpdate: () => resolveUpdate() };
}

test('compares only valid date-build metadata and accepts the deployed patch increment', () => {
  assert.equal(isNewerBuild('2026.10.18.5', '2026.10.18.4'), true);
  assert.equal(isNewerBuild('2026.10.18.4', '2026.10.18.5'), false);
  assert.equal(isNewerBuild('2026.10.18.10', '2026.10.18.9'), true);
  assert.equal(isNewerBuild('latest', '2026.10.18.4'), false);
});

test('deduplicates concurrent checks and exposes the current available build', async () => {
  const h = harness();
  let resolveFetch;
  const seen = [];
  const coordinator = createPwaUpdateCoordinator({
    currentBuild: '2026.10.18.4', ...h,
    fetchVersion: () => { seen.push(1); return new Promise(resolve => { resolveFetch = resolve; }); },
    setAvailable: build => seen.push(build),
  });
  const first = coordinator.check();
  const second = coordinator.check();
  assert.strictEqual(first, second);
  await Promise.resolve();
  resolveFetch({ build: '2026.10.18.5' });
  assert.equal(await first, true);
  assert.deepEqual(seen, [1, '2026.10.18.5']);
  assert.equal(coordinator.availableBuild, '2026.10.18.5');
});

test('checks on focus, pageshow, online, visibility and service-worker version messages', async () => {
  const h = harness();
  const builds = [];
  const coordinator = createPwaUpdateCoordinator({ currentBuild: '2026.10.18.4', ...h, fetchVersion: async () => ({ build: '2026.10.18.5' }), setAvailable: b => builds.push(b) }).bind();
  for (const type of ['focus', 'pageshow', 'online']) await h.listeners.get(type)();
  h.listeners.get('document:visibilitychange')();
  h.swListeners.get('message')({ data: { type: 'APP_UPDATE_AVAILABLE', build: '2026.10.18.5' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.availableBuild, '2026.10.18.5');
  assert.ok(builds.length >= 1);
  coordinator.unbind();
  assert.equal(h.listeners.size, 0);
});

test('does not check while hidden/offline unless forced, and awaits registration update before reload', async () => {
  const h = harness({ hidden: true });
  let checks = 0;
  const coordinator = createPwaUpdateCoordinator({ currentBuild: '2026.10.18.4', ...h, fetchVersion: async () => { checks++; return { build: '2026.10.18.5' }; } });
  assert.equal(await coordinator.check(), false);
  assert.equal(checks, 0);
  const reloading = coordinator.reload();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, ['update-start']);
  h.releaseUpdate();
  assert.equal(await reloading, true);
  assert.deepEqual(h.calls, ['update-start', 'update-done', 'reload']);
});

test('blocked reload preserves drafts and in-flight transactions', async () => {
  const h = harness();
  const coordinator = createPwaUpdateCoordinator({ ...h, isBlocked: () => true });
  assert.equal(await coordinator.reload(), false);
  assert.deepEqual(h.calls, []);
});

test('explicit reload waits for worker activation rather than only update script fetch', async () => {
  const h = harness(); let listener;
  const worker = { state: 'installing', addEventListener(type, fn) { listener = fn; }, removeEventListener() {} };
  const registration = { installing: worker, update: async () => {} };
  const coordinator = createPwaUpdateCoordinator({ ...h, getRegistration: async () => registration });
  const pending = coordinator.reload(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, []);
  worker.state = 'activated'; listener();
  assert.equal(await pending, true); assert.deepEqual(h.calls, ['reload']);
});

test('failed version checks expose an error and do not claim latest', async () => {
  const h = harness();
  const coordinator = createPwaUpdateCoordinator({ ...h, currentBuild: '2026.10.18.6', fetchVersion: async () => { throw new Error('offline'); } });
  assert.equal(await coordinator.check(), false); assert.match(coordinator.lastError.message, /offline/);
});
