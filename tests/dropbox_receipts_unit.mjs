import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalD1, insertSubmission } from './local_financial_db.mjs';
import { createSubmissionReceipt, listSubmissionReceipts } from '../functions/_lib/submission-receipts.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAE0lEQVR4nGP8z8DAwMDAxIBMAQAUQAEF3SN5DgAAAABJRU5ErkJggg==';
const env = { DROPBOX_RECEIPTS_ENABLED: 'true', DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret', DROPBOX_REFRESH_TOKEN: 'refresh' };
const key = '123e4567-e89b-12d3-a456-426614174001';
function db(withDropbox = true) {
  const files = ['0001_initial.sql','0002_passkey_auth.sql','0003_user_profiles.sql','0004_manager_submissions.sql','0005_cash_topups.sql','0006_financial_controls.sql','0007_submission_receipts.sql','0008_financial_alert_settings.sql'];
  if (withDropbox) files.push('0009_receipt_dropbox_metadata.sql');
  const d = new LocalD1(files);
  for (const [id, role] of [['manager-1','manager'],['user-a','user'],['user-b','user']]) d.db.prepare('INSERT INTO users(id,name,email,position,role,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,id,`${id}@x`,role,role,0,'2028','2028');
  insertSubmission(d, { id: 'submission-1', createdBy: 'user-a' }); return d;
}
function request(body, k = key) { return new Request('https://local.test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': k }, body: JSON.stringify(body) }); }
const body = { filename: 'receipt.png', mimeType: 'image/png', dataBase64: PNG, dropboxPublicConsent: true };

test('enabled Dropbox requires explicit consent and migration', async () => {
  const d = db();
  await assert.rejects(() => createSubmissionReceipt({ request: request({ ...body, dropboxPublicConsent: false }), env }, d, { id: 'user-a', role: 'user' }, 'submission-1'), e => e.code === 'dropbox_public_consent_required');
  const missing = db(false);
  await assert.rejects(() => listSubmissionReceipts({ request: new Request('https://local.test'), env }, missing, { id: 'user-a', role: 'user' }, 'submission-1'), e => e.status === 503);
});

test('mocked Dropbox upload precedes sharing and creates no public folder', async () => {
  const d = db(); const calls = []; const old = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    if (url.includes('oauth2/token')) return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
    if (url.includes('files/upload')) {
      const arg = JSON.parse(options.headers['Dropbox-API-Arg']);
      const bytes = options.body instanceof Uint8Array ? options.body : new Uint8Array(await options.body.arrayBuffer());
      const inner = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', inner)), x => x.toString(16).padStart(2, '0')).join('');
      return new Response(JSON.stringify({ '.tag': 'file', path_display: arg.path, size: bytes.length, content_hash: hash, id: 'id:file' }), { status: 200 });
    }
    const shareArg = JSON.parse(options.body);
    return new Response(JSON.stringify({ url: 'https://www.dropbox.com/scl/fi/abc/receipt.png?rlkey=x&dl=0', id: 'id:file', '.tag': 'file', path: shareArg.path, link_permissions: { effective_audience: { '.tag': 'public' }, resolved_visibility: { '.tag': 'public' }, link_access_level: { '.tag': 'viewer' } } }), { status: 200 });
  };
  try {
    const response = await createSubmissionReceipt({ request: request(body), env }, d, { id: 'user-a', role: 'user' }, 'submission-1');
    assert.equal(response.status, 201); const result = await response.json(); assert.match(result.dropboxUrl, /^https:\/\/www\.dropbox\.com\/scl\/fi\//);
    assert.equal(d.db.prepare("SELECT state FROM receipt_dropbox_metadata").get().state, 'ready');
    assert.equal(calls.some(x => x.includes('/files/create_folder')), false); assert.ok(calls.findIndex(x => x.includes('/files/upload')) < calls.findIndex(x => x.includes('/sharing/create_shared_link')));
  } finally { globalThis.fetch = old; }
});

test('strict Dropbox URL validation rejects credentials, ports, hashes, and non-file paths', async () => {
  const { validateDropboxUrl } = await import('../functions/_lib/dropbox-receipts.js');
  assert.ok(validateDropboxUrl('https://www.dropbox.com/scl/fi/id/file.png?rlkey=k&dl=0'));
  for (const value of [
    'https://dropbox.com/scl/fi/id/file.png',
    'https://user:pass@www.dropbox.com/scl/fi/id/file.png',
    'https://www.dropbox.com:443/scl/fi/id/file.png',
    'https://www.dropbox.com/scl/fi/id/file.png#x',
    'https://www.dropbox.com/scl/fi/id/file.png?access_token=x',
    'https://www.dropbox.com/scl/fi/id',
    'https://www.dropbox.com/home/file.png'
  ]) assert.equal(validateDropboxUrl(value), null, value);
});

test('editor permission response is rejected and pending metadata remains', async () => {
  const d = db(); const old = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.includes('oauth2/token')) return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
    if (url.includes('files/upload')) {
      const arg = JSON.parse(options.headers['Dropbox-API-Arg']); const bytes = options.body;
      const inner = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', inner)), x => x.toString(16).padStart(2, '0')).join('');
      return new Response(JSON.stringify({ path_display: arg.path, size: bytes.length, content_hash: hash, id: 'id:file' }), { status: 200 });
    }
    return new Response(JSON.stringify({ url: 'https://www.dropbox.com/scl/fi/id/file.png?rlkey=k', link_permissions: { effective_audience: { '.tag': 'public' }, resolved_visibility: { '.tag': 'public' }, link_access_level: { '.tag': 'editor' } } }), { status: 200 });
  };
  try {
    await assert.rejects(() => createSubmissionReceipt({ request: request({ ...body, filename: 'editor.png' }), env }, d, { id: 'user-a', role: 'user' }, 'submission-1'), e => e.code === 'receipt_storage_unavailable');
    assert.equal(d.db.prepare("SELECT state FROM receipt_dropbox_metadata").get().state, 'pending');
  } finally { globalThis.fetch = old; }
});
