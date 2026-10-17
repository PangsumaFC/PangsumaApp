const CACHE_NAME = 'pangsuma-app-shell-v11-password-crypto';
const APP_SHELL = [
  '/',
  '/pangsuma-theme.css',
  '/password-crypto.js',
  '/app.js',
  '/pangsuma-login-crest-384.png',
  '/manifest.webmanifest',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/pangsuma-icon-192.png',
  '/pangsuma-icon-512.png',
  '/pangsuma-icon-maskable-512.png'
];

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
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok && response.headers.get('Cache-Control')?.includes('no-store') !== true) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put('/', copy));
      }
      return response;
    }).catch(() => caches.match('/')));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok && response.headers.get('Cache-Control')?.includes('no-store') !== true) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
    }
    return response;
  })));
});
