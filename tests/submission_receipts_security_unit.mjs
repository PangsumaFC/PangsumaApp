import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import jpeg from 'jpeg-js';
import { encode as encodePng, decode as decodePng } from 'fast-png';
import { LocalD1, insertSubmission } from './local_financial_db.mjs';
import { createSubmissionReceipt, listSubmissionReceipts, getSubmissionReceipt } from '../functions/_lib/submission-receipts.js';

const MIGRATIONS = ['0001_initial.sql', '0002_passkey_auth.sql', '0003_user_profiles.sql', '0004_manager_submissions.sql', '0005_cash_topups.sql'];
const UUID = n => `123e4567-e89b-12d3-a456-42661417${String(n).padStart(4, '0')}`;
const actor = { id: 'user-a', role: 'user' };

function db() {
  const d = new LocalD1(MIGRATIONS);
  d.db.exec(fs.readFileSync(new URL('../migrations/0007_submission_receipts.sql', import.meta.url), 'utf8'));
  for (const [id, role] of [['manager-1', 'manager'], ['user-a', 'user'], ['user-b', 'user']]) {
    d.db.prepare('INSERT INTO users(id,name,email,position,role,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, id, `${id}@local`, role, role, 0, '2028', '2028');
  }
  insertSubmission(d, { id: 'submission-1', createdBy: 'user-a', status: 'approved' });
  return d;
}
function rgba(width, height, seed = 1) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const x = i % width, y = Math.floor(i / width);
    data[i * 4] = (x * 37 + y * 17 + seed * 29) & 255;
    data[i * 4 + 1] = (x * 11 + y * 53 + seed * 41) & 255;
    data[i * 4 + 2] = (x * 71 + y * 7 + seed * 13) & 255;
    data[i * 4 + 3] = 255;
  }
  return data;
}
const jpegBytes = (seed = 1) => new Uint8Array(jpeg.encode({ data: rgba(200, 200, seed), width: 200, height: 200 }, 90).data);
const pngBytes = (seed = 1) => encodePng({ width: 128, height: 128, data: rgba(128, 128, seed) });
const b64 = bytes => Buffer.from(bytes).toString('base64');
function req(key, body, headers = {}) {
  return new Request('https://local.test/api/submissions/submission-1/receipts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers }, body: JSON.stringify(body) });
}
async function upload(d, bytes, { key = UUID(1), mimeType = 'image/jpeg', filename = 'receipt.jpg', actor: who = actor, headers = {} } = {}) {
  return createSubmissionReceipt({ request: req(key, { filename, mimeType, dataBase64: b64(bytes) }, headers) }, d, who, 'submission-1');
}
async function errorOf(fn) { try { await fn(); assert.fail('expected rejection'); } catch (e) { return e; } }
function crc32(bytes, start, end) { let c = 0xffffffff; for (let i = start; i < end; i++) { c ^= bytes[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type, payload) { const t = new TextEncoder().encode(type); const out = new Uint8Array(12 + payload.length); const v = new DataView(out.buffer); v.setUint32(0, payload.length); out.set(t, 4); out.set(payload, 8); v.setUint32(8 + payload.length, crc32(out, 4, 8 + payload.length)); return out; }
function withPngText(bytes, text = 'GPS=51.5,-0.1') { const marker = pngChunk('tEXt', new TextEncoder().encode(`GPS\0${text}`)); const ihdrEnd = 8 + 12 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8); const out = new Uint8Array(bytes.length + marker.length); out.set(bytes.slice(0, ihdrEnd), 0); out.set(marker, ihdrEnd); out.set(bytes.slice(ihdrEnd), ihdrEnd + marker.length); return out; }
function withJpegExif(bytes) { const payload = new TextEncoder().encode('Exif\\0\\0GPSLatitude=51.5 GPSLongitude=-0.1'); const seg = new Uint8Array(4 + payload.length); seg.set([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]); seg.set(payload, 4); const out = new Uint8Array(bytes.length + seg.length); out.set(bytes.slice(0, 2)); out.set(seg, 2); out.set(bytes.slice(2), 2 + seg.length); return out; }

const JPEG = jpegBytes(1);
const PNG = pngBytes(1);
assert(JPEG.length > 8192 && JPEG.length < 512 * 1024, `fixture JPEG size ${JPEG.length}`);
assert(PNG.length > 8192 && PNG.length < 512 * 1024, `fixture PNG size ${PNG.length}`);

test('generated baseline JPEG is accepted, decodes at 200x200, and download has exact EOI', async () => {
  const d = db(); const response = await upload(d, JPEG); assert.equal(response.status, 201);
  const row = JSON.parse(await response.text());
  const downloaded = new Uint8Array(await (await getSubmissionReceipt({ request: new Request('https://local.test') }, d, { id: 'manager-1', role: 'manager' }, row.id)).arrayBuffer());
  assert.deepEqual(downloaded.slice(-2), Uint8Array.from([0xff, 0xd9]));
  assert.equal(downloaded.length, downloaded.findLastIndex((x, i) => x === 0xd9 && downloaded[i - 1] === 0xff) + 1);
  const decoded = jpeg.decode(downloaded, { useTArray: true }); assert.deepEqual([decoded.width, decoded.height], [200, 200]);
  assert.equal(downloaded.some((x, i) => x === 0xff && downloaded[i + 1] === 0xd9 && i + 2 < downloaded.length), false);
});

test('canonical chunked base64 accepts >8192 JPEG and rejects embedded padding/noncanonical forms', async () => {
  const d = db(); await upload(d, JPEG, { key: UUID(2) });
  for (const [n, bad] of [[3, b64(JPEG).slice(0, 100) + '=' + b64(JPEG).slice(100)], [4, b64(JPEG).replace(/=$/, '') + '=='], [5, ` ${b64(JPEG)}`]]) {
    const e = await errorOf(() => createSubmissionReceipt({ request: req(UUID(n), { filename: 'bad.jpg', mimeType: 'image/jpeg', dataBase64: bad }) }, d, actor, 'submission-1'));
    assert.equal(e.code, 'invalid_base64');
  }
});

test('PNG is validated, dimensions are retained, and ancillary text metadata is stripped', async () => {
  const d = db(); const response = await upload(d, withPngText(PNG), { key: UUID(4), mimeType: 'image/png', filename: 'receipt.png' }); assert.equal(response.status, 201);
  const row = JSON.parse(await response.text()); const got = new Uint8Array(await (await getSubmissionReceipt({ request: new Request('https://local.test') }, d, { id: 'manager-1', role: 'manager' }, row.id)).arrayBuffer());
  const decoded = decodePng(got); assert.deepEqual([decoded.width, decoded.height], [128, 128]); assert.equal(new TextDecoder().decode(got).includes('GPS='), false);
});

test('JPEG EXIF/GPS APP1 is removed while the sanitized image remains decodable', async () => {
  const d = db(); const response = await upload(d, withJpegExif(JPEG), { key: UUID(5) }); assert.equal(response.status, 201);
  const row = JSON.parse(await response.text()); const got = new Uint8Array(await (await getSubmissionReceipt({ request: new Request('https://local.test') }, d, { id: 'manager-1', role: 'manager' }, row.id)).arrayBuffer());
  assert.equal(new TextDecoder().decode(got).includes('GPSLatitude'), false); assert.deepEqual([jpeg.decode(got).width, jpeg.decode(got).height], [200, 200]);
});

test('strict malformed and truncated image inputs reject, including SOF+EOI without SOS', async () => {
  const d = db(); const truncated = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 200, 0, 200, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 0xff, 0xd9]);
  for (const bytes of [truncated, JPEG.slice(0, -2), Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])]) assert.equal((await errorOf(() => upload(d, bytes, { key: crypto.randomUUID() }))).code, 'invalid_receipt_image');
});

