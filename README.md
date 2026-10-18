# Pangsuma App

Status branch, hasil verifikasi, dan batas tindakan produksi terbaru ada di [Status kesiapan rilis](docs/release-status.md). Dokumen passkey dan checklist rilis awal adalah arsip, bukan instruksi rilis aktif.

## Produksi

Aplikasi memakai Cloudflare Pages Functions dan Cloudflare D1 di `https://app.pangsumafc.com`. Pemilik telah menyetujui rilis produksi dan pengaturan langsung sepuluh akun yang sudah ada. Tidak ada Supabase, email verifikasi, OTP, atau mailbox yang dibutuhkan untuk login. Passkey tetap nonaktif.

Database `pangsuma-app-prod` (`be808421-88ce-4a48-9dcd-eb0f39ae0314`) menyimpan roster, sesi, pengajuan, audit, dan ledger. Jangan menjalankan bootstrap ulang pada produksi. Saldo dan transaksi harus berasal dari data aktual yang disahkan pemilik; perubahan autentikasi tidak boleh mengubah kas atau transaksi.

Workflow `.github/workflows/deploy.yml` berjalan pada push ke `main`, memeriksa domain yang sudah terpasang secara read-only, dan memakai Wrangler `4.151.1`. Workflow tidak menambah domain atau mengubah DNS.

## Password dan akses

Pemilik memilih password awal bersama untuk sepuluh akun. Nilainya tidak disimpan dalam source, test, atau dokumentasi. Setiap akun, termasuk Manager, wajib mengganti password tersebut saat masuk pertama kali. Jabatan berbeda dari role aplikasi: hanya Rahmat Saputro menjadi `manager`; sembilan orang lain, termasuk COO, menjadi `user`. Roster dan ID login ada di `functions/_lib/roster.js`.

Browser menjalankan PBKDF2-HMAC-SHA-256 sebanyak 600.000 iterasi dengan salt acak 16 byte. Server menyimpan HMAC-SHA-256 dari hasil derivasi yang diikat ke versi protokol, ID login, jumlah iterasi, dan salt. Secret `PASSWORD_PEPPER` harus berupa base64 kanonis dari 32 byte acak dan disimpan sebagai secret Pages, bukan di D1 atau Git. Tanpa pepper yang benar, autentikasi gagal tertutup. Jangan mengganti atau menghapus pepper tanpa rencana migrasi seluruh verifier.

Protokol ini menghindari batas PBKDF2 pada runtime produksi tanpa menurunkan jumlah iterasi. Nilai derived merupakan kredensial setara password: kirim hanya melalui HTTPS same-origin dan jangan catat payload autentikasi. Hash PBKDF2 lama tidak diterima pada jalur login aktif; migrasi akun yang sudah ada harus dilakukan secara eksplisit dengan otorisasi pemilik.

- `POST /api/auth/password-parameters`: `{email}`; menghasilkan `{version, iterations, salt}` dengan bentuk yang sama untuk akun dikenal dan tidak dikenal.
- `POST /api/auth/login` (alias `/api/login`): `{email, credential}`. `credential` berisi `{version: "client-pbkdf2-hmac-v1", iterations: 600000, salt, derived, passwordLength}`. Salt dan derived memakai base64 16 dan 32 byte.
- `POST /api/account/password`: `{currentCredential, newCredential, newCurrentDerived}`. Kredensial baru memakai salt baru; `newCurrentDerived` adalah string hasil derivasi password baru dengan salt lama untuk pemeriksaan password tidak berubah.
- `POST /api/users/:id/password`: `{credential}`; khusus Manager, menandai wajib ganti password dan membatalkan sesi target.
- Bootstrap lokal pada database kosong memakai `{managerCredential}` dan header bearer `BOOTSTRAP_TOKEN`; Manager juga wajib mengganti password. Endpoint ini tidak dipakai untuk memperbarui akun produksi.

