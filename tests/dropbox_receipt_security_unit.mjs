import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalD1, insertSubmission } from './local_financial_db.mjs';
import { createSubmissionReceipt, listSubmissionReceipts, getSubmissionReceipt } from '../functions/_lib/submission-receipts.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAE0lEQVR4nGP8z8DAwMDAxIBMAQAUQAEF3SN5DgAAAABJRU5ErkJggg==';
const env = { DROPBOX_RECEIPTS_ENABLED: 'true', DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret', DROPBOX_REFRESH_TOKEN: 'refresh' };
const key = n => `123e4567-e89b-12d3-a456-426614174${String(n).padStart(3, '0')}`;
const body = name => ({ filename: name, mimeType: 'image/png', dataBase64: PNG, dropboxPublicConsent: true });

function db() {
  const d = new LocalD1(['0001_initial.sql','0002_passkey_auth.sql','0003_user_profiles.sql','0004_manager_submissions.sql','0005_cash_topups.sql','0006_financial_controls.sql','0007_submission_receipts.sql','0008_financial_alert_settings.sql','0009_receipt_dropbox_metadata.sql']);
  for (const [id, role] of [['manager-1','manager'],['user-a','user'],['user-b','user']]) {
    d.db.prepare('INSERT INTO users(id,name,email,position,role,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,id,`${id}@x`,role,role,0,'2028','2028');
  }
  insertSubmission(d, { id: 'submission-a', createdBy: 'user-a' });
  insertSubmission(d, { id: 'submission-manager', createdBy: 'manager-1' });
  return d;
}
function request(b, k) {
  return new Request('https://local.test/api/submissions/x/receipts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': k }, body: JSON.stringify(b) });
}

async function mockDropbox() {
  const old = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.includes('oauth2/token')) return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
    if (url.includes('files/upload')) {
      const arg = JSON.parse(options.headers['Dropbox-API-Arg']);
      const bytes = options.body instanceof Uint8Array ? options.body : new Uint8Array(await options.body.arrayBuffer());
      const inner = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', inner)), x => x.toString(16).padStart(2, '0')).join('');
      return new Response(JSON.stringify({ '.tag': 'file', path_display: arg.path, size: bytes.length, content_hash: hash, id: 'id:file' }), { status: 200 });
    }
    const arg = JSON.parse(options.body);
    return new Response(JSON.stringify({ url: 'https://www.dropbox.com/scl/fi/abc/receipt.png?rlkey=x&dl=0', id: 'id:file', '.tag': 'file', path: arg.path, link_permissions: { effective_audience: { '.tag': 'public' }, resolved_visibility: { '.tag': 'public' }, link_access_level: { '.tag': 'viewer' } } }), { status: 200 });
  };
  return () => { globalThis.fetch = old; };
}

test('receipt ownership is isolated: other user cannot read/upload, manager reads but only owner uploads', async () => {
  const d = db();
  await assert.rejects(() => createSubmissionReceipt({ request: request(body('cross.png'), key(1)), env }, d, { id: 'user-b', role: 'user' }, 'submission-a'), e => e.code === 'submission_not_found');
  await assert.rejects(() => createSubmissionReceipt({ request: request(body('manager-no.png'), key(2)), env }, d, { id: 'manager-1', role: 'manager' }, 'submission-a'), e => e.code === 'forbidden');
  const cleanup = await mockDropbox();
  try {
    const created = await createSubmissionReceipt({ request: request(body('manager-own.png'), key(3)), env }, d, { id: 'manager-1', role: 'manager' }, 'submission-manager');
    assert.equal(created.status, 201);
    const result = await created.json();
    assert.equal(result.storageStatus, 'ready');
    assert.match(result.dropboxUrl, /^https:\/\/www\.dropbox\.com\/scl\/fi\//);
    const row = d.db.prepare('SELECT dropbox_path,state,public_url FROM receipt_dropbox_metadata').get();
    assert.equal(row.dropbox_path, `/Pengajuan Pangsuma/${result.id}.png`);
    assert.equal(row.state, 'ready');
    assert.equal(row.public_url, result.dropboxUrl);
    await assert.rejects(() => listSubmissionReceipts({ request: new Request('https://local.test'), env }, d, { id: 'user-b', role: 'user' }, 'submission-a'), e => e.code === 'submission_not_found');
    const managerList = await listSubmissionReceipts({ request: new Request('https://local.test'), env }, d, { id: 'manager-1', role: 'manager' }, 'submission-a');
    assert.equal(managerList.status, 200);
    const managerRead = await getSubmissionReceipt({ request: new Request('https://local.test'), env, metadataOnly: true }, d, { id: 'manager-1', role: 'manager' }, result.id);
    assert.equal(managerRead.status, 200);
    await assert.rejects(() => getSubmissionReceipt({ request: new Request('https://local.test'), env, metadataOnly: true }, d, { id: 'user-b', role: 'user' }, result.id), e => e.code === 'receipt_not_found');
  } finally { cleanup(); }
});