test('type confusion, corrupt CRC/oversized dimensions, and >512KiB payload reject', async () => {
  const d = db(); const png = PNG.slice(); png[29] ^= 1;
  for (const [bytes, mime] of [[new TextEncoder().encode('<svg></svg>'), 'image/jpeg'], [PNG, 'image/jpeg'], [png, 'image/png']]) assert.match((await errorOf(() => upload(d, bytes, { key: crypto.randomUUID(), mimeType: mime }))).code, /invalid_receipt_image/);
  const huge = new Uint8Array(8); huge.set([137,80,78,71,13,10,26,10]); const ihdr = new Uint8Array(13); const hv = new DataView(ihdr.buffer); hv.setUint32(0, 5000); hv.setUint32(4, 5000); ihdr[8] = 8; const hugePng = new Uint8Array(huge.length + pngChunk('IHDR', ihdr).length + pngChunk('IEND', new Uint8Array()).length); hugePng.set(huge); let hp = 8; for (const part of [pngChunk('IHDR', ihdr), pngChunk('IEND', new Uint8Array())]) { hugePng.set(part, hp); hp += part.length; } assert.equal((await errorOf(() => upload(d, hugePng, { key: crypto.randomUUID(), mimeType: 'image/png' }))).code, 'invalid_receipt_image');
  const tooBig = new Uint8Array(512 * 1024 + 1); tooBig.set(JPEG); assert.equal((await errorOf(() => upload(d, tooBig, { key: crypto.randomUUID() }))).status, 400);
});