Password baru berisi 12–128 karakter. Sesi memakai cookie `HttpOnly`, `Secure`, `SameSite=Strict` dengan masa aktif delapan jam. Login dibatasi per akun dan alamat IP. Backend melarang operasi terlindungi sebelum password awal diganti. Pengguna hanya dapat melihat pengajuannya sendiri; pengelolaan akun dan keputusan dibatasi pada Manager. Reset password membatalkan sesi target, sedangkan perubahan sendiri mempertahankan sesi saat ini dan membatalkan sesi lain.

## Komponen

- `site/`: PWA, helper WebCrypto, antarmuka berbasis role, dan service worker. API tidak masuk cache; versi cache harus dinaikkan saat kontrak autentikasi berubah.
- `functions/`: API Pages Functions, autentikasi, middleware keamanan, dan roster.
- `migrations/`: skema D1, trigger integritas, audit, dan ledger append-only.
- `tests/auth_client_protocol_unit.mjs`: pengujian protokol HMAC dan input cacat.
- `tests/run-password-local.sh` dan `tests/password_flow_e2e.py`: pengujian browser/API autentikasi dengan Pages Functions dan D1 lokal terisolasi.

## Uji lokal

Gunakan Node.js, Wrangler 4, Python dengan Playwright, dan Chromium. Pengujian password baru membuat state serta secret lokal sementara dan tidak menggunakan password atau D1 produksi.

```sh
node --test tests/auth_client_protocol_unit.mjs
bash tests/run-password-local.sh
```

Untuk pemeriksaan cepat seluruh unit JavaScript dan integritas migrasi tanpa server, browser, secret, atau koneksi D1:

```sh
npm ci --ignore-scripts
npm test
python3 -B tests/profile_schema_unit.py
```

Workflow `.github/workflows/test.yml` menjalankan kedua suite pada push branch selain `main` dan pada pull request. Workflow deploy `main` memanggil pemeriksaan yang sama sebagai prasyarat: jika tes gagal, job deploy tidak berjalan, termasuk pemeriksaan domain dan D1 remote. Job tes hanya memiliki izin baca source dan tidak menerima secret produksi. Tes ini tidak menggantikan E2E browser lokal atau gate migrasi produksi.

Probe migrasi deploy memeriksa kolom profil dari `0003_user_profiles.sql` serta `sessions.auth_method` dan `users.webauthn_user_handle` dari `0002_passkey_auth.sql`, termasuk saat passkey nonaktif. Query bersifat read-only dengan `LIMIT 0`: tabel kosong tetap diperiksa tanpa mengembalikan data akun atau sesi. Suite SQLite offline menjalankan query yang diambil langsung dari workflow untuk memastikan database dengan seluruh migrasi lolos, kolom/tabel yang direferensikan hilang atau parsial ditolak, dan data tidak berubah. Probe ini bukan verifikasi seluruh skema passkey, indeks, trigger, CHECK, atau catatan migrasi remote; passkey tetap nonaktif, dan aktivasi kelak memerlukan pemeriksaan serta pengujian tersendiri.

Suite `tests/e2e_local.py` sudah menggunakan kredensial protokol aktif; dokumentasi checklist rilis awal tetap merupakan arsip dan bukan contoh payload login aktif. Semua pengujian D1 harus memakai `--local`, bukan `--remote`.

## Integritas keuangan

Persetujuan petty cash mengurangi saldo dalam operasi database yang sama dengan ledger. Trigger menolak saldo tidak cukup dan debit ganda. Kunci idempotensi terikat pada fingerprint pengajuan. Saldo awal hanya dapat dimasukkan sekali setelah nominal aktual disetujui pemilik. Ledger dan audit tidak dapat diubah atau dihapus melalui API. Riwayat memakai cursor dan unduhan Manager sekarang berupa PDF korporat yang mencakup seluruh halaman data, bukan hanya 100 baris pertama: ringkasan saldo dan arus kas, periode, buku kas bersaldo berjalan, tabel pengajuan Petty Cash dan Request Finance User/Manager, lampiran audit, dan nomor halaman. Endpoint CSV lama tetap tersedia hanya untuk kompatibilitas, dengan penetralan sel formula.

