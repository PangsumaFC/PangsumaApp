# Pangsuma App

## Produksi

Aplikasi memakai Cloudflare Pages Functions dan Cloudflare D1 di `https://app.pangsumafc.com`. Pemilik telah menyetujui rilis produksi dan pengaturan langsung sepuluh akun yang sudah ada. Tidak ada Supabase, email verifikasi, OTP, atau mailbox yang dibutuhkan untuk login. Passkey tetap nonaktif.

Database `pangsuma-app-prod` (`be808421-88ce-4a48-9dcd-eb0f39ae0314`) menyimpan roster, sesi, pengajuan, audit, dan ledger. Jangan menjalankan bootstrap ulang pada produksi. Saldo pembuka dan saldo petty cash tetap Rp0 sampai pemilik memberikan angka aktual; perubahan autentikasi tidak boleh mengubah kas atau transaksi.

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

Suite lama `tests/e2e_local.py` dan dokumentasi checklist rilis awal memuat contoh kontrak password sebelumnya. Jangan gunakan contoh payload plaintext tersebut untuk autentikasi baru; gunakan kontrak di atas. Semua pengujian D1 harus memakai `--local`, bukan `--remote`.

## Integritas keuangan

Persetujuan petty cash mengurangi saldo dalam operasi database yang sama dengan ledger. Trigger menolak saldo tidak cukup dan debit ganda. Kunci idempotensi terikat pada fingerprint pengajuan. Saldo awal hanya dapat dimasukkan sekali setelah nominal aktual disetujui pemilik. Ledger dan audit tidak dapat diubah atau dihapus melalui API. Riwayat memakai cursor dan ekspor CSV Manager mencakup seluruh data, dengan penetralan sel formula.
