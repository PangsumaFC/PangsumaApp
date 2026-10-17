export async function onRequest(context) {
  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self'"
  );
  const pathname = new URL(context.request.url).pathname;
  if (pathname === '/' || [
    '/index.html',
    '/app.js',
    '/password-crypto.js',
    '/sw.js',
    '/pangsuma-theme.css',
    '/manifest.webmanifest',
  ].includes(pathname)) {
    headers.set('Cache-Control', 'no-cache');
  } else if (pathname === '/api' || pathname.startsWith('/api/')) {
    headers.set('Cache-Control', 'no-store, max-age=0');
    headers.set('Pragma', 'no-cache');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