PDF versi `2026.10.18.7` hanya memuat judul, periode/filter aktif, tanggal cetak WIB, Manager, ringkasan nominal, tabel berisi data, total tabel, dan nomor halaman. Tidak ada instruksi UI, promosi, penjelasan saldo generik, atau tabel kosong. Keterangan transaksi, catatan, alasan keputusan, status, referensi ledger, dan audit tetap disertakan. Peringatan font singkat hanya muncul jika ada karakter yang tidak terwakili. Tes `pdf_concise_content_unit.mjs` memeriksa teks PDF aktual, total, kelengkapan baris panjang, dan batas teks halaman melalui Poppler (`pdftotext`); CI memasang `poppler-utils` sebelum tes.

Versi web `2026.10.18.9` menghapus fallback Chrome dan salin tautan dari APK. Deteksi hanya memakai interface `PangsumaFileBridge` yang terbukti ada pada APK, bukan tebakan user-agent atau mode PWA. Tombol PDF hanya menampilkan “Unduh PDF langsung memerlukan APK yang diperbarui.” Tidak ada intent, clipboard, Blob, pemanggilan `saveCsv`, atau tautan unduh langsung di jalur APK. Halaman `/pdf-browser.html` lama juga menolak jalur APK. Unduhan browser/PWA biasa dipertahankan. APK dan unggah foto tidak diubah; direct PDF native tetap memerlukan pembaruan APK dan belum diuji di perangkat fisik. Lihat [jalur PWA dan APK](docs/pwa-file-regression.md).

Pengajuan baru milik Manager otomatis berstatus `approved` dalam transaksi pembuatan, tanpa keputusan manual, dan bergabung dengan pengajuan lain yang sudah disetujui. Pengajuan User tetap `pending` sampai diputuskan Manager. Petty cash Manager langsung mengurangi saldo dan menambah ledger satu kali; jika saldo tidak cukup, seluruh pembuatan dibatalkan (HTTP 409), bukan dibiarkan pending. Request Finance Manager langsung menunggu Finance dan tetap perlu ditandai terkirim. Riwayat `submission.created` dan perubahan status tetap tercatat; `resolved_by` kosong karena persetujuan bersifat otomatis. Perubahan ini tidak mengubah status pengajuan lama atau data produksi.

## Isi ulang Petty Cash dan paket dashboard

Manager dapat membuka **Tambah Petty Cash** dari Ringkasan atau Finance, mengisi nominal rupiah serta sumber/keterangan 3–500 karakter. Satu pencatatan atomik menambah saldo, ledger kredit, dan audit `cash.topup_created`. Kunci idempotensi terikat pada akun dan isi transaksi: respons jaringan yang hilang dapat dicoba ulang tanpa menambah saldo dua kali. Ledger menyimpan nama pencatat, hari/tanggal, jam hingga detik WIB, sumber dana, serta saldo setelah transaksi. Riwayat tetap memakai cursor.

**Migrasi `0005_cash_topups.sql` wajib disetujui secara spesifik sebelum diterapkan ke produksi.** Migrasi membangun ulang tabel ledger untuk menambah jenis `cash_topup`, menyalin semua baris/ID lama, dan memulihkan indeks serta trigger proteksi. Ia tidak mengisi saldo atau membuat transaksi contoh. Siapkan bookmark pemulihan D1 dan bandingkan jumlah baris, saldo, serta jejak audit sebelum/sesudah pada pelaksanaan yang disetujui. Workflow deploy hanya memeriksa skema secara read-only; tidak menjalankan 0005. API isi ulang mengembalikan `503 migration_required` jika tabel atau trigger yang dibutuhkan belum lengkap.

Dashboard Manager menonjolkan saldo, persamaan saldo awal + penambahan − pengeluaran = saldo hitung, status rekonsiliasi terhadap saldo akun, dan antrean tindakan. Dashboard User memiliki satu CTA utama serta timeline status aktual; waktu persetujuan tidak direka dari waktu pengiriman Finance. Avatar dashboard Manager membuka pengaturan profilnya sendiri; pengaturan User/tim tetap di bagian Pengguna melalui ikon header. Manifest `version.json` tidak dicache, pemberitahuan versi tidak memaksa reload, dan reload melindungi draf maupun transaksi aktif. Navigasi section lokal tidak menunggu refresh data jaringan.

