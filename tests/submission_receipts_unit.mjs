import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalD1, insertSubmission } from './local_financial_db.mjs';
import { createSubmissionReceipt, listSubmissionReceipts, getSubmissionReceipt } from '../functions/_lib/submission-receipts.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAE0lEQVR4nGP8z8DAwMDAxIBMAQAUQAEF3SN5DgAAAABJRU5ErkJggg==';
const idempotency = n => `123e4567-e89b-12d3-a456-4266141740${String(n).padStart(2, '0')}`;
function db() {
  const d = new LocalD1(['0001_initial.sql','0002_passkey_auth.sql','0003_user_profiles.sql','0004_manager_submissions.sql','0005_cash_topups.sql','0006_financial_controls.sql','0007_submission_receipts.sql']);
  for (const [id, role] of [['manager-1','manager'],['user-a','user'],['user-b','user']]) d.db.prepare('INSERT INTO users(id,name,email,position,role,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,id,`${id}@local`,role,role,0,'2028','2028');
  insertSubmission(d, { id: 'submission-1', createdBy: 'user-a', status: 'approved' });
  return d;
}
function request(key, body, method = 'POST') { return new Request('https://local.test/api/submissions/submission-1/receipts', { method, headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: method === 'POST' ? JSON.stringify(body) : undefined }); }
const upload = (d, actor = { id: 'user-a', role: 'user' }, key = idempotency(1), extra = {}) => createSubmissionReceipt({ request: request(key, { filename: 'receipt.png', mimeType: 'image/png', dataBase64: PNG, ...extra }) }, d, actor, 'submission-1');

test('owner uploads, exact duplicate is one row and one receipt audit', async () => {
  const d = db(); const before = d.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE entity_type='receipt'").get().n;
  const first = await upload(d); const second = await upload(d, { id: 'user-a', role: 'user' }, idempotency(2));
  assert.equal(first.status, 201); assert.equal(second.status, 200); assert.equal(JSON.parse(await first.clone().text()).id, JSON.parse(await second.text()).id);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM submission_receipts').get().n, 1);
  assert.equal(d.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE entity_type='receipt'").get().n, before + 1);
  assert.equal(d.db.prepare('SELECT balance_idr FROM cash_accounts WHERE id=\'operational\'').get().balance_idr, 0);
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM cash_ledger').get().n, 1);
});

test('other user gets generic 404; manager can list/download', async () => {
  const d = db(); const made = JSON.parse(await (await upload(d)).text());
  await assert.rejects(() => listSubmissionReceipts({ request: new Request('https://local.test') }, d, { id: 'user-b', role: 'user' }, 'submission-1'), e => e.status === 404);
  const listed = await listSubmissionReceipts({ request: new Request('https://local.test') }, d, { id: 'manager-1', role: 'manager' }, 'submission-1'); assert.equal(JSON.parse(await listed.text()).count, 1);
  const binary = await getSubmissionReceipt({ request: new Request('https://local.test') }, d, { id: 'manager-1', role: 'manager' }, made.id); assert.equal(binary.headers.get('Content-Type'), 'image/png'); assert.equal(binary.headers.get('Cache-Control'), 'private, no-store, max-age=0');
});

test('malformed MIME, SVG, trailing PNG, and conflicting idempotency fail closed', async () => {
  const d = db(); await assert.rejects(() => upload(d, undefined, idempotency(3), { mimeType: 'image/jpeg' }), e => e.code === 'invalid_receipt_image');
  await assert.rejects(() => upload(d, undefined, idempotency(4), { mimeType: 'image/svg+xml' }), e => e.code === 'invalid_mime_type');
  await assert.rejects(() => upload(d, undefined, idempotency(5), { dataBase64: PNG + 'AAAA' }), e => e.code === 'invalid_base64');
  await upload(d); await assert.rejects(() => upload(d, undefined, idempotency(1), { filename: 'other.png' }), e => e.status === 409);
});
