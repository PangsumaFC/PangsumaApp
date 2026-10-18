import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');

test('audit: draft laporan disimpan di jenis aktif sebelum select berpindah', () => {
  assert.match(source, /function persistReportDraft\(type = reportTypePreset\)/);
  assert.match(source, /persistReportDraft\(reportTypePreset\);\s+reportTypePreset = String\(event\.target\.value\)/);
  assert.match(source, /event\.target\.id !== 'reportType'/);
  assert.match(source, /submissionIdempotencyKey = reportDraft\(reportTypePreset\)\.idempotencyKey \|\| ''/);
});

test('audit: dialog activity dan top-up menolak backdrop serta Escape saat busy/pending', () => {
  assert.match(source, /function canCloseAppDialog\(dialog\)/);
  assert.match(source, /dialog\.id === 'reportActivityDialog'\) return canCloseReportActivity\(dialog\)/);
  assert.match(source, /dialog\.id === 'cashTopupDialog' && cashTopupBusy/);
  assert.match(source, /event\.target === dialog && canCloseAppDialog\(dialog\)/);
  assert.match(source, /!canCloseAppDialog\(event\.currentTarget\)\) event\.preventDefault/);
});

test('audit: reset password mengunci id dan email sebelum derivasi async', () => {
  assert.match(source, /const targetId = resetTargetId/);
  assert.match(source, /const targetEmail = target\?\.email/);
  assert.match(source, /resetTargetId !== targetId \|\| state\.users\.find\(user => user\.id === targetId\)\?\.email !== targetEmail/);
  assert.match(source, /users\/\$\{encodeURIComponent\(targetId\)\}\/password/);
});

test('audit: mutasi sukses membedakan refresh gagal dari mutasi gagal', () => {
  assert.match(source, /async function renderAfterMutation\(successMessage/);
  assert.match(source, /Ringkasan belum diperbarui; muat ulang saat koneksi tersedia/);
  assert.match(source, /await renderAfterMutation\(action\.successMessage/);
  assert.match(source, /await renderAfterMutation\(result\.alreadyApplied/);
});

test('audit: pencarian user menerima label status terlokalisasi', () => {
  assert.match(source, /'disetujui': 'approved'/);
});

test('audit: pending queue memakai window oldest dan count transparan', () => {
  assert.match(source, /pendingSubmissions/);
  assert.match(source, /Array\.isArray\(state\.pendingSubmissions\)/);
  assert.match(source, /pendingPage\.total/);
  assert.match(source, /limit: '5'/);
});

test('audit: polling user/manager refresh tidak menimpa draf dan user table ikut refresh', () => {
  assert.match(source, /currentPage === 'new-report'/);
  assert.match(source, /requestUserOverviewRefresh\(\)/);
  assert.match(source, /if \(currentPage === 'users'\) await refreshUsersPage\(Number\(state\.usersPage\.page \|\| 1\)\)/);
  assert.match(source, /requestManagerOverviewRefresh\(true\)/);
});

test('audit: laporan user memakai server search dan alias status canonical', () => {
  assert.match(source, /path\.startsWith\('\/history\/submissions'\)/);
  assert.match(source, /query\.set\('status', aliases/);
  assert.match(source, /query\.set\('q', search\)/);
});

test('audit: user admin list memakai pagination dan total server', () => {
  assert.match(source, /api\(`\/users\?page=\$\{page\}&limit=5&q=/);
  assert.match(source, /state\.usersPage = \{ page:/);
  assert.match(source, /data-action=\"load-more-users\"/);
});

test('audit: perubahan tipe laporan tidak menyimpan draf silang', () => {
  assert.match(source, /event\.target\.closest\?\.\('#reportForm'\) && event\.target\.id !== 'reportType'/);
  assert.match(source, /typeof reportTypePreset !== 'undefined'/);
});