Regresi tambahan lokal: `bash tests/run-profile-local.sh --cash-topup`, `--manager-design`, `--app-update`, `--navigation-loader`, `--dashboard-design`, dan `--mobile-download`. Semua runner membuat database sementara dan hanya memakai `--local`. Uji isi ulang mencakup respons hilang sesudah commit, retry aman, audit, hari/tanggal/WIB, dan PDF.

## Filter, detail aktivitas, dan draf aman

Halaman Finance menyediakan pencarian keterangan/catatan/pengaju, jenis, status, nama/email/ID pengaju, serta periode minggu ini, bulan ini, atau rentang khusus WIB. Daftar memakai endpoint Manager `/api/reports` dan paginasi server; tombol unduh serta tautan PDF memakai filter yang sudah **diterapkan**, bukan isian yang belum dikirim. Ekspor mengambil seluruh halaman data. Untuk filter pengajuan, saldo buku kas tetap saldo akun sebenarnya dengan label `Saldo akun awal/akhir`, `Masuk/Keluar terpilih`, dan `Buku Kas Terpilih (Saldo Akun)`, tanpa paragraf penjelasan statis. Saldo awal/akhir rentang tanggal diambil dari ledger konteks tanpa menyisipkan transaksi lama ke total periode. Tanggal pengajuan merupakan tanggal laporan; tanggal buku kas merupakan waktu pencatatan ledger WIB.

Detail pengajuan mengambil audit aktual melalui `/api/submissions/:id/activity`: pelaku, waktu WIB, perubahan status, dan alasan bila tercatat. Manager dapat melihat seluruh pengajuan; User hanya miliknya sendiri. Riwayat aktivitas memakai cursor dan tidak mengarang kejadian untuk data lama yang tidak memiliki audit. Dialog menjaga epoch/akun, menolak respons sesi lama, dan dibersihkan saat ditutup.

Draf pengajuan dan isi ulang disimpan di `sessionStorage`, terpisah menurut akun serta jenis formulir. Navigasi/reload dan kegagalan jaringan tidak membuang isian atau kunci idempotensi. Draf dihapus setelah server mengonfirmasi keberhasilan. Aplikasi tidak mengirim antrean transaksi otomatis saat koneksi pulih; pengguna menekan kirim ulang dengan kunci yang sama agar respons hilang tidak mendebit/mengkredit dua kali.

Analisis `/api/cash/insights` menjumlahkan seluruh ledger dengan integer presisi, bukan halaman riwayat yang sedang dimuat. Ledger harian memuat saldo awal/akhir aktual. Grafik memakai tepat 30 hari WIB sampai hari ini dan pembanding 30 hari sebelumnya; tanpa pengeluaran pembanding, aplikasi menampilkan “Belum ada pembanding”, bukan persentase fiktif. Batas minimum awalnya belum diatur kecuali konfigurasi server menyediakannya; preferensi Manager dapat disimpan **hanya pada perangkat ini** dan tidak menulis saldo/database. Kontrol memiliki label eksplisit, fokus keyboard terlihat, target sentuh minimal 44px, dan status berteks, tidak hanya warna. Sapaan serta seluruh waktu laporan konsisten WIB.

Jalankan `bash tests/run-profile-local.sh --financial-workspace` untuk menguji draf offline, respons pengiriman hilang setelah commit, retry tanpa debit ganda, filter daftar/PDF yang sama, audit, ambang lokal, grafik, dan tata letak 320/390px. Suite Node juga memakai SQLite termigrasi lokal untuk memeriksa otorisasi, cursor, ekspor >100 baris, seluruh ledger >500 baris, batas hari WIB, dan selisih rekonsiliasi. Semua data uji berada di database sementara; tidak membuat transaksi produksi.

## Paket kontrol keuangan 2026.10.18.4 (arsip)

