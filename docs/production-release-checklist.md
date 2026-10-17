# Checklist tinjauan dan rilis produksi Pangsuma

**Dokumen historis:** checklist ini mencatat rilis awal backend password, yang sudah dideploy dan di-bootstrap. Jangan ulangi bootstrap atau ikuti langkah password di bawah untuk rilis sekarang. Rilis Manager-only passkey mengikuti `docs/passkey-auth-operations.md`.

**Status rilis passkey:** disetujui pemilik; menunggu deployment terpisah. Tidak ada perubahan DNS/domain.

## Tinjauan lokal

Target tinjauan adalah perubahan lokal pada branch `feat/cloudflare-d1-operational-backend`, berbasis commit `3cdfe52`. Perubahan belum di-commit atau di-push. Setelah pemilik menyetujui diff dan preview yang sama, commit rilis harus dibuat dari diff tersebut; deployment hanya boleh dimulai dari `main`.

Preview di bawah memakai D1 lokal dan fixture pengujian, bukan data produksi. Pemberitahuan **Tahap uji** tetap ditampilkan.

- [Ringkasan Manager, mobile 390 px](/tmp/pangsuma-manager-overview-mobile.png)
- [Daftar akun Manager, mobile 390 px](/tmp/pangsuma-manager-users-mobile.png)
- [Finance, mobile 320 px](/tmp/pangsuma-finance-mobile.png)
- [Laporan User, mobile 320 px](/tmp/pangsuma-user-reports-mobile.png)
- [Preloader, mobile](/tmp/pangsuma-preloader-mobile.png)

## Hasil verifikasi terakhir (lokal)

- Full Playwright E2E lulus pada Pages Functions + D1 lokal bersih, termasuk login/password paksa, role dan isolasi data, throttling per akun/IP serta pruning, logout fail-closed, konflik idempotensi, pagination histori lengkap dan CSV streaming, persetujuan/debit petty-cash, Finance/audit, serta deaktivasi akun.
- Pemeriksaan UI lulus pada lebar 320, 390, 768, 1024, dan 1440 CSS px, serta landscape 844 × 390. Regression test memastikan navigasi dari posisi scroll lama membawa judul halaman baru ke tampilan.
- Bundle Pages Functions berhasil dikompilasi dengan Wrangler `4.151.1` dan `wrangler.toml`. Pemeriksaan sintaks JS, kompilasi Python E2E, `git diff --check`, serta pemindaian workflow tanpa request mutasi domain juga lulus.
- Semua fixture E2E, database uji, ekspor, dan screenshot disimpan lokal di `/tmp`; tidak ada data produksi yang dipakai.

## Keputusan yang sudah ditetapkan

- Gunakan Pages Functions + D1; **jangan** memakai Supabase.
- Gunakan roster yang sudah disetujui: Rahmat Saputro sebagai Manager dan sembilan User. Email/format alamat hanya ID login; jangan mengasumsikan kotak surat berfungsi. Tidak ada OTP email.
- Setelah bootstrap, Manager menetapkan password sementara yang **berbeda** untuk tiap User di aplikasi, membagikannya secara privat satu per satu, dan setiap User wajib menggantinya saat login pertama.
- Saldo awal petty cash tetap **Rp0**. Jangan mengisi atau menyetelnya sampai pemilik memberikan angka aktual.
- Jangan impor `localStorage` atau data demo ke produksi.

## Gerbang persetujuan

Sebelum tindakan produksi apa pun, pemilik harus menyetujui diff branch lokal, preview, serta urutan rilis dalam dokumen ini. Persetujuan ini belum diberikan. Sampai itu terjadi, jangan push ke `main`, menjalankan `workflow_dispatch`, membuat secret Cloudflare, menjalankan migrasi remote, bootstrap roster, atau menghapus pemberitahuan **Tahap uji**.

Masukan pemilik yang masih dibutuhkan hanya persetujuan rilis setelah tinjauan. Angka saldo awal tidak dibutuhkan untuk rilis pertama dan tetap nol. Alur password sementara User sudah disetujui; password awal Manager tersedia di penyimpanan rahasia terpisah dan tidak dicantumkan di dokumen ini.

## Checklist produksi setelah persetujuan

### 1. Read-only preflight

- Pastikan targetnya proyek Pages `pangsuma-app`, branch produksi `main`, serta D1 `pangsuma-app-prod` dengan ID `be808421-88ce-4a48-9dcd-eb0f39ae0314` di APAC.
- Pastikan secret GitHub Actions `CLOUDFLARE_API_TOKEN` tersedia dan memiliki izin yang dibutuhkan untuk Pages. Nilainya tidak boleh masuk log.
- Pastikan domain `app.pangsumafc.com` **sudah** terpasang. Workflow melakukan GET/read-only sebelum upload; bila domain tidak ditemukan atau pemeriksaan gagal, job berhenti. Workflow tidak membuat domain atau mengubah DNS. Status domain tidak diperiksa dalam tugas ini; bila perlu penambahan domain, hentikan rilis dan minta persetujuan terpisah.
- Lihat status migrasi remote tanpa menerapkan perubahan:

  ```sh
  npx wrangler d1 migrations list pangsuma-app-prod --remote --config=wrangler.toml
  ```

### 2. Siapkan binding dan secret hanya pada rilis yang disetujui

