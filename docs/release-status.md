# Rilis 2026.10.18.9 — hapus fallback PDF keluar APK

Perubahan terbatas pada situs: APK yang memiliki bridge `PangsumaFileBridge` tidak lagi ditawari Chrome, intent, salin tautan, atau unduh langsung palsu. Tombol PDF hanya menampilkan “Unduh PDF langsung memerlukan APK yang diperbarui.” Jalur PDF browser/PWA biasa tetap dipertahankan. Deteksi APK memakai bridge yang diketahui, bukan user-agent. Wrapper tanpa bridge itu tidak dapat dipastikan sebagai APK.

Tidak ada perubahan APK, unggah foto, backend, database, transaksi, atau data produksi. Deployment menggunakan workflow yang ada dengan probe skema read-only; tidak menjalankan migrasi. Rilis ini tidak membuktikan direct PDF maupun photo upload telah berfungsi di APK. Handler native dan pengujian perangkat fisik masih diperlukan.

Pengujian rilis: `npm test`, kedua suite SQLite offline, dan `bash tests/run-profile-local.sh --mobile-download` dengan database lokal sementara. Keberhasilan live harus diverifikasi dari workflow commit yang sama dan `/version.json` build `2026.10.18.9`.

Hasil lokal: 269 tes unit lulus, 9 tes profil/skema dan 7 tes skema pengajuan Manager lulus; E2E bridge UA WebView dan bridge UA Chrome menampilkan status saja (0 export PDF, 0 pemanggilan CSV, 0 popup, 0 clipboard). Chrome dan simulasi PWA standalone mengunduh PDF valid, unduhan langsung tetap bekerja, filter tepat, dan sesi bertahan. Tidak ada pengujian Android fisik.

## Arsip rilis 2026.10.18.5

### PWA dan antarmuka ringkas

Basis rilis ini adalah produksi `2026.10.18.4` pada commit `5b59991`. Ini pembaruan web/PWA pada origin yang sama, bukan APK atau wrapper Android baru. Tidak ada migrasi, perubahan saldo, transaksi contoh, perubahan akun, atau perubahan database produksi dalam pekerjaan ini. Push biasa ke `main` memakai workflow yang sudah ada; gate D1 tetap read-only dan tidak boleh dilewati.

## Satu lokasi untuk setiap tindakan

| Tindakan | Lokasi utama |
| --- | --- |
| User membuat laporan | Menu **Buat laporan**; sidebar desktop dan tombol tambah mobile adalah padanan responsif, tidak terlihat bersamaan |
| Manager membuat pengajuan sendiri | Satu tombol **Buat pengajuan** di Ringkasan |
| Memilih Petty cash / Request Finance | Satu kolom jenis dalam form; dialog pemilihan awal yang mengulang fungsi tersebut dihapus |
| Menyetujui atau menolak | Halaman **Persetujuan**, tetap dengan konfirmasi, alasan, larangan keputusan sendiri, dan pemeriksaan saldo |
| Menandai Request Finance terkirim | Kartu hasil laporan di **Finance**, hanya untuk request yang disetujui; tidak ada daftar Finance kedua |
| Isi ulang, saldo awal, unduh PDF | **Finance** |
| Rincian saldo, tren dan batas perangkat | Disclosure **Rincian saldo dan tren petty cash** di Finance |
| Rekonsiliasi dan ambang organisasi | Disclosure kontrol keuangan di Finance; ambang organisasi tetap berbeda dari batas perangkat |
| Password dan pengelolaan akun | Kontrol header sesuai role; tidak digandakan dalam menu User |
| Aktivitas, nota, dan audit laporan | Detail pengajuan; riwayat sistem dan ledger tetap tersedia pada disclosure masing-masing |

Ringkasan Manager tidak lagi menampilkan pengajuan yang sama dalam tiga daftar (antrean, hari ini, terbaru). Kini hanya ada satu daftar terbaru, saldo utama, ringkasan jumlah, dan peringatan aktif. Dashboard User tidak lagi mengulang CTA, panel instruksi besar, atau status+timeline untuk item yang sama. Finance memakai satu daftar terfilter sebagai sumber eksplorasi dan tindakan; metrik dan daftar request kedua dihapus. Daftar overdue tidak disalin ke dashboard; peringatan jumlah tetap tampil dan keputusan tetap di Persetujuan. Pesan error, draft, konflik, konfirmasi kas, dan jejak audit dipertahankan.

