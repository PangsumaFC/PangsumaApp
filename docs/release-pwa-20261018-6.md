# Rilis PWA 2026.10.18.6

Basis: `700a17a` / `.5`. Ini pembaruan PWA di origin yang sama, bukan APK. Tidak ada migrasi, transaksi, perubahan akun/saldo atau data produksi. Deployment tetap melalui push `main` dan gate CI/D1 read-only.

## Perbaikan

**PDF:** PWA menyiapkan file dengan fetch same-origin/cookie sesi dan filter terapan. Dialog memberi status proses/gagal/siap serta Simpan PDF, Bagikan/simpan ke bila didukung, tautan browser, dan coba lagi. Share membutuhkan ketukan baru. Blob URL hidup sampai dialog ditutup. HTTP, MIME, isi tidak kosong dan signature PDF diperiksa. Logout/perubahan sesi membatalkan dan membersihkan file. Tidak mengklaim file tersimpan hanya karena tombol diketuk. Tab biasa mempertahankan alurnya; attachment lama menjadi fallback bila helper tidak tersedia.

**Foto:** picker nota tidak lagi memaksa kamera dan mempunyai label native terkait. JPEG/PNG dari galeri dengan metadata generik dikenali dari header terbatas, lalu didekode, dinormalisasi dan divalidasi server. Kegagalan bitmap memiliki fallback data URL. Kompresi memakai satu decoder dan menjaga rasio gambar. CSP mengizinkan pratinjau blob lokal tanpa mengizinkan origin gambar eksternal. Input dikunci selama proses/unggah dan seleksi baru mereset kunci idempotensi. Batas ukuran/format server tetap berlaku. Foto profil tetap memakai picker native dan validasi yang sudah ada.

**Update:** pemeriksaan dimulai sebelum autentikasi, termasuk login, lalu mengikuti fokus/pageshow/online/visibility dan aktivasi worker. Versi terpasang serta Cek pembaruan ada di login/footer. Reload tetap eksplisit dengan proteksi draf/transaksi dan menunggu worker aktif; tidak menghapus storage atau unregister worker.

**Pengguna:** heading/form/tombol dan kelompok status dirapikan. Layar sampai 1100px menggunakan kartu berlabel, bukan enam kolom sempit. Lebar tabel desktop tidak terbawa ke kartu. Tombol membungkus teks dan minimal 44px.

**Ikon:** crest asli dipotong pada padding alfa dan dipusatkan tanpa menggambar ulang. Latar launcher biru brand penuh, bukan putih. Ikon any 192/512; maskable 192/512 dengan crest di dalam radius safe zone 0,4; Apple 180 dan favicon 16/32/48. URL ikon diberi versi `.6`; id/start/scope tetap. Generator: `scripts/build-pwa-icons.py`.

## Bukti lokal

- `npm test`: 238 tes JavaScript lulus pada gate rilis.
- `python3 -B tests/profile_schema_unit.py`: 9 tes SQLite lulus.
- `python3 -B tests/manager_submission_schema_unit.py`: 7 tes SQLite lulus.
- `python3 -B tests/pwa_icons_unit.py`: 4 pemeriksaan dimensi, centering, safe zone, manifest dan reproduksibilitas lulus.
- `bash tests/run-pwa-local.sh`: chooser profil generik, simpan/reload, cancel/draf, 320/390/landscape/keyboard; PDF terfilter nyata dengan fetch ditunda 5,2 detik, unduhan Blob, simulasi share, sesi aktif; banner Manager/logout.
- `bash tests/run-profile-local.sh --pwa-release`: Pengguna 320/390/768/1280 tanpa overflow, tombol 44px, chooser nota PNG generik tanpa ekstensi, preview terbaca tanpa pelanggaran CSP, cancel, unggah 201 dan persistensi setelah dibuka ulang.
- `bash tests/run-profile-local.sh --app-update`: startup login, banner, transaksi aktif, draf, batal dan reload eksplisit.

Bootstrap/fixture/transaksi pengujian hanya di database lokal sementara. Keberhasilan live harus dibuktikan workflow commit yang sama dan `https://app.pangsumafc.com/version.json` yang mengembalikan `.6`.

## Batas dan penerimaan

Simulasi Chromium bukan Android fisik, galeri perangkat, Web Share OS atau launcher nyata. Jangan menyebut kasus HP pengguna sudah terbukti selesai. Penerimaan dari ikon PWA: lihat `.6`, simpan foto profil, unggah nota, siapkan PDF lalu Simpan atau Bagikan dan periksa hasil di Unduhan.

Launcher lama bisa tertahan cache Android/Chrome meski kode aplikasi sudah `.6`. Jangan menghapus data atau memasang ulang sebagai langkah pertama. Buka PWA online dan beri kesempatan pembaruan manifest. Hanya jika ikon tetap lama setelah kode terbaru, pertimbangkan pasang ulang sesudah draf aman; login ulang mungkin diperlukan. Tidak ada jaminan waktu pembaruan ikon.

Dokumen `.5` terdahulu bersifat historis; kontrak PDF standalone kini digantikan dialog dua langkah di rilis ini.
