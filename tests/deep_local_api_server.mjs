import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalD1 } from './local_financial_db.mjs';
import { onRequest as apiOnRequest } from '../functions/api/[[path]].js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DEEP_LOCAL_PORT || 0);
const ORIGIN = process.env.DEEP_LOCAL_ORIGIN || `http://localhost:${PORT || 8788}`;
const schemaFiles = Array.from({length: 11}, (_, i) => `${String(i + 1).padStart(4, '0')}_${[
  'initial','passkey_auth','user_profiles','manager_submissions','cash_topups','financial_controls',
  'submission_receipts','financial_alert_settings','receipt_dropbox_metadata','request_numbers','request_number_receipts'
][i]}.sql`);
const db = new LocalD1(schemaFiles);
const env = {
  DB: db,
  PASSWORD_PEPPER: process.env.PASSWORD_PEPPER || 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  BOOTSTRAP_TOKEN: process.env.BOOTSTRAP_TOKEN || 'deep-local-bootstrap-token-012345678901234567890',
  PASSKEY_AUTH_ENABLED: 'false',
  WEBAUTHN_PROFILE: 'test',
  WEBAUTHN_ORIGIN: ORIGIN,
  WEBAUTHN_RP_ID: 'localhost',
  PASSKEY_MANAGER_ID: '00000000-0000-4000-8000-000000000002',
  DROPBOX_RECEIPTS_ENABLED: 'false'
};
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.wasm':'application/wasm' };

async function handleApi(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  const url = `${ORIGIN}${req.url}`;
  const request = new Request(url, { method: req.method, headers, body: ['GET','HEAD'].includes(req.method) ? undefined : body });
  const response = await apiOnRequest({ request, env, next: async () => new Response('Not found', { status: 404 }) });
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    const canonical = key.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('-');
    res.setHeader(canonical, value);
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}
function safePath(urlPath) {
  const pathname = decodeURIComponent(new URL(urlPath, ORIGIN).pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const full = path.resolve(ROOT, 'site', relative);
  return full.startsWith(path.resolve(ROOT, 'site') + path.sep) ? full : null;
}
async function handle(req, res) {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  const full = safePath(req.url);
  if (!full) { res.writeHead(404); return res.end('Not found'); }
  try {
    const stat = await fs.promises.stat(full);
    if (!stat.isFile()) throw new Error('not file');
    res.writeHead(200, { 'Content-Type': mime[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
}
const server = http.createServer((req, res) => { handle(req, res).catch(error => { console.error(error); if (!res.headersSent) res.writeHead(500); res.end('fixture error'); }); });
server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  console.log(`DEEP_LOCAL_READY ${ORIGIN.replace(/:\d+$/, ':' + address.port)}`);
});
function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
