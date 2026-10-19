import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('site');
const excluded = new Set(['sw.js', 'version.json']);
const files = fs.readdirSync(root)
  .filter(name => /\.(?:js|html|json|webmanifest)$/i.test(name) && !excluded.has(name))
  .map(name => path.join(root, name));
const source = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');

// These are human-facing forms, not technical identifiers such as input[type=file],
// API paths, Request Finance, or the PasswordCrypto implementation name.
test('site copy tidak memuat ejaan/status bahasa yang dilarang', () => {
  const forbiddenCopy = [
    'Saldo ter-rekonsiliasi',
    'Gunakan ID masuk dan password akun Anda.',
    '<label for="loginPassword">Password</label>',
    'Atau masuk tanpa password',
    'Setujui request',
    'Foto tidak dapat dibaca. Pilih file gambar yang valid.',
    'PDF siap. Pilih Simpan PDF untuk mengunduh file.',
    'Password diperbarui.',
    'Password belum diatur',
    'Wajib ganti password',
  ];
  for (const phrase of forbiddenCopy) assert.equal(source.includes(phrase), false, phrase);
});

test('site copy snapshot istilah utama tetap EYD dan nama produk dipertahankan', () => {
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const evidence = fs.readFileSync(path.join(root, 'report-evidence.js'), 'utf8');
  const pwa = fs.readFileSync(path.join(root, 'pwa-files.js'), 'utf8');
  assert.match(app, /Saldo terekonsiliasi/);
  assert.match(app, /Setujui pengajuan/);
  assert.match(app, /Kata sandi diperbarui/);
  assert.match(app, /Request Finance/);
  assert.match(index, /Gunakan ID masuk dan kata sandi akun Anda\./);
  assert.match(index, />Kata sandi<\/label>/);
  assert.match(evidence, /Pilih berkas JPG atau PNG\./);
  assert.match(pwa, /mengunduh berkas/);
});

test('seluruh berkas site target tercakup lint copy', () => {
  assert.ok(files.length >= 12);
  assert.ok(files.some(file => file.endsWith('manifest.webmanifest')));
  assert.ok(files.some(file => file.endsWith('app.js')));
  assert.ok(files.some(file => file.endsWith('index.html')));
});
