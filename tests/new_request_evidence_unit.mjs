import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../site/report-evidence.js', import.meta.url), 'utf8');

test('new request evidence exposes the parent integration API', () => {
  for (const name of ['mountDraft', 'prepareDraftSubmission', 'completeDraftSubmission', 'getDraftSubmission', 'clearDraftEvidence']) {
    assert.match(source, new RegExp(`\\b${name}\\b`));
  }
  assert.match(source, /const apiObject = \{[^\n]*mountDraft/);
});

test('draft storage is session scoped and bounded to normalized base64', () => {
  assert.match(source, /sessionStorage/);
  assert.match(source, /dataBase64\.length > 699052/);
  assert.match(source, /DRAFT_CORRUPT/);
  assert.match(source, /storageRemove\(key\)/);
});

test('receipt retry uses the retained draft submission and stable idempotency key', () => {
  assert.match(source, /d\.submissionId/);
  assert.match(source, /const uploadKey = d\.uploadKey \|\| \(d\.uploadKey = String\(config\.newKey\(\)\)\)/);
  assert.match(source, /'Idempotency-Key': uploadKey/);
  assert.match(source, /clearDraftEvidence\(form, ctx\.type\)/);
});

test('ownership is checked around asynchronous processing and upload', () => {
  assert.ok((source.match(/draftOwnerOk\(ctx\)/g) || []).length >= 4);
});

test('API error draft tetap terlihat setelah finally merender status terkunci', () => {
  assert.match(source, /ctx\.draftUploadError = error\?\.message \|\| 'Foto belum berhasil diunggah\. Coba lagi\.'/);
  assert.match(source, /ctx\.status\.textContent = ctx\.draftUploadError \|\| \(ctx\.draft\?\.submissionId/);
  assert.match(source, /finally \{ ctx\.uploading = false; ctx\.uploadPromise = null; renderDraft\(ctx\); \}/);
});

test('retry draft memakai submissionId dan uploadKey tersimpan, bukan membuat identitas baru', () => {
  assert.match(source, /if \(!d\.submissionId\) \{ d\.submissionId = String\(submissionResultId \|\| ''\);/);
  assert.match(source, /const uploadKey = d\.uploadKey \|\| \(d\.uploadKey = String\(config\.newKey\(\)\)\)/);
  assert.match(source, /`\/submissions\/\$\{encodeURIComponent\(d\.submissionId\)\}\/receipts`/);
  assert.match(source, /'Idempotency-Key': uploadKey/);
});