- Pastikan deployment memakai `wrangler.toml` yang menunjuk ke ID D1 di atas.
- Di pengaturan Pages untuk **Production** saja, tambahkan secret `BOOTSTRAP_TOKEN` dengan nilai acak berentropi tinggi. Jangan simpan nilainya di repo, commit, dokumen, atau log. Secret belum dibuat dalam tugas ini.
- Jangan pernah mencantumkan password Manager pada source code atau perintah yang akan masuk shell history/log; masukkan hanya pada request bootstrap aman di bawah.

### 3. Terapkan skema D1 remote

Setelah preflight dan persetujuan, jalankan satu migrasi yang ada ke database yang telah ditentukan:

```sh
npx wrangler d1 migrations apply pangsuma-app-prod --remote --config=wrangler.toml
```

Sesudahnya, pastikan migrasi tercatat dan tabel roster masih kosong sebelum bootstrap. Jangan mengimpor data browser/localStorage atau sample.

### 4. Deploy dari `main`

Push/merge yang disetujui ke `main` akan memicu GitHub Actions. Workflow yang disiapkan:

- hanya menjalankan job saat `github.ref` adalah `refs/heads/main`, termasuk pemicu manual;
- memeriksa domain yang sudah terpasang **sebelum** upload dan tidak melakukan POST untuk menambah domain;
- memakai Wrangler `4.151.1`, `wrangler.toml`, Pages Functions di direktori root, serta D1 binding yang disetujui.

Perintah deploy yang dicantumkan workflow (jangan dijalankan manual sebelum persetujuan):

```sh
npx --yes wrangler@4.151.1 pages deploy site --project-name=pangsuma-app --branch=main
```

Pastikan job berhasil dan gunakan URL produksi `https://app.pangsumafc.com`. Jangan memulai bootstrap bila deployment atau pemeriksaan API gagal.

### 5. Bootstrap satu kali

Kirim request ini sekali setelah HTTPS, API, D1 migration, dan secret siap. Header `Authorization` memakai token yang sama dengan secret Production; password Manager dimasukkan dari penyimpanan rahasia melalui jalur aman, bukan ditulis di dokumen atau log.

```http
POST /api/bootstrap HTTP/1.1
Host: app.pangsumafc.com
Origin: https://app.pangsumafc.com
Authorization: Bearer <BOOTSTRAP_TOKEN>
Content-Type: application/json

{
  "managerPassword": "<password Manager dari penyimpanan rahasia, diisi aman saat request>"
}
```

Endpoint bootstrap hanya menerima request same-origin dan hanya dapat berhasil ketika tabel pengguna masih kosong. Hasil yang diharapkan: HTTP `201`, `seededUsers: 10`, `usersNeedingPassword: 9`. Token tidak berada di body JSON. Bila hasil request ambigu atau koneksi terputus, **jangan kirim ulang**; periksa jumlah akun dan audit D1 secara read-only terlebih dahulu. Jangan mengirim atau mencatat password di chat, dokumen, commit, atau log.

### 6. Verifikasi tanpa membuat transaksi uji

- Masuk sebagai Manager dengan ID login Rahmat dan password awal yang tersimpan aman.
- Pastikan roster berjumlah 10: satu Manager dan sembilan User; role Manager/User sesuai; tidak ada sample atau riwayat lokal yang terimpor.
- Pastikan saldo petty cash tetap Rp0. Jangan mengirim transaksi uji atau menetapkan saldo awal pada produksi.
- Di aplikasi Manager, atur password sementara unik untuk masing-masing User dan bagikan privat satu per satu. Tiap User harus mengganti password pada login pertama; jangan mengandalkan email.
- Verifikasi sesi dan role melalui penggunaan baca-saja. Jalur tulis, persetujuan, debit saldo, audit, pagination, CSV lengkap, logout, idempotensi, dan pembatasan login telah diuji pada D1 lokal; jangan membuat data operasional palsu untuk menguji ulang di produksi.
- Pertahankan pemberitahuan **Tahap uji** sampai autentikasi dan persistence produksi terbukti bekerja. Hapus disclosure hanya dalam perubahan yang juga sudah disetujui pemilik.

## Jika rilis berhenti atau gagal

- Jika domain tidak terpasang, workflow berhenti sebelum upload. Jangan mengubah DNS atau menambahkan domain tanpa persetujuan terpisah.
- Jika migrasi gagal, jangan deploy kode yang memerlukan skema tersebut dan jangan bootstrap.
- Jika deploy gagal sebelum bootstrap, jangan seed pengguna. Migrasi aditif dapat dibiarkan; jangan mencoba menghapus tabel produksi secara manual.
- Jika bootstrap berhasil, jangan mengulangnya. Pertahankan audit dan data, lalu perbaiki dengan prosedur yang ditinjau; jangan menghapus atau mengganti akun produksi secara otomatis.

## Rujukan resmi Cloudflare

- [Cloudflare Pages Functions: direktori `functions` harus berada di root proyek](https://developers.cloudflare.com/pages/functions/get-started/)
- [Wrangler configuration untuk Pages dan D1 bindings](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)
- [Wrangler Pages deploy dan secret commands](https://developers.cloudflare.com/workers/wrangler/commands/pages/)
- [Migrasi D1](https://developers.cloudflare.com/d1/reference/migrations/)
