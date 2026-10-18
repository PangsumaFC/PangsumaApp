import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../site/financial-controls.js', import.meta.url), 'utf8');

test('draft rekonsiliasi terikat akun storage dan periode, legacy dipertahankan', () => {
  assert.match(source, /pangsuma\.financial\.\$\{kind\}\.v2:\$\{user\(\)\?\.id/);
  assert.match(source, /drafts\?\.\[period\]/);
  assert.match(source, /legacyDraft:\{ \.\.\.stored \}/);
  assert.match(source, /saveReconDraft\(state\.period, state\.draft\)/);
});

test('switch periode memuat draft yang cocok dan mereset preview/feedback tanpa menghapus draft lain', () => {
  assert.match(source, /state\.period = period; state\.preview = null; state\.success = ''; state\.error = ''/);
  assert.match(source, /state\.draft = draftFor\(period\)/);
  assert.match(source, /state\.nextCursor = null; state\.hasMore = false/);
});

test('preview, form, dan payload wajib memakai periode yang sama', () => {
  assert.match(source, /state\.draft\.period === period/);
  assert.match(source, /state\.preview\?\.period !== period/);
  assert.match(source, /const payload = \{ period, physicalCashIdr:amount, note, confirmed:true \}/);
});

test('stale request terlindungi epoch dan histori dibatasi lima per halaman', () => {
  assert.match(source, /requestId !== reconRequest \|\| period !== state\.period/);
  assert.match(source, /limit:'5'/);
  assert.match(source, /state\.page > 0/);
  assert.match(source, /state\.hasMore/);
});

test('retry payload yang sama mempertahankan idempotency key per periode', () => {
  assert.match(source, /keyFor\('reconciliation', payload\)/);
  assert.match(source, /'Idempotency-Key':key/);
  assert.match(source, /fp === fp && draft\.key/);
});