## Foto dan unduhan dalam PWA

Picker foto kini input native yang terlihat, bukan overlay transparan. JPEG/PNG/WebP dari penyedia yang memberi MIME generik atau kosong dan nama tanpa ekstensi dapat dikenali melalui header singkat, lalu tetap didekode dan divalidasi. Pembatalan tidak menghapus draf sebelumnya. Batas ukuran dan validasi server tidak dilonggarkan.

Mode standalone/fullscreen memakai tautan attachment PDF same-origin secara sinkron pada ketukan pengguna, bukan Blob yang baru dibuat setelah fetch selesai. Filter yang diterapkan, cookie sesi, MIME PDF, dan Content-Disposition tetap dipertahankan. Pesan tidak mengklaim file sudah tersimpan; tautan pemulihan tetap ada jika perangkat tidak menampilkan hasil.

Build HTML, semua JS/CSS, cache service worker dan `version.json` disamakan. Banner hanya menawarkan versi yang lebih baru, tersedia untuk seluruh role dan login, serta tidak tertutup overlay login. Reload tetap eksplisit dan diblokir saat transaksi atau draf belum aman.

## Bukti pengujian

Semua pengujian transaksi memakai database lokal sementara. Bukti proses dan screenshot berada di workspace artefak, bukan data produksi.

- Unit JavaScript/SQLite dan integritas skema lokal dijalankan melalui `npm test` serta `python3 -B tests/profile_schema_unit.py`.
- Pengujian foto memeriksa berkas rusak/berbahaya, MIME/ekstensi, pemilih native Chromium, decoding JPEG/PNG/WebP, draf dan pemulihan, simpan/reload profil Manager serta User yang dikelola Manager, dan tidak berubahnya data finansial.
- PDF browser diuji sebagai attachment nyata beserta teks, sesi dan respons 401. Regresi khusus standalone menyertakan dua fixture, filter URL tepat, hasil yang termasuk/terkecuali dalam teks PDF, respons attachment yang ditunda 5,2 detik, serta tidak dibuatnya Blob URL.
- Uji responsif mencakup 320/390px, landscape 844×390, desktop, dialog tanpa overflow horizontal, target sentuh 44px, serta fokus form pada simulasi viewport keyboard 390×420.
- Pembaruan menguji versi baru/lebih lama, layar login, draf, konfirmasi batal, dan transaksi aktif.
- Regresi dashboard memeriksa kedua role, lokasi tindakan tunggal, tidak ada kartu laporan berulang pada halaman yang sama, dan akses kemampuan penting setelah pemindahan.

Perintah pengujian utama: `bash tests/run-profile-local.sh --image-upload`, `--mobile-download`, `--manager-actions`, `--app-update`, `--financial-controls`; `./tests/run-pwa-local.sh`; serta `bash tests/run-profile-local.sh --dashboard-design`.

## Batas bukti yang tidak boleh disalahartikan

Belum ada perangkat Android/PWA terpasang nyata yang diuji. Emulasi UA, matchMedia standalone, event cancel, landscape dan viewport keyboard di Chromium bukan bukti sistem operasi Android atau galeri fisik. Jangan menyebut kasus perangkat pengguna sudah terbukti selesai sebelum penerimaan di ikon PWA pada HP-nya.

Penerimaan minimum: pastikan versi `.5` terlihat dari ikon PWA, pilih lalu simpan foto dan buka ulang, batalkan lalu pilih lagi, kembali dari galeri dengan draf tetap ada, unduh PDF terfilter dan buka file di Unduhan, lalu periksa sesi dan form saat keyboard terbuka. Tidak perlu menghapus data atau menginstal ulang sebagai langkah awal. Rincian kontrak dan langkah diagnosis ada di [Regresi berkas PWA](pwa-file-regression.md).

Keberhasilan deployment harus dibuktikan oleh workflow commit rilis yang sama dan respons read-only `https://app.pangsumafc.com/version.json` yang menunjukkan `2026.10.18.5`; hasil lokal saja bukan bukti rilis live.
