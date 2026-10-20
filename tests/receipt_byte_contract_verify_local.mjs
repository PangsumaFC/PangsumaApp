// Entirely local: synthetic fixtures + in-memory SQLite. Never calls fetch().
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { LocalD1, insertSubmission } from './local_financial_db.mjs';
import { createSubmissionReceipt } from '../functions/_lib/submission-receipts.js';
const actor = { id: 'user-a', role: 'user' };
function db() {
  const d = new LocalD1(['0001_initial.sql', '0002_passkey_auth.sql', '0003_user_profiles.sql', '0004_manager_submissions.sql', '0005_cash_topups.sql']);
  d.db.exec(fs.readFileSync(new URL('../migrations/0007_submission_receipts.sql', import.meta.url), 'utf8'));
  d.db.prepare('INSERT INTO users(id,name,email,position,role,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(actor.id, 'Synthetic', 'synthetic@local', 'user', 'user', 0, '2028', '2028');
  insertSubmission(d, { id: 'submission-1', createdBy: actor.id }); return d;
}
async function post(handler, body) {
  const d = db(), key = crypto.randomUUID();
  const context = () => ({ request: new Request('https://local.test/api/submissions/submission-1/receipts', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }) });
  try {
    const first = await handler(context(), d, actor, 'submission-1');
    const row = await first.json();
    const retry = await handler(context(), d, actor, 'submission-1');
    assert.equal(first.status, 201); assert.equal(retry.status, 200); assert.equal((await retry.json()).id, row.id);
    assert.equal(d.db.prepare('SELECT COUNT(*) n FROM submission_receipts').get().n, 1);
    assert.equal(d.db.prepare('SELECT COUNT(*) n FROM submissions').get().n, 1);
    return { status: first.status, width: row.width, height: row.height, idempotent: true };
  } catch (error) { return { status: error.status, code: error.code, message: error.message }; }
}
const originalCommit = 'c39266648c4af5fd56e372eba3e449ed3aa94ac4';
const originalSource = execFileSync('git', ['show', `${originalCommit}:functions/_lib/submission-receipts.js`], { encoding: 'utf8' });
const originalLocation = new URL('../functions/_lib/submission-receipts.js', import.meta.url);
const resolvedSource = originalSource.replace(/from '([^']+)'/g, (_, specifier) =>
  `from '${specifier.startsWith('.') ? new URL(specifier, originalLocation).href : import.meta.resolve(specifier)}'`);
const old = await import(`data:text/javascript;base64,${Buffer.from(resolvedSource).toString('base64')}`);
const reproduction = [];
for (const [name, code] of [
  ['64x48_progressive_420.jpg', 'invalid_receipt_image'],
  ['2048x2048_solid_baseline_422.jpg', 'receipt_decode_limit'],
  ['2048x2048_solid_baseline_444.jpg', 'receipt_decode_limit'],
  ['2048x2048_solid_progressive_444.jpg', 'invalid_receipt_image'],
  ['restart_baseline.jpg', 'invalid_receipt_image'],
  ['restart_progressive.jpg', 'invalid_receipt_image']
]) {
  const bytes = fs.readFileSync(new URL(`./fixtures/receipt-jpeg/${name}`, import.meta.url));
  const body = { filename: 'synthetic.jpg', mimeType: 'image/jpeg', dataBase64: bytes.toString('base64') };
  const before = await post(old.createSubmissionReceipt, body), after = await post(createSubmissionReceipt, body);
  assert.equal(before.code, code); assert.equal(after.status, 201);
  reproduction.push({ fixture: name, before, after });
}
const input = process.argv[2] || '.evidence/browser-normalized.json';
const browser = JSON.parse(fs.readFileSync(input, 'utf8'));
assert.equal(browser.source, 'synthetic-loopback');
const cases = [...browser.cases.out, browser.cases.long, browser.cases.wrongMime];
const normalized = [];
for (const item of cases) {
  const result = await post(createSubmissionReceipt, { filename: item.filename, mimeType: item.mimeType, dataBase64: item.bytesBase64 });
  assert.equal(result.status, 201, JSON.stringify({ kind: item.kind, result }));
  assert.deepEqual([result.width, result.height], [item.width, item.height]);
  normalized.push({ kind: item.kind || item.filename, mime: item.mimeType, bytes: item.byteLength, ...result });
}
console.log(JSON.stringify({ passed: true, originalCommit, reproduction, browserCases: normalized.length, normalized }, null, 2));
