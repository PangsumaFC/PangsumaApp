# Pangsuma App

## Status rilis

Backend Cloudflare Pages Functions dan Cloudflare D1, autentikasi password, serta antarmuka operasional berbasis peran sudah diimplementasikan dan lulus pengujian E2E lokal. Perubahan masih berada di branch `feat/cloudflare-d1-operational-backend`; belum didorong ke `main` dan belum diterbitkan. Produksi tetap pada rilis sebelumnya sampai pemilik menyetujui tinjauan dan proses rilis.

Label dan pemberitahuan **Tahap uji** sengaja dipertahankan. Jangan masukkan data operasional nyata atau memakai laporan untuk keperluan resmi sebelum rilis produksi disetujui dan diverifikasi.

Pekerjaan ini tidak menjalankan migrasi remote, membuat akun produksi, mengimpor data `localStorage`, mengubah DNS, atau memakai Supabase.

Workflow `.github/workflows/deploy.yml` berjalan saat push ke `main`; pemicu manual hanya bekerja pada ref `main`. Sebelum upload, workflow memeriksa domain yang sudah terpasang secara read-only dan gagal alih-alih menambah atau mengubah domain. Deploy memakai Wrangler `4.151.1` dan `wrangler.toml`. Tidak ada workflow yang dijalankan; `main`, produksi, dan DNS tetap tidak berubah.

## Komponen

- `site/` berisi PWA dan antarmuka responsif. Preloader crest Pangsuma tampil selama pemulihan sesi, mengikuti contoh pemilik, dan mematikan animasi jika perangkat meminta reduced motion. Data akun serta transaksi dibaca dan ditulis melalui API same-origin.
- `functions/` berisi API Pages Functions, middleware keamanan, autentikasi, dan roster bootstrap yang disetujui.
- `migrations/0001_initial.sql` membuat tabel akun, sesi, laporan, saldo operasional, ledger append-only, audit, dan aturan status.
- `tests/e2e_local.py` menjalankan alur browser dan API pada Pages Functions serta D1 lokal.

Binding D1 memakai database `pangsuma-app-prod` dengan ID `be808421-88ce-4a48-9dcd-eb0f39ae0314`. Migrasi pada database tersebut belum dijalankan.

## Aturan akses dan pencatatan

Akun masuk memakai password, bukan email OTP. Password disimpan sebagai hash PBKDF2 dan sesi memakai cookie `HttpOnly`, `Secure`, dan `SameSite=Strict`. Login dibatasi per akun dan per alamat IP; tabel percobaan lama dibersihkan dan jumlah record dibatasi. Role Manager dan User diperiksa pada server. User hanya dapat melihat pengajuannya sendiri; keputusan, perubahan password, dan administrasi akun dibatasi di server. Logout hanya menampilkan keadaan keluar setelah server mengonfirmasi penghapusan sesi; respons sesi berakhir menutup dialog dan mengosongkan data/form sensitif.

Bootstrap satu kali membuat roster 10 orang yang disetujui: Rahmat Saputro sebagai Manager dan sembilan User. ID yang tampak seperti alamat email hanya dipakai sebagai ID masuk, bukan bukti bahwa kotak suratnya dapat menerima pesan. Aplikasi tidak mengirim email. Manager mengatur password sementara yang berbeda untuk setiap User melalui aplikasi, lalu menyampaikannya secara pribadi satu per satu; tiap User wajib menggantinya saat login pertama.

Saldo petty cash dimulai dari nol. Persetujuan petty cash mengurangi saldo dalam operasi database yang sama dengan pencatatan debit ledger; permintaan yang sama tidak dapat mendebit dua kali, dan saldo tidak cukup menolak persetujuan. Kunci idempotensi pengajuan terikat pada fingerprint isi, sehingga retry identik aman dan penggunaan ulang dengan isi berbeda ditolak. Saldo awal hanya dapat dimasukkan sekali oleh Manager setelah pemilik mengonfirmasi angka aktual. Ledger dan audit tidak dapat diubah atau dihapus melalui API aplikasi.

