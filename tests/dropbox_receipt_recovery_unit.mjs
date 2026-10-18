import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalD1, insertSubmission } from './local_financial_db.mjs';
import { createSubmissionReceipt, listSubmissionReceipts } from '../functions/_lib/submission-receipts.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAE0lEQVR4nGP8z8DAwMDAxIBMAQAUQAEF3SN5DgAAAABJRU5ErkJggg==';
const env = { DROPBOX_RECEIPTS_ENABLED: 'true', DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret', DROPBOX_REFRESH_TOKEN: 'refresh' };
const disabled = { DROPBOX_RECEIPTS_ENABLED: 'false' };
const key = n => `123e4567-e89b-12d3-a456-4266141740${String(n).padStart(2, '0')}`;
const body = (filename = 'receipt.png', extra = {}) => ({ filename, mimeType: 'image/png', dataBase64: PNG, dropboxPublicConsent: true, ...extra });
const req = (b, idempotency = key(1)) => new Request('https://local.test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotency }, body: JSON.stringify(b) });
const getReq = () => new Request('https://local.test', { method: 'GET' });

async function db({ dropbox = true, seeded = true } = {}) {
  const files = ['0001_initial.sql','0002_passkey_auth.sql','0003_user_profiles.sql','0004_manager_submissions.sql','0005_cash_topups.sql','0006_financial_controls.sql','0007_submission_receipts.sql','0008_financial_alert_settings.sql'];
  if (dropbox) files.push('0009_receipt_dropbox_metadata.sql');
  const d = new LocalD1(files);
  for (const [id, role] of [['manager-1','manager'],['user-a','user'],['user-b','user']]) d.db.prepare('INSERT INTO users(id,name,email,position,role,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,id,`${id}@x`,role,role,0,'2028','2028');
  insertSubmission(d, { id: 'submission-1', createdBy: 'user-a' }); return d;
}
function addSchema(d) { d.db.exec(awaitMigration()); }
function awaitMigration() { return requireMigration; }
import fs from 'node:fs';
const requireMigration = fs.readFileSync(new URL('../migrations/0009_receipt_dropbox_metadata.sql', import.meta.url), 'utf8');
async function hash(bytes) { const inner = await crypto.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', inner)), x => x.toString(16).padStart(2, '0')).join(''); }
function publicLink(path, id = 'id:file') { return { url: 'https://www.dropbox.com/scl/fi/abc/receipt.png?rlkey=x&dl=0', id, '.tag': 'file', path, link_permissions: { effective_audience: { '.tag': 'public' }, resolved_visibility: { '.tag': 'public' }, link_access_level: { '.tag': 'viewer' } } }; }
function mockDropbox({ shareFailure = false, conflict = false, existing = null, list = false, linkAlreadyExists = false } = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('oauth2/token')) return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
    if (url.includes('files/upload')) {
      const arg = JSON.parse(options.headers['Dropbox-API-Arg']);
      if (conflict) return new Response(JSON.stringify({ error: { '.tag': 'path', path: { '.tag': 'conflict' } } }), { status: 409 });
      const bytes = options.body instanceof Uint8Array ? options.body : new Uint8Array(await options.body.arrayBuffer());
      return new Response(JSON.stringify({ '.tag': 'file', path_display: arg.path, size: bytes.length, content_hash: await hash(bytes), id: 'id:file' }), { status: 200 });
    }
    if (url.includes('files/get_metadata')) {
      const p = JSON.parse(options.body).path;
      const bytes = Uint8Array.from(atob(PNG), c => c.charCodeAt(0));
      return new Response(JSON.stringify(existing || { '.tag':'file', path_display:p, size:bytes.length, content_hash:await hash(bytes), id:'id:file' }), { status: 200 });
    }
    if (url.includes('create_shared_link')) return shareFailure
      ? new Response(JSON.stringify({ error: { '.tag': 'other' } }), { status: 503 })
      : linkAlreadyExists ? new Response(JSON.stringify({ error: { '.tag':'shared_link_already_exists' } }), { status: 409 })
      : new Response(JSON.stringify(publicLink(JSON.parse(options.body).path)), { status: 200 });
    if (url.includes('list_shared_links')) return new Response(JSON.stringify({ links: list ? [publicLink(JSON.parse(options.body).path)] : [] }), { status: 200 });
    return new Response('{}', { status: 500 });
  };
  return { fetch, calls };
}

// Recovery scenarios intentionally use real D1 schema/triggers and only stub global.fetch.
test('ready idempotency is a true no-op; same SHA with a different key resumes pending', async () => {
  const d = await db(); let firstShare = true; const mock = mockDropbox(); const baseFetch = mock.fetch; mock.fetch = async (url, options) => {
    if (url.includes('create_shared_link') && firstShare) { firstShare = false; return new Response('{}', { status: 503 }); }
    return baseFetch(url, options);
  }; const old = globalThis.fetch; globalThis.fetch = mock.fetch;
  try {
    await assert.rejects(() => createSubmissionReceipt({ request: req(body(), key(1)), env }, d, { id: 'user-a', role: 'user' }, 'submission-1'), e => e.code === 'receipt_storage_unavailable');
    assert.equal(d.db.prepare('SELECT state FROM receipt_dropbox_metadata').get().state, 'pending');
    const resumed = await createSubmissionReceipt({ request: req(body(), key(2)), env }, d, { id: 'user-a', role: 'user' }, 'submission-1');
    assert.equal(resumed.status, 200); const before = mock.calls.length;
    const again = await createSubmissionReceipt({ request: req(body(), key(2)), env }, d, { id: 'user-a', role: 'user' }, 'submission-1');
    assert.equal(again.status, 200); assert.equal(mock.calls.length, before);
    assert.equal(d.db.prepare('SELECT COUNT(*) n FROM submission_receipts').get().n, 1);
    const row = d.db.prepare('SELECT * FROM submission_receipts').get();
    assert.equal(d.db.prepare('SELECT state FROM receipt_dropbox_metadata WHERE receipt_id=?').get(row.id).state, 'ready');
  } finally { globalThis.fetch = old; }
});

test('upload success then share failure leaves pending; retry handles upload conflict, exact metadata, and public viewer link', async () => {
  const d = await db(); let phase = 0; const calls = []; const old = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('oauth2/token')) return new Response(JSON.stringify({ access_token: 'token' }));
    if (url.includes('files/upload')) {
      const arg = JSON.parse(options.headers['Dropbox-API-Arg']); const bytes = options.body;
      if (phase++ > 0) return new Response(JSON.stringify({ error: { '.tag': 'path', path: { '.tag': 'conflict' } } }), { status: 409 });
      return new Response(JSON.stringify({ '.tag': 'file', path_display: arg.path, size: bytes.length, content_hash: await hash(bytes), id: 'id:file' }));
    }
    if (url.includes('files/get_metadata')) { const p = JSON.parse(options.body).path; return new Response(JSON.stringify({ '.tag':'file', path_display:p, size:76, content_hash:await hash(new Uint8Array(await (new Response(Buffer.from(atob(PNG),'binary'))).arrayBuffer())), id:'id:file' })); }
    if (url.includes('create_shared_link')) return phase === 1 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(publicLink(JSON.parse(options.body).path)));
    return new Response(JSON.stringify({ links: [] }));
  };
  try {
    await assert.rejects(() => createSubmissionReceipt({ request: req(body('recover.png'), key(3)), env }, d, { id:'user-a', role:'user' }, 'submission-1'), e => e.code === 'receipt_storage_unavailable');
    assert.equal(d.db.prepare('SELECT state FROM receipt_dropbox_metadata').get().state, 'pending');
    const retry = await createSubmissionReceipt({ request: req(body('recover.png'), key(3)), env }, d, { id:'user-a', role:'user' }, 'submission-1');
    assert.equal(retry.status, 200); const meta = d.db.prepare('SELECT state,file_id,public_url FROM receipt_dropbox_metadata').get(); assert.equal(meta.state, 'ready'); assert.equal(meta.file_id, 'id:file'); assert.match(meta.public_url, /^https:\/\/www\.dropbox\.com\/scl\/fi\//);
    assert.ok(calls.some(x => x.url.includes('files/get_metadata'))); assert.equal(d.db.prepare('SELECT COUNT(*) n FROM submission_receipts').get().n, 1);
  } finally { globalThis.fetch = old; }
});