test('declared 800KiB request is rejected before body decode', async () => {
  const d = db(); const e = await errorOf(() => createSubmissionReceipt({ request: req(UUID(30), { filename: 'x.jpg', mimeType: 'image/jpeg', dataBase64: 'not-read' }, { 'Content-Length': String(800 * 1024 + 1) }) }, d, actor, 'submission-1')); assert.equal(e.code, 'payload_too_large'); assert.equal(d.db.prepare('SELECT COUNT(*) n FROM submission_receipts').get().n, 0);
});

test('inactive/wrong-role/missing actors are 401 on upload, list and download', async () => {
  const d = db(); const made = JSON.parse(await (await upload(d, JPEG, { key: UUID(31) })).text()); d.db.prepare('UPDATE users SET is_active=0 WHERE id=?').run('user-a');
  for (const fn of [() => upload(d, JPEG, { key: UUID(32) }), () => listSubmissionReceipts({ request: new Request('https://local.test') }, d, actor, 'submission-1'), () => getSubmissionReceipt({ request: new Request('https://local.test') }, d, actor, made.id), () => upload(d, JPEG, { key: UUID(33), actor: { id: 'user-a', role: 'manager' } })]) assert.equal((await errorOf(fn)).status, 401);
});

test('ownership, response headers, no ledger/account mutation, dedup and conflict semantics hold', async () => {
  const d = db(); const before = JSON.stringify({ account: d.db.prepare('SELECT * FROM cash_accounts').all(), ledger: d.db.prepare('SELECT * FROM cash_ledger').all() }); const first = JSON.parse(await (await upload(d, JPEG, { key: UUID(40) })).text());
  const duplicate = JSON.parse(await (await upload(d, JPEG, { key: UUID(41), filename: 'new.jpg' })).text()); assert.equal(duplicate.id, first.id);
  const changed = await errorOf(() => upload(d, jpegBytes(2), { key: UUID(40), filename: 'changed.jpg' })); assert.equal(changed.status, 409);
  const other = await errorOf(() => getSubmissionReceipt({ request: new Request('https://local.test') }, d, { id: 'user-b', role: 'user' }, first.id)); assert.equal(other.status, 404);
  const binary = await getSubmissionReceipt({ request: new Request('https://local.test') }, d, { id: 'manager-1', role: 'manager' }, first.id); assert.equal(binary.headers.get('Cache-Control'), 'private, no-store, max-age=0'); assert.equal(binary.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(JSON.stringify({ account: d.db.prepare('SELECT * FROM cash_accounts').all(), ledger: d.db.prepare('SELECT * FROM cash_ledger').all() }), before);
});

test('receipt metadata and audit rows contain no blob/base64 payload or oversized metadata', async () => {
  const d = db(); const row = JSON.parse(await (await upload(d, JPEG, { key: UUID(50) })).text()); const listed = await listSubmissionReceipts({ request: new Request('https://local.test') }, d, { id: 'manager-1', role: 'manager' }, 'submission-1');
  assert.equal(JSON.stringify(row).includes(b64(JPEG)), false); assert.equal(JSON.stringify(JSON.parse(await listed.text())).includes(b64(JPEG)), false);
  const audit = d.db.prepare("SELECT details_json FROM audit_events WHERE entity_type='receipt'").all(); assert.equal(audit.length, 1); assert.equal(audit[0].details_json.includes(b64(JPEG)), false); assert.equal(audit[0].details_json.length < 1000, true);
});

test('eleven distinct uploads enforce ten maximum with a domain 400/409 rather than generic 503', async () => {
  const d = db(); for (let i = 0; i < 10; i++) assert.equal((await upload(d, jpegBytes(i + 10), { key: UUID(60 + i) })).status, 201);
  const e = await errorOf(() => upload(d, jpegBytes(99), { key: UUID(71) })); assert.ok([400, 409].includes(e.status), `unexpected status ${e.status} (${e.code})`); assert.notEqual(e.status, 503);
});

test('append-only receipt triggers reject direct update and delete', async () => {
  const d = db(); const id = JSON.parse(await (await upload(d, JPEG, { key: UUID(80) })).text()).id;
  assert.throws(() => d.db.prepare('UPDATE submission_receipts SET filename=? WHERE id=?').run('mutated.jpg', id), /append_only/);
  assert.throws(() => d.db.prepare('DELETE FROM submission_receipts WHERE id=?').run(id), /append_only/);
});
