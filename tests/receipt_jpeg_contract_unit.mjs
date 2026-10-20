import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import jpeg from 'jpeg-js';
import { LocalD1, insertSubmission } from './local_financial_db.mjs';
import { createSubmissionReceipt, getSubmissionReceipt } from '../functions/_lib/submission-receipts.js';
import validateJpeg from '../functions/_vendor/receipt-jpeg-decoder.js';

const actor = { id: 'user-a', role: 'user' };
const root = new URL('./fixtures/receipt-jpeg/', import.meta.url);
const fixture = name => new Uint8Array(fs.readFileSync(new URL(name, root)));
export function contractDb() {
  const db = new LocalD1(['0001_initial.sql', '0002_passkey_auth.sql', '0003_user_profiles.sql', '0004_manager_submissions.sql', '0005_cash_topups.sql']);
  db.db.exec(fs.readFileSync(new URL('../migrations/0007_submission_receipts.sql', import.meta.url), 'utf8'));
  db.db.prepare('INSERT INTO users(id,name,email,position,role,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(actor.id, 'Synthetic', 'fixture@local', 'user', 'user', 0, '2028', '2028');
  insertSubmission(db, { id: 'submission-1', createdBy: actor.id });
  return db;
}
export function uploadContract(db, bytes, key = crypto.randomUUID(), metadata = {}) {
  return createSubmissionReceipt({ request: new Request('https://local.test/api/submissions/submission-1/receipts', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ filename: 'synthetic.jpg', mimeType: 'image/jpeg', dataBase64: Buffer.from(bytes).toString('base64'), ...metadata })
  }) }, db, actor, 'submission-1');
}
async function download(db, id) {
  return new Uint8Array(await (await getSubmissionReceipt({ request: new Request('https://local.test') }, db, actor, id)).arrayBuffer());
}

test('vendored entropy and IDCT code is byte-for-byte upstream jpeg-js 0.4.4', () => {
  execFileSync(process.execPath, ['scripts/vendor-receipt-jpeg.mjs', '--check']);
});

for (const dimensions of ['64x48', '2048x2048_solid']) {
  for (const mode of ['baseline', 'progressive']) {
    for (const sampling of ['420', '422', '444']) {
      test(`synthetic ${dimensions} ${mode} ${sampling}: valid pixels, bounded allocation, stable bytes and retry`, async () => {
        const bytes = fixture(`${dimensions}_${mode}_${sampling}.jpg`), db = contractDb(), key = crypto.randomUUID();
        assert.ok(bytes.length < 512 * 1024);
        const valid = validateJpeg(bytes);
        assert.ok(valid.allocatedBytes < 64 * 1024 * 1024);
        const first = await uploadContract(db, bytes, key);
        assert.equal(first.status, 201);
        const row = await first.json();
        const got = await download(db, row.id);
        assert.deepEqual(got, bytes);
        assert.equal(row.width, valid.width); assert.equal(row.height, valid.height);
        const again = await uploadContract(db, bytes, key);
        assert.equal(again.status, 200); assert.equal((await again.json()).id, row.id);
        assert.equal(db.db.prepare('SELECT COUNT(*) n FROM submission_receipts').get().n, 1);
        assert.equal(db.db.prepare('SELECT COUNT(*) n FROM submissions').get().n, 1);
        assert.equal(db.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE entity_type='receipt'").get().n, 1);
      });
    }
  }
}

for (const mode of ['baseline', 'progressive']) {
  test(`legal ${mode} restart JPEG: DRI and RST markers survive validation`, async () => {
    const bytes = fixture(`restart_${mode}.jpg`);
    assert.ok(Buffer.from(bytes).includes(Buffer.from([255, 221])));
    assert.ok(bytes.some((x, i) => x === 255 && bytes[i + 1] >= 208 && bytes[i + 1] <= 215));
    const upstream = jpeg.decode(bytes, { useTArray: true, tolerantDecoding: false, maxMemoryUsageInMB: 64 });
    const db = contractDb(), response = await uploadContract(db, bytes);
    assert.equal(response.status, 201);
    const row = await response.json();
    assert.deepEqual([row.width, row.height], [upstream.width, upstream.height]);
    assert.deepEqual(await download(db, row.id), bytes);
  });
}

function appSegment(marker, text) {
  const data = Buffer.from(text), n = data.length + 2;
  return Buffer.concat([Buffer.from([255, marker, n >> 8, n & 255]), data]);
}
test('progressive interscan APP1/APP13 privacy metadata is removed; entropy and canonical hash stay intact', async () => {
  const original = Buffer.from(fixture('64x48_progressive_444.jpg'));
  const first = original.indexOf(Buffer.from([255, 218]));
  const second = original.indexOf(Buffer.from([255, 218]), first + 2);
  assert.ok(second > first);
  const injected = new Uint8Array(Buffer.concat([original.subarray(0, second), appSegment(225, 'Exif\0\0GPS-SYNTHETIC'), appSegment(237, 'IPTC-SYNTHETIC'), original.subarray(second)]));
  const db = contractDb(), response = await uploadContract(db, injected);
  assert.equal(response.status, 201); const row = await response.json();
  const clean = await download(db, row.id);
  assert.deepEqual(clean, new Uint8Array(original));
  const digest = await crypto.subtle.digest('SHA-256', clean);
  assert.equal(row.sha256, Buffer.from(digest).toString('hex'));
  assert.equal(row.sizeBytes, clean.length);
  const cleanPixels = jpeg.decode(clean, { useTArray: true, tolerantDecoding: false });
  const originalPixels = jpeg.decode(original, { useTArray: true, tolerantDecoding: false });
  assert.deepEqual(cleanPixels.data, originalPixels.data);
});

test('resource-heavy in-byte-limit JPEG still fails under the unchanged 64MiB budget with no writes', async () => {
  const bytes = fixture('4000x4000_solid_progressive_420.jpg'), db = contractDb();
  assert.ok(bytes.length < 512 * 1024);
  assert.throws(() => validateJpeg(bytes), /maxMemoryUsageInMB/);
  await assert.rejects(() => uploadContract(db, bytes), e => e.code === 'receipt_decode_limit');
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM submission_receipts').get().n, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM submissions').get().n, 1);
});

