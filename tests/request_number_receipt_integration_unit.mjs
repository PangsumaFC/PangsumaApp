import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { encode } from 'fast-png';
import { seededFinancialDb, insertSubmission } from './local_financial_db.mjs';
import { createSubmissionReceipt, listSubmissionReceipts } from '../functions/_lib/submission-receipts.js';

const env = { DROPBOX_RECEIPTS_ENABLED: 'true', DROPBOX_APP_KEY: 'local-key', DROPBOX_APP_SECRET: 'local-secret', DROPBOX_REFRESH_TOKEN: 'local-refresh' };
function body(n) { return { filename: `original-${n}.png`, mimeType: 'image/png', dataBase64: Buffer.from(encode({ width: 1, height: 1, data: Uint8Array.from([n, 20, 30]), channels: 3, depth: 8 })).toString('base64'), dropboxPublicConsent: true }; }
function request(n) { return new Request('https://local.test/api/receipts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `cb000000-0000-4000-8000-${String(n).padStart(12, '0')}` }, body: JSON.stringify(body(n)) }); }
function mockDropbox(uploaded, shared, fail = () => false) {
  return async (url, options) => {
    if (url.includes('oauth2/token')) return new Response(JSON.stringify({ access_token: 'local-token' }));
    if (url.includes('files/upload')) {
      const arg = JSON.parse(options.headers['Dropbox-API-Arg']); uploaded.push(arg.path);
      if (fail()) throw new Error('synthetic temporary network error');
      const bytes = options.body;
      const inner = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Buffer.from(await crypto.subtle.digest('SHA-256', inner)).toString('hex');
      return new Response(JSON.stringify({ '.tag': 'file', path_display: arg.path, size: bytes.length, content_hash: hash, id: `id:${uploaded.length}` }));
    }
    if (url.includes('/sharing/')) {
      const arg = JSON.parse(options.body); shared.push(arg.path);
      return new Response(JSON.stringify({ '.tag': 'file', id: `id:${shared.length}`, path: arg.path, url: `https://www.dropbox.com/scl/fi/local${shared.length}/${arg.path.split('/').pop()}?rlkey=local&dl=0`, link_permissions: { effective_audience: { '.tag': 'public' }, resolved_visibility: { '.tag': 'public' }, link_access_level: { '.tag': 'viewer' } } }));
    }
    throw new Error(`Unexpected mocked URL: ${url}`);
  };
}

test('numbered upload uses schema guard and stored retry path; multiple files retain correct per-file links', async () => {
  const { db } = await seededFinancialDb();
  for (const file of ['0006_financial_controls.sql','0007_submission_receipts.sql','0008_financial_alert_settings.sql','0009_receipt_dropbox_metadata.sql','0011_request_number_receipts.sql']) db.db.exec(fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  const id = 'ca000000-0000-4000-8000-000000000001';
  insertSubmission(db, { id, type: 'finance_request', createdAt: '2026-11-01T00:00:00.000Z' });
  const number = db.db.prepare('SELECT request_number FROM submissions WHERE id=?').get(id).request_number;
  const stem = number;
  const uploaded = [], shared = []; let shouldFail = true;
  const previous = globalThis.fetch; globalThis.fetch = mockDropbox(uploaded, shared, () => shouldFail);
  const balance = db.db.prepare('SELECT balance_idr FROM cash_accounts LIMIT 1').get().balance_idr;
  const ledger = db.db.prepare('SELECT COUNT(*) n FROM cash_ledger').get().n;
  try {
    await assert.rejects(() => createSubmissionReceipt({ request: request(1), env }, db, { id: 'user-a', role: 'user' }, id), e => e.status === 503);
    const pending = db.db.prepare('SELECT receipt_id,dropbox_path,state FROM receipt_dropbox_metadata').get();
    assert.equal(pending.state, 'pending'); assert.equal(pending.dropbox_path.split('/').pop(), `${stem}.png`);
    assert.equal(uploaded[0], pending.dropbox_path);
    shouldFail = false;
    const retry = await createSubmissionReceipt({ request: request(1), env }, db, { id: 'user-a', role: 'user' }, id);
    assert.equal(retry.status, 200); assert.equal(uploaded[1], pending.dropbox_path); assert.equal(shared[0], pending.dropbox_path);
    const second = await createSubmissionReceipt({ request: request(2), env }, db, { id: 'user-a', role: 'user' }, id);
    assert.equal(second.status, 201); assert.equal(uploaded.at(-1).split('/').pop(), `${stem}-01.png`);
    assert.notEqual(shared[0], shared[1]);
    const replayCount = uploaded.length;
    await createSubmissionReceipt({ request: request(2), env }, db, { id: 'user-a', role: 'user' }, id);
    assert.equal(uploaded.length, replayCount);
    const listed = await (await listSubmissionReceipts({ request: new Request('https://local.test'), env }, db, { id: 'manager-1', role: 'manager' }, id)).json();
    assert.equal(listed.items.length, 2); assert.notEqual(listed.items[0].dropboxUrl, listed.items[1].dropboxUrl);
    assert.equal(db.db.prepare('SELECT balance_idr FROM cash_accounts LIMIT 1').get().balance_idr, balance);
    assert.equal(db.db.prepare('SELECT COUNT(*) n FROM cash_ledger').get().n, ledger);
    await assert.rejects(() => createSubmissionReceipt({ request: request(3), env }, db, { id: 'user-b', role: 'user' }, id), e => e.status === 404);
    await assert.rejects(() => createSubmissionReceipt({ request: request(3), env }, db, { id: 'manager-1', role: 'manager' }, id), e => e.status === 403);
  } finally { globalThis.fetch = previous; }
});

test('legacy pending upload keeps its original UUID Dropbox path after numbering backfill', async () => {
  const { LocalD1 } = await import('./local_financial_db.mjs');
  const db = new LocalD1(['0001_initial.sql','0002_passkey_auth.sql','0003_user_profiles.sql','0004_manager_submissions.sql','0005_cash_topups.sql','0006_financial_controls.sql','0007_submission_receipts.sql','0008_financial_alert_settings.sql','0009_receipt_dropbox_metadata.sql']);
  db.db.prepare('INSERT INTO users(id,name,email,position,role,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('user-a','Local User','local@example.test','Staff','user',0,'2025-01-01','2025-01-01');
  const id = 'ca000000-0000-4000-8000-000000000002'; insertSubmission(db, { id, createdAt: '2025-11-01T00:00:00.000Z' });
  const uploaded = [], shared = []; let fail = true;
  const previous = globalThis.fetch; globalThis.fetch = mockDropbox(uploaded, shared, () => fail);
  try {
    await assert.rejects(() => createSubmissionReceipt({ request: request(4), env }, db, { id: 'user-a', role: 'user' }, id), e => e.status === 503);
    const old = db.db.prepare('SELECT receipt_id,dropbox_path,state FROM receipt_dropbox_metadata').get();
    assert.equal(old.dropbox_path, `/Pengajuan Pangsuma/${old.receipt_id}.png`);
    for (const file of ['0010_request_numbers.sql','0011_request_number_receipts.sql']) db.db.exec(fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    assert.deepEqual(db.db.prepare('SELECT receipt_id,dropbox_path,state FROM receipt_dropbox_metadata').get(), old);
    fail = false;
    const retry = await createSubmissionReceipt({ request: request(4), env }, db, { id: 'user-a', role: 'user' }, id);
    assert.equal(retry.status, 200); assert.equal(uploaded.at(-1), old.dropbox_path); assert.equal(shared.at(-1), old.dropbox_path);
    const final = db.db.prepare('SELECT dropbox_path,state FROM receipt_dropbox_metadata').get(); assert.equal(final.dropbox_path, old.dropbox_path); assert.equal(final.state, 'ready');
  } finally { globalThis.fetch = previous; }
});