test('already_exists recovery accepts Dropbox union-shaped list response but only direct public viewer link', async () => {
  const d = await db(); const mock = mockDropbox({ conflict: true, list:true, linkAlreadyExists:true });
  const old = globalThis.fetch; globalThis.fetch = mock.fetch;
  try {
    const response = await createSubmissionReceipt({ request:req(body('union.png'), key(4)), env }, d, {id:'user-a',role:'user'}, 'submission-1');
    assert.equal(response.status, 201); assert.equal(d.db.prepare('SELECT state FROM receipt_dropbox_metadata').get().state, 'ready');
    assert.ok(mock.calls.some(x => x.url.includes('sharing/create_shared_link')));
  } finally { globalThis.fetch = old; }
});
test('finalization DB failure is retryable and creates exactly one receipt and one ready audit', async () => {
  const d = await db(); const mock = mockDropbox(); const originalPrepare = d.prepare.bind(d); let failOnce = true;
  d.prepare = sql => { const statement = originalPrepare(sql); if (failOnce && /UPDATE receipt_dropbox_metadata SET/.test(sql)) { const run = statement.run; statement.run = async (...args) => { failOnce = false; throw new Error('simulated finalize failure'); }; } return statement; };
  const old = globalThis.fetch; globalThis.fetch = mock.fetch;
  try {
    await assert.rejects(() => createSubmissionReceipt({request:req(body('dbfail.png'),key(5)),env},d,{id:'user-a',role:'user'},'submission-1'), e => e.code === 'receipt_storage_unavailable');
    assert.equal(d.db.prepare('SELECT state FROM receipt_dropbox_metadata').get().state, 'pending');
    const retry = await createSubmissionReceipt({request:req(body('dbfail.png'),key(5)),env},d,{id:'user-a',role:'user'},'submission-1'); assert.equal(retry.status,200);
    assert.equal(d.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='submission.receipt_dropbox_ready'").get().n,1); assert.equal(d.db.prepare('SELECT COUNT(*) n FROM submission_receipts').get().n,1);
  } finally { globalThis.fetch = old; }
});

test('legacy receipt remains local when enabling Dropbox later; duplicate does not migrate', async () => {
  const d = await db({dropbox:true}); const old = globalThis.fetch; let network = 0; globalThis.fetch = async () => { network++; return new Response('{}',{status:500}); };
  try {
    const r = await createSubmissionReceipt({request:req(body('legacy.png'),key(6)),env:disabled},d,{id:'user-a',role:'user'},'submission-1');
    assert.equal(r.status,201); const before = d.db.prepare('SELECT COUNT(*) n FROM receipt_dropbox_metadata').get().n;
    const enabledResponse = await createSubmissionReceipt({request:req(body('legacy.png'),key(7)),env},d,{id:'user-a',role:'user'},'submission-1');
    assert.equal(enabledResponse.status,200); assert.equal(network,0); assert.equal(d.db.prepare('SELECT COUNT(*) n FROM receipt_dropbox_metadata').get().n,before); assert.equal(d.db.prepare('SELECT COUNT(*) n FROM submission_receipts').get().n,1);
  } finally { globalThis.fetch = old; }
});

test('ownership, inactive actors, malformed MIME, and oversize fail before Dropbox network', async () => {
  const d = await db(); const old = globalThis.fetch; let network=0; globalThis.fetch=async()=>{network++;return new Response('{}')};
  try {
    await assert.rejects(() => createSubmissionReceipt({request:req(body('x.png'),key(8)),env},d,{id:'user-b',role:'user'},'submission-1'), e=>e.status===404);
    await assert.rejects(() => createSubmissionReceipt({request:req(body('x.png'),key(9)),env},d,{id:'manager-1',role:'manager'},'submission-1'), e=>e.status===403);
    d.db.prepare('UPDATE users SET is_active=0 WHERE id=?').run('user-a'); await assert.rejects(() => createSubmissionReceipt({request:req({...body(),mimeType:'image/gif'},key(10)),env},d,{id:'user-a',role:'user'},'submission-1'), e=>e.status===401);
    d.db.prepare('UPDATE users SET is_active=1 WHERE id=?').run('user-a'); await assert.rejects(() => createSubmissionReceipt({request:req({...body(),mimeType:'image/gif'},key(11)),env},d,{id:'user-a',role:'user'},'submission-1'), e=>e.code==='invalid_mime_type');
    await assert.rejects(() => createSubmissionReceipt({request:req({...body(),dataBase64:'A'.repeat(700000)},key(12)),env},d,{id:'user-a',role:'user'},'submission-1'), e=>e.code==='invalid_base64'); assert.equal(network,0);
  } finally { globalThis.fetch=old; }
});

test('0009 preserves legacy bytes and append-only definitions; Dropbox metadata guards reject mutation/delete', async () => {
  const d = await db({dropbox:false}); const before = d.db.prepare('SELECT id,bytes_blob,filename FROM submission_receipts').all();
  await createSubmissionReceipt({request:req(body('legacy-populated.png'),key(15)),env:disabled},d,{id:'user-a',role:'user'},'submission-1');
  const populated = d.db.prepare('SELECT id,bytes_blob,filename FROM submission_receipts').all();
  // Applying 0009 to an already populated receipt database is the migration path under audit.
  d.db.exec(requireMigration); const after = d.db.prepare('SELECT id,bytes_blob,filename FROM submission_receipts').all(); assert.deepEqual(after,populated); assert.deepEqual(before,[]);
  const trigger = d.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('submission_receipts_append_only_update','submission_receipts_append_only_delete') ORDER BY name").all(); assert.equal(trigger.length,2); assert.match(trigger[0].sql, /append_only/); assert.match(trigger[1].sql, /append_only/);
  const old = globalThis.fetch; let network=0; globalThis.fetch=async()=>{network++;return new Response('{}')};
  try {
    const dMissing = await db({dropbox:false}); await assert.rejects(() => createSubmissionReceipt({request:req(body('guard.png'),key(13)),env},dMissing,{id:'user-a',role:'user'},'submission-1'), e=>e.code==='receipt_storage_unavailable'); assert.equal(network,0);
    const d2=await db(); const mock=mockDropbox(); globalThis.fetch=mock.fetch; await createSubmissionReceipt({request:req(body('guard.png'),key(14)),env},d2,{id:'user-a',role:'user'},'submission-1'); const id=d2.db.prepare('SELECT receipt_id FROM receipt_dropbox_metadata').get().receipt_id;
    assert.throws(()=>d2.db.prepare('DELETE FROM receipt_dropbox_metadata WHERE receipt_id=?').run(id),/receipt_dropbox_immutable/);
    assert.throws(()=>d2.db.prepare('UPDATE receipt_dropbox_metadata SET dropbox_path=? WHERE receipt_id=?').run('/Pengajuan Pangsuma/other.png',id),/receipt_dropbox_identity_immutable/);
  } finally { globalThis.fetch=old; }
});