Endpoint riwayat memakai cursor dan menampilkan total serta tombol muat-halaman berikutnya. Ekspor Manager menghasilkan satu CSV server-side berisi seluruh pengajuan, ledger, dan audit, bukan hanya item yang sudah dimuat di layar. CSV dibuat bertahap melalui query terurut dan menetralkan sel formula.

## Uji lokal

Gunakan Node.js, Wrangler 4, Python dengan paket Playwright, Chromium di `/usr/bin/chromium`, dan enam nilai lokal untuk fixture E2E. Simpan nilai tersebut di `.dev.vars`, yang diabaikan Git. Gunakan token bootstrap acak minimal 32 karakter dan password uji yang unik, 12 sampai 128 karakter. Jangan menyalin password produksi ke lingkungan uji.

Nama variabel lokal yang dibaca tes:

- `BOOTSTRAP_TOKEN`
- `LOCAL_MANAGER_PASSWORD`
- `LOCAL_USER_TEMP_PASSWORD`
- `LOCAL_USER_NEW_PASSWORD`
- `LOCAL_SECOND_TEMP_PASSWORD`
- `LOCAL_SECOND_NEW_PASSWORD`

Jalankan migrasi hanya pada state lokal yang baru. Pilih direktori state yang berbeda untuk tiap run E2E karena tes membuat roster dan data fixture:

```sh
STATE_DIR=/tmp/pangsuma-d1-local-run
mkdir -p "$STATE_DIR"
CI=1 npx wrangler d1 migrations apply pangsuma-app-prod --local --persist-to "$STATE_DIR"
```

Di terminal pertama, jalankan Pages Functions dengan D1 lokal:

```sh
npx wrangler pages dev site --port 8788 --persist-to "$STATE_DIR" --ip 127.0.0.1
```

Di terminal kedua, jalankan tes:

```sh
PANGSUMA_LOCAL_STATE_DIR=/tmp/pangsuma-d1-local-run python3 tests/e2e_local.py
```

`PANGSUMA_LOCAL_URL` dapat diatur bila alamat lokal berbeda; default-nya `http://localhost:8788`. Path pada `PANGSUMA_LOCAL_STATE_DIR` harus sama dengan `--persist-to` server lokal; tes memakai Wrangler dengan flag `--local` secara eksplisit untuk memeriksa pruning limiter. Tes memeriksa preloader saat request sesi tertunda dan reduced motion, bootstrap, password dan role, isolasi data, persetujuan dan debit petty cash, penolakan, Finance, audit, logout gagal dan 401 pada dialog, replay idempotensi berbeda, throttling per akun/IP, pembersihan dan batas record login, halaman riwayat yang melampaui 500/100 record, CSV lengkap, penonaktifan akun tanpa menghapus riwayat, navigasi keyboard, serta overflow pada beberapa lebar dan orientasi landscape. Screenshot dan ekspor tes disimpan di `/tmp`.

Jangan menambahkan `--remote` pada perintah migrasi atau pengujian lokal.

## Syarat sebelum aktivasi produksi

Jangan push ke `main`, deploy, memigrasikan database produksi, membuat secret Cloudflare, menjalankan bootstrap, atau menghapus pemberitahuan **Tahap uji** sebelum pemilik menyetujui tinjauan akhir kode, preview lokal, dan checklist rilis di `docs/production-release-checklist.md`.

Angka saldo pembuka tidak diperlukan untuk rilis awal: petty cash tetap Rp0. Jangan menetapkan saldo awal sampai pemilik memberikan jumlah aktual. Setelah persetujuan, password awal Manager yang sudah disimpan terpisah hanya boleh dipakai pada bootstrap aman; jangan masukkan ke source, commit, atau log. Manager mengatur sembilan password sementara unik dan menyampaikannya secara pribadi satu per satu. Minta setiap User mengganti password saat login pertama.

Migrasi remote dan secret `BOOTSTRAP_TOKEN` tetap merupakan langkah produksi yang harus menunggu persetujuan pemilik. Jika domain `app.pangsumafc.com` belum terpasang pada proyek Pages, workflow yang diperbarui akan berhenti dan meminta keputusan terpisah; workflow tidak akan menambahkan domain atau mengubah DNS. Pemberitahuan **Tahap uji** hanya boleh dihapus setelah rilis disetujui dan autentikasi serta persistence terverifikasi pada produksi.
