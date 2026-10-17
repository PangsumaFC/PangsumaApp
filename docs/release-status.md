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

## Rilis 2026.10.18.2: kompatibilitas galeri dan unduhan

Aset `app.js` dan `sw.js` pada domain produksi sebelum perubahan cocok byte-for-byte dengan commit `ba3e864`. Rute `/api/export.csv` tanpa sesi mengembalikan 401 JSON, bukan halaman HTML atau 404. Header shell `no-cache`, API `no-store`, dan service worker tidak mengintersep API. Ini tidak membuktikan halaman yang sudah terbuka di perangkat pengguna telah memuat kode baru.

Kasus yang berhasil direproduksi: PNG valid dari pemilih berkas dengan MIME `application/octet-stream` ditolak oleh `ba3e864`. Kandidat baru menormalkan metadata generik dari ekstensi yang dikenal, tetap memvalidasi isi lewat decoder, mengonversinya ke JPEG, lalu mempertahankan validasi server. Pemilih kini memakai input native yang menerima ketukan langsung, bukan pemanggilan klik sintetis. HEIC/HEIF hanya didukung bila decoder native browser dapat membacanya; browser tanpa dukungan menerima pesan untuk memilih JPG/PNG. Tidak ada klaim decoder HEIC universal.

CSV memakai attachment langsung untuk Android WebView dan iOS, dengan Blob untuk Chrome/desktop. Panel “File tidak muncul?” menyediakan tautan unduh langsung dan saran membuka Chrome/Safari. Notifikasi tidak menyatakan berkas sudah tersimpan. Tidak ada perubahan query CSV, otorisasi, database, migrasi, akun, saldo, atau data produksi. Versi `2026.10.18.2` terlihat di halaman; URL aset memakai penanda versi dan cache shell dinaikkan ke v17 tanpa reload otomatis yang menghapus draf.

Validasi kandidat:

- 71 tes JavaScript dan 16 tes schema SQLite lulus.
- E2E profil lengkap lulus, termasuk isolasi foto, konflik versi, CSRF, penolakan gambar rusak, dan data keuangan tetap sama.
- Chromium dan WebKit HTTPS lokal: klik pemilih berkas nyata, simpan foto Manager sendiri dan user, reload, serta avatar `naturalWidth > 0`; termasuk PNG bermetadata octet-stream.
- Emulasi Chromium dengan UA Android WebView dan Android Chrome: tombol utama serta tautan unduh langsung menghasilkan berkas tersimpan yang diperiksa isinya (BOM tunggal, 19 kolom, fixture pengajuan/ledger/audit, teks formula dinetralkan). Sesi tetap berlaku; ekspor tanpa sesi tetap 401.
- Pembandingan baseline: tes pemilih dengan PNG bermetadata normal lulus pada `ba3e864`; tes octet-stream gagal pada baseline dan lulus pada kandidat. Kegagalan `showPicker()` terjadi pada kandidat sementara yang dibuang, bukan bukti bug rilis lama.

Batas: belum ada reproduksi pada perangkat fisik pengguna atau ekspor terautentikasi produksi. Emulasi UA bukan Android WebView native. [Android WebView menyerahkan pemilih berkas kepada aplikasi host dan membatalkan permintaan secara default bila tidak ditangani](https://developer.android.com/reference/android/webkit/WebChromeClient#onShowFileChooser(android.webkit.WebView,%20android.webkit.ValueCallback%3Candroid.net.Uri[]%3E,%20android.webkit.WebChromeClient.FileChooserParams)); [unduhan juga diberitahukan ke aplikasi host](https://developer.android.com/reference/android/webkit/DownloadListener). Jika pengguna masih gagal, diperlukan URL yang dibuka, versi yang terlihat, perangkat/OS, browser atau aplikasi tempat tautan dibuka, tahap kegagalan dan pesan layar, serta contoh format/MIME foto. Jangan menyimpulkan masalah pengguna selesai hanya karena semua tes lokal lulus.
