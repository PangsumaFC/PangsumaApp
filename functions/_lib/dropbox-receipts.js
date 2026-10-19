const DROPBOX_ROOT = '/Pengajuan Pangsuma';
const DROPBOX_TIMEOUT_MS = 12_000;
const HEX64 = /^[a-f0-9]{64}$/i;

export function dropboxEnabled(env = {}) { return env?.DROPBOX_RECEIPTS_ENABLED === 'true'; }
function extensionFor(mimeType, extension) {
  if (extension === '.png' && mimeType === 'image/png') return extension;
  if ((extension === '.jpg' || extension === '.jpeg') && mimeType === 'image/jpeg') return extension;
  return mimeType === 'image/png' ? '.png' : '.jpg';
}

export function isCanonicalRequestNumber(value) {
  if (typeof value !== 'string') return false;
  const match = /^(PC|RF)(0[1-9]|1[0-2])\d{4}(?!0{6}$)\d{6}$/.exec(value);
  return Boolean(match);
}
function canonicalRequestNumber(value) {
  if (!isCanonicalRequestNumber(value)) return null;
  return value;
}

/**
 * New evidence is named from the immutable submission request number.  The
 * receipt-id fallback is intentional: it keeps old callers/old rows exactly
 * where they were and makes a missing pre-migration number fail closed rather
 * than inventing a misleading request number.
 */
export function dropboxPath(receiptId, mimeType, requestNumber = null, ordinal = 0, extension = null) {
  const number = canonicalRequestNumber(requestNumber);
  if (!number) return `${DROPBOX_ROOT}/${receiptId}.${mimeType === 'image/png' ? 'png' : 'jpg'}`;
  const suffix = Number.isInteger(ordinal) && ordinal > 1 ? `-${String(ordinal - 1).padStart(2, '0')}` : '';
  const filename = `${number}${suffix}${extensionFor(mimeType, extension)}`;
  // A per-receipt directory gives every upload an immutable unique location.
  // The visible evidence filename uses the exact compact request number.
  return `${DROPBOX_ROOT}/${number}/${receiptId}/${filename}`;
}

export function validateDropboxUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /^(?:https):\/\/[^/]*:/.test(value)) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.hostname !== 'www.dropbox.com' || u.username || u.password || u.port || u.hash) return null;
    if (!/^\/scl\/fi\/[A-Za-z0-9_-]+\/[^/]+$/.test(u.pathname) && !/^\/s\/[A-Za-z0-9_-]+\/[^/]+$/.test(u.pathname)) return null;
    for (const key of u.searchParams.keys()) if (!['rlkey', 'dl'].includes(key.toLowerCase())) return null;
    return u.toString();
  } catch { return null; }
}

function safeError() { return new Error('Dropbox receipt storage unavailable'); }
async function responseJson(response) { try { return await response.json(); } catch { return {}; } }
async function callFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DROPBOX_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch { throw safeError(); } finally { clearTimeout(timer); }
}

async function accessToken(env) {
  if (!env?.DROPBOX_APP_KEY || !env?.DROPBOX_APP_SECRET || !env?.DROPBOX_REFRESH_TOKEN) throw safeError();
  const basic = btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`);
  const response = await callFetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(env.DROPBOX_REFRESH_TOKEN)}`
  });
  if (!response.ok) throw safeError();
  const body = await responseJson(response);
  if (typeof body.access_token !== 'string' || !body.access_token) throw safeError();
  return body.access_token;
}
async function dbx(env, endpoint, options = {}) {
  const token = await accessToken(env);
  const response = await callFetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  return response;
}
async function blockHash(bytes) {
  const chunk = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const inner = await crypto.subtle.digest('SHA-256', chunk);
  const outer = await crypto.subtle.digest('SHA-256', inner);
  return Array.from(new Uint8Array(outer), x => x.toString(16).padStart(2, '0')).join('');
}
function bytesOf(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}
async function uploadFile(env, path, bytes, expectedHash, expectedSize) {
  const token = await accessToken(env);
  const args = JSON.stringify({ path, mode: 'add', autorename: false, mute: true, strict_conflict: true });
  let response = await callFetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': args }, body: bytes
  });
  if (response.ok) {
    const body = await responseJson(response);
    if (body.path_display !== path || body.size !== expectedSize || body.content_hash !== expectedHash || typeof body.id !== 'string' || (body['.tag'] && body['.tag'] !== 'file')) throw safeError();
    return body;
  }
  const body = await responseJson(response);
  const conflict = body?.error?.['.tag'] === 'path' && body.error.path?.['.tag'] === 'conflict';
  if (!conflict) throw safeError();
  const meta = await dbx(env, 'files/get_metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, include_media_info: false }) });
  if (!meta.ok) throw safeError();
  const found = await responseJson(meta);
  if (found['.tag'] !== 'file' || found.path_display !== path || found.size !== expectedSize || found.content_hash !== expectedHash || typeof found.id !== 'string') throw safeError();
  return found;
}
async function publicLink(env, path) {
  let response = await dbx(env, 'sharing/create_shared_link_with_settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, settings: { requested_visibility: 'public', audience: 'public', access: 'viewer' } }) });
  if (response.ok) {
    const body = await responseJson(response); const url = validateDropboxUrl(body.url);
    if ((body['.tag'] && body['.tag'] !== 'file') || (body.path && body.path !== path) || (body.id !== undefined && typeof body.id !== 'string')) throw safeError();
    const permissions = body.link_permissions || {};
    const publicAudience = [permissions.effective_audience, permissions.resolved_visibility].some(x => x && x['.tag'] === 'public');
    const viewer = permissions.link_access_level && permissions.link_access_level['.tag'] === 'viewer';
    if (!url || !publicAudience || !viewer) throw safeError();
    return { url, fileId: body.id || null };
  }
  const error = await responseJson(response);
  if (!JSON.stringify(error).includes('shared_link_already_exists')) throw safeError();
  response = await dbx(env, 'sharing/list_shared_links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, direct_only: true }) });
  if (!response.ok) throw safeError();
  const body = await responseJson(response); const links = Array.isArray(body.links) ? body.links : [];
  // Dropbox's response shape varies by API version; only accept explicit public links.
  const chosen = links.find(x => {
    const p = x.link_permissions || {};
    return validateDropboxUrl(x.url) && [p.effective_audience, p.resolved_visibility].some(v => v && v['.tag'] === 'public') && p.link_access_level && p.link_access_level['.tag'] === 'viewer' && (!x.path || x.path === path) && (!x['.tag'] || x['.tag'] === 'file');
  });
  if (!chosen) throw safeError();
  return { url: validateDropboxUrl(chosen.url), fileId: chosen.id || null };
}

export async function pushReceiptToDropbox(env, receipt) {
  const bytes = bytesOf(receipt.bytes_blob); if (!bytes) throw safeError();
  const hash = await blockHash(bytes); if (!HEX64.test(hash)) throw safeError();
  const path = receipt.dropbox_path || dropboxPath(receipt.id, receipt.mime_type, receipt.request_number, receipt.receipt_ordinal, receipt.file_extension);
  const uploaded = await uploadFile(env, path, bytes, hash, bytes.byteLength);
  const link = await publicLink(env, path);
  return { path, fileId: link.fileId || uploaded.id || null, publicUrl: link.url };
}
