import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.js';

const REVALIDATED = [
  '/',
  '/index.html',
  '/app.js',
  '/password-crypto.js',
  '/sw.js',
  '/pangsuma-theme.css',
  '/manifest.webmanifest',
  '/version.json',
];

test('shell paths receive exact no-cache revalidation while APIs stay no-store', async () => {
  for (const pathname of REVALIDATED) {
    const response = await onRequest({
      request: new Request(`https://app.test${pathname}`),
      next: async () => new Response('ok', { headers: { 'Cache-Control': 'public, max-age=3600' } }),
    });
    assert.equal(response.headers.get('cache-control'), 'no-cache', pathname);
  }

  const api = await onRequest({
    request: new Request('https://app.test/api/session'),
    next: async () => new Response('ok'),
  });
  assert.equal(api.headers.get('cache-control'), 'no-store, max-age=0');
});

test('nearby asset paths are not given shell revalidation', async () => {
  const response = await onRequest({
    request: new Request('https://app.test/app.js.map'),
    next: async () => new Response('ok', { headers: { 'Cache-Control': 'public, max-age=3600' } }),
  });
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
});
