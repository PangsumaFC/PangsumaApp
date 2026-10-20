const CACHE_NAME = 'pangsuma-app-shell-v27-2026.10.20.4';
const APP_SHELL = [
  '/',
  '/pangsuma-theme.css?v=2026.10.20.4',
  '/password-crypto.js?v=2026.10.20.4',
  '/app.js?v=2026.10.20.4',
  '/pwa-install.js?v=2026.10.20.4',
  '/pwa-updates.js?v=2026.10.20.4',
  '/pwa-files.js?v=2026.10.20.4',
  '/pwa-files.css?v=2026.10.20.4',
  '/report-filters.js?v=2026.10.20.4',
  '/financial-controls.js?v=2026.10.20.4',
  '/financial-controls.css?v=2026.10.20.4',
  '/report-evidence.js?v=2026.10.20.4',
  '/report-evidence.css?v=2026.10.20.4',
  '/bounded-history.js?v=2026.10.20.4',
  '/mobile-polish.css?v=2026.10.20.4',
  '/mobile-viewport.js?v=2026.10.20.4',
  '/pangsuma-login-crest-384.png',
  '/pangsuma-loading-logo.png',
  '/pangsuma-loading-emblem.png',
  '/manifest.webmanifest',
  '/favicon-32.png?v=2026.10.20.4',
  '/apple-touch-icon.png?v=2026.10.20.4',
  '/pangsuma-icon-192.png?v=2026.10.20.4',
  '/pangsuma-icon-512.png?v=2026.10.20.4',
  '/pangsuma-icon-maskable-192.png?v=2026.10.20.4',
  '/pangsuma-icon-maskable-512.png?v=2026.10.20.4'
];
const SHELL_ASSETS = new Set(APP_SHELL.filter(path => path !== '/').map(path => path.split('?')[0]));
// These assets are required for the core app and its report/authentication flows
// to remain usable offline. Branding and cosmetic enhancements are optional.
const MANDATORY_SHELL = [
  '/',
  '/pangsuma-theme.css?v=2026.10.20.4',
  '/password-crypto.js?v=2026.10.20.4',
  '/app.js?v=2026.10.20.4',
  '/pwa-install.js?v=2026.10.20.4',
  '/pwa-updates.js?v=2026.10.20.4',
  '/pwa-files.js?v=2026.10.20.4',
  '/pwa-files.css?v=2026.10.20.4',
  '/report-filters.js?v=2026.10.20.4',
  '/financial-controls.js?v=2026.10.20.4',
  '/financial-controls.css?v=2026.10.20.4',
  '/report-evidence.js?v=2026.10.20.4',
  '/report-evidence.css?v=2026.10.20.4',
  '/bounded-history.js?v=2026.10.20.4',
];
const OPTIONAL_SHELL = APP_SHELL.filter(path => !MANDATORY_SHELL.includes(path));

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

async function precacheAsset(cache, asset, mandatory) {
  // APP_SHELL entries are root-relative, while Request requires an absolute URL
  // in browsers and in the Node service-worker harness.
  const request = networkRequest(new Request(new URL(asset, self.location.origin), { credentials: 'same-origin' }));
  const response = await fetch(request);
  if (!cacheable(response)) {
    if (mandatory) throw new Error(`Mandatory shell asset unavailable: ${asset}`);
    return false;
  }
  await cache.put(request, response.clone());
  return true;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const mandatoryResults = await Promise.allSettled(MANDATORY_SHELL.map(asset => precacheAsset(cache, asset, true)));
      const mandatoryFailure = mandatoryResults.find(result => result.status === 'rejected');
      if (mandatoryFailure) throw mandatoryFailure.reason;
      await Promise.allSettled(OPTIONAL_SHELL.map(asset => precacheAsset(cache, asset, false)));
      await self.skipWaiting();
    } catch (error) {
      // A failed mandatory fetch must never leave a partial cache eligible for activation.
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
    .then(() => self.clients.matchAll?.({ type: 'window', includeUncontrolled: true }))
    .then(clients => (clients || []).forEach(client => client.postMessage({ type: 'APP_UPDATE_AVAILABLE', build: '2026.10.20.4' }))));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/pdf-browser.html' || url.pathname === '/pdf-browser') return;
  if (url.pathname === '/version.json') return;
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
