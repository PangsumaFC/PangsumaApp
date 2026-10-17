# Rilis Manager, CSV, foto, dan gerbang tes

## Perubahan utama

Manager aktif dapat membuat pengajuan sendiri. Pengajuan Manager otomatis disetujui dan masuk agregasi; petty cash mendebit saldo tersedia tepat sekali, sedangkan permintaan Finance masuk antrean Finance. Saldo tidak mencukupi membatalkan seluruh batch. Keputusan manual atas pengajuan sendiri tetap ditolak.

Ekspor CSV mendukung BOM, kolom lengkap, escaping, dan perlindungan formula spreadsheet. Validasi foto memiliki fallback decoder, mengenali metadata MIME kosong, dan mempertahankan draf bila foto pengganti tidak valid.

Autentikasi password tetap aktif dan passkey tetap nonaktif. Rilis tidak menjalankan bootstrap ulang, mengubah saldo awal, mengatur ulang akun, atau mengubah DNS/domain.

## Validasi lokal

- JavaScript: 42 tes lulus.
- SQLite profil: 9 tes lulus.
- SQLite pengajuan Manager: 7 tes lulus.
- E2E lokal Manager/CSV/foto: lulus, termasuk persetujuan otomatis, debit sekali, rollback saldo tidak mencukupi, penolakan keputusan sendiri, unduhan CSV, dan fallback foto.
- `git diff --check`: lulus.

Hasil lokal bukan bukti deployment produksi. Status akhir harus merujuk hasil GitHub Actions dan pemeriksaan aplikasi live untuk commit yang dirilis.

## Persetujuan dan urutan produksi

Pemilik telah menyetujui penerapan `migrations/0004_manager_submissions.sql` ke D1 produksi, commit, dan deploy. Targetnya Pages `pangsuma-app`, branch produksi `main`, domain `https://app.pangsumafc.com`, dan D1 `pangsuma-app-prod` (`be808421-88ce-4a48-9dcd-eb0f39ae0314`).

Akses Cloudflare memakai secret GitHub Actions yang sudah ada. Paket harus di-commit dan di-push ke branch kerja agar workflow dapat menjalankan migrasi; aplikasi baru belum dipublikasikan pada tahap ini. Jalankan workflow deploy pada branch kerja dengan input `apply_manager_migration=true`. Mode ini menjalankan tes dan migrasi 0004 saja, tanpa deploy. Operator mengunci akun/database, checksum SQL, serta daftar migrasi sebelumnya dan mengambil bookmark pemulihan D1 sebelum perubahan.

Setelah migrasi berhasil dan trigger diverifikasi, fast-forward commit yang sama ke `main` untuk menjalankan deploy biasa. Gerbang tes, domain terpasang, kolom autentikasi/profil, dan trigger 0004 wajib lulus sebelum upload. Push biasa tidak menerapkan migrasi otomatis. Concurrency produksi tidak membatalkan operasi yang sedang berjalan.

Tidak ada transaksi uji atau perubahan akun yang perlu dilakukan di produksi. Verifikasi pascarilis memakai health check, respons halaman, dan kecocokan aset terhadap commit yang dirilis. Panduan profil lama tetap relevan untuk 0003; prosedur 0004 mengikuti dokumen ini.