test('malformed scan/frame, wrong precision, no entropy and trailing bytes fail before any write', async () => {
  const original = fixture('64x48_baseline_444.jpg');
  const position = marker => Buffer.from(original).indexOf(Buffer.from([255, marker]));
  const change = (offset, value) => { const b = original.slice(); b[offset] = value; return b; };
  const sos = position(218), sof = position(192);
  const bad = [original.slice(0, -2), new Uint8Array([...original, 0]), new Uint8Array([255,216,255,217]),
    change(sos + 3, 2), change(sos + 5, 255), change(sof + 4, 12), change(sof + 11, 0), change(sof + 9, 2),
    new Uint8Array([...original.slice(0, sos + 14), 255, 217])];
  for (const bytes of bad) {
    const db = contractDb();
    await assert.rejects(() => uploadContract(db, bytes), e => e.code === 'invalid_receipt_image');
    assert.equal(db.db.prepare('SELECT COUNT(*) n FROM submission_receipts').get().n, 0);
  }
});

test('missing baseline components and incomplete progressive coefficient coverage reject despite allocated decoder planes', async () => {
  const baseline = Buffer.from(fixture('64x48_baseline_444.jpg'));
  const sos = baseline.indexOf(Buffer.from([255, 218]));
  const partialBaseline = new Uint8Array(Buffer.concat([
    baseline.subarray(0, sos + 2), Buffer.from([0, 8, 1, baseline[sos + 5], baseline[sos + 6]]), baseline.subarray(sos + 11)
  ]));
  const progressive = Buffer.from(fixture('64x48_progressive_444.jpg'));
  const first = progressive.indexOf(Buffer.from([255, 218]));
  const next = progressive.indexOf(Buffer.from([255, 218]), first + 2);
  const partialProgressive = new Uint8Array(Buffer.concat([progressive.subarray(0, next), Buffer.from([255, 217])]));
  const wrongRefinement = new Uint8Array(progressive);
  const length = (progressive[first + 2] << 8) | progressive[first + 3];
  wrongRefinement[first + 2 + length - 1] = 0x10;
  for (const bytes of [partialBaseline, partialProgressive, wrongRefinement]) {
    const db = contractDb();
    await assert.rejects(() => uploadContract(db, bytes), e => e.code === 'invalid_receipt_image');
    assert.equal(db.db.prepare('SELECT COUNT(*) n FROM submission_receipts').get().n, 0);
  }
});

for (const mode of ['grayscale', 'cmyk']) {
  test(`supported ${mode} JPEG retains the public decoder color-mode contract`, async () => {
    const bytes = fixture(`${mode}.jpg`);
    const expected = jpeg.decode(bytes, { useTArray: true, tolerantDecoding: false, maxMemoryUsageInMB: 64 });
    const db = contractDb(), response = await uploadContract(db, bytes);
    assert.equal(response.status, 201); const row = await response.json();
    assert.deepEqual([row.width, row.height], [expected.width, expected.height]);
    assert.deepEqual(await download(db, row.id), bytes);
  });
}