Rekonsiliasi Manager mencatat saldo ledger historis untuk bulan yang sudah berakhir, hasil hitung fisik, selisih, catatan, pencatat, waktu WIB, serta audit immutable. Fitur ini **tidak mengoreksi saldo**, tidak mengunci bulan, dan tidak mengubah transaksi lama. Draf terpisah menurut akun dan retry isi yang sama memakai kunci idempotensi yang sama.

Foto nota JPEG/PNG disimpan privat, maksimal 10 per pengajuan dan 512 KiB per foto setelah normalisasi. Server memvalidasi isi, menghapus metadata, menolak berkas palsu/SVG, dan mengirim `private, no-store`. User hanya mengakses pengajuan sendiri; Manager dapat meninjau seluruh pengajuan. Pilihan foto bertahan saat retry/pagination audit; penutupan dialog/Escape dilindungi ketika foto belum diunggah atau sedang diproses.

Peringatan organisasi bersifat opt-in: ambang saldo dan usia pengajuan awalnya kosong. Perubahan Manager memakai versi optimistis, idempotensi, dan audit before–after. Laporan lewat batas usia ditampilkan tertua lebih dahulu. Deteksi duplikasi hanya memperingatkan kandidat mirip berdasarkan jenis, nominal, tanggal dekat, dan keperluan; tidak menolak pengajuan. Server memeriksa kandidat dalam batch terbatas, termasuk kandidat sesudah baris ke-500.

Laporan Manager memakai pencarian server dan cursor 25 baris per halaman. Riwayat User, ledger, serta audit hanya menyimpan satu halaman 100 baris dengan navigasi sebelum/berikutnya/terbaru; rekonsiliasi maksimal 20 baris. Saldo tiap baris tetap berasal dari ledger. Total arus kas serta status saldo awal menggunakan seluruh ledger, diuji hingga lebih dari 600 baris. PDF mengekspor semua hasil filter, bukan hanya halaman UI.

Lapisan mobile melindungi safe-area, gestur Android, orientasi, viewport keyboard, dialog, fokus, target sentuh, angka rupiah panjang, busy/disabled states, dan reduced motion. Pembaruan versi tetap eksplisit dengan guard draf/transaksi; menu lokal tidak menunggu fetch.

**Catatan historis rilis .4:** paket tersebut telah menjadi basis produksi pada `5b59991`. Rilis PWA/UI `.5` tidak menerapkan migrasi atau mengubah database. Workflow hanya memeriksa kolom dan 12 trigger baru secara read-only dan akan memblokir deploy jika skema belum lengkap. Workflow tidak menjalankan migrasi ini. Backup/bookmark serta verifikasi saldo, identitas/baris ledger, dan audit merupakan bagian prosedur migrasi terpisah yang harus disetujui. Pengujian hanya memakai database sementara `--local`, tanpa transaksi produksi.

Regresi tambahan: `bash tests/run-profile-local.sh --financial-controls` menguji rekonsiliasi, pengaturan, duplikasi non-blocking, nota privat, respons unggahan hilang/retry idempoten, pagination, PDF terfilter lengkap, dan viewport 320/390px, landscape, desktop. `npm test` mencakup unit, SQLite termigrasi, kontrol akses/CSRF, nominal aman, audit, cursor, dan berkas berbahaya. `bash tests/run-local.sh` mencakup operasi/passkey penuh; isolasi counter rate-limit hanya dilakukan pada fixture sementara, tanpa melonggarkan kebijakan aplikasi.

## Perbaikan PWA dan antarmuka 2026.10.18.5

Status aktif ada di [catatan rilis](docs/release-status.md). Foto memakai input native terlihat; unduhan standalone memakai attachment same-origin sinkron. [Kontrak PWA](docs/pwa-file-regression.md) menjelaskan batas bukti pengujian Android. Dashboard kini ringkas, setiap aksi punya lokasi utama, dan Finance memakai satu daftar hasil terfilter. Pilihan jenis laporan hanya di form; rincian saldo/tren dipusatkan pada disclosure Finance. Menu password hanya di header, bukan diulang pada navigasi User. Jalankan `./tests/run-pwa-local.sh` untuk regresi standalone terisolasi; simulasi Chromium tidak boleh disebut pengujian PWA Android terpasang.
