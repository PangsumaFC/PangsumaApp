const CACHE_NAME = 'pangsuma-app-shell-v17-gallery-download';
const APP_SHELL = [
  '/',
  '/pangsuma-theme.css?v=2026.10.18.2',
  '/password-crypto.js?v=2026.10.18.2',
  '/app.js?v=2026.10.18.2',
  '/pangsuma-login-crest-384.png',
  '/manifest.webmanifest',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/pangsuma-icon-192.png',
  '/pangsuma-icon-512.png',
  '/pangsuma-icon-maskable-512.png'
];
const SHELL_ASSETS = new Set(APP_SHELL.filter(path => path !== '/').map(path => path.split('?')[0]));

function cacheable(response) {
  return response.ok && !/\bno-store\b/i.test(response.headers.get('Cache-Control') || '');
}

function cacheResponse(request, response) {
  if (cacheable(response)) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
  }
  return response;
}

function networkRequest(request) {
  return new Request(request, { cache: 'no-cache' });
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' || SHELL_ASSETS.has(url.pathname)) {
    event.respondWith(fetch(networkRequest(request)).then(response => cacheResponse(
      request.mode === 'navigate' ? '/' : request,
      response,
    )).catch(() => caches.match(request.mode === 'navigate' ? '/' : request)));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    return cacheResponse(request, response);
  })));
});
