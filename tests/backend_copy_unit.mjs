import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const API_FILE = new URL('../functions/api/[[path]].js', import.meta.url);
const PAGINATION_FILE = new URL('../functions/_lib/report-pagination.js', import.meta.url);
const REVISED_BACKEND_FILES = [
  API_FILE, PAGINATION_FILE,
  new URL('../functions/_lib/auth.js', import.meta.url),
  new URL('../functions/_lib/http.js', import.meta.url),
  new URL('../functions/_lib/migration-guard.js', import.meta.url),
  new URL('../functions/_lib/webauthn.js', import.meta.url),
  new URL('../functions/_lib/cash-topup.js', import.meta.url),
  new URL('../functions/_lib/report-filters.js', import.meta.url)
];

// Snapshot copy yang menjadi kontrak UI; identifier, aturan bisnis, dan log tidak diuji di sini.
test('backend copy snapshot menggunakan nama produk dan peran yang konsisten', async () => {
  const source = (await Promise.all(REVISED_BACKEND_FILES.map(file => readFile(file, 'utf8')))).join('\n');
  assert.match(source, /Pilih Petty Cash atau Request Finance\./);
  assert.match(source, /Saldo Petty Cash tidak mencukupi\./);
  assert.match(source, /Request Finance harus disetujui Manager/);
  assert.match(source, /Aksi ini hanya tersedia untuk Manager\./);
  assert.match(source, /Hanya Manager yang dapat melihat laporan\./);
  assert.match(source, /Kata sandi saat ini tidak sesuai\./);
  assert.match(source, /ID masuk atau kata sandi tidak sesuai\./);
  for (const message of [
    'Layanan kata sandi belum dikonfigurasi.', 'Kredensial kata sandi tidak valid.',
    'Kata sandi harus berisi 12–128 karakter.', 'Metode permintaan tidak didukung.',
    'Permintaan tidak valid.', 'Asal permintaan tidak diizinkan.', 'Isi permintaan tidak dapat dibaca.',
    'sebelum masuk atau mengakses profil.', 'lalu ulangi permintaan.',
    'Kunci isi saldo sudah dipakai untuk isi yang berbeda.', 'Keterangan isi saldo wajib diisi 3–500 karakter.',
    'Hanya Manager yang dapat melihat laporan.', 'Aksi ini hanya tersedia untuk Manager.'
  ]) assert.ok(source.includes(message), `pesan backend hilang: ${message}`);
  assert.doesNotMatch(source, /Saldo petty cash|password tidak sesuai|Password saat ini|Metode request|Request tidak valid|Isi request|Asal request/);
});
