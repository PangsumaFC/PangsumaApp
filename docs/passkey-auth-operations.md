# Operasional passkey Pangsuma

**Arsip prosedur rollout, tidak aktif:** branch saat ini memakai `PASSKEY_AUTH_ENABLED=false` pada default dan production. Persetujuan serta rencana pada bagian berikut berasal dari tahap passkey terdahulu, bukan izin menjalankan prosedur ini sekarang. Jangan membuat secret enrollment, mengaktifkan passkey, atau mengirim token berdasarkan arsip ini. Ikuti [status kesiapan rilis](release-status.md) untuk pekerjaan aktif.

## Status dan batas perubahan

**Jalur Manager lulus E2E lokal; rollout passkey Manager disetujui tetapi produksi belum diaktifkan.** Blocker enrollment diperbaiki: D1 menghitung efek trigger dalam `meta.changes`, sehingga pengecekan `=== 1` keliru menolak insert yang berhasil. Recovery memakai `INSERT ... RETURNING credential_id`. Tes `bash tests/run-local.sh --manager-only` lulus untuk reissue grant kedaluwarsa yang belum dikonsumsi, penolakan challenge generasi lama, grant aktif tidak diperpanjang, penolakan grant consumed/kredensial yang sudah ada, identitas/role/status Manager, enrollment UI tanpa sesi/roster, discoverable login, logout/login ulang, origin/RP/signature/UP/UV/backup/challenge/replay dan throttling. Tes unit membuktikan endpoint undangan/backup-key 404 tanpa akses DB, default-off, dan kill switch. Log: `/workspace/PangsumaApp-manager-blockers-test-20261017.log`. Undangan, onboarding sembilan User, dan passkey cadangan ditutup untuk tahap ini.

Implementasi ini berada pada branch lokal `feature/workers-free-passkeys-20261017`, berbasis commit produksi `52251137af20668869818cf85d167e60e7cc6420`. Belum ada perubahan live pada `main`, APK, domain, secret, akun, saldo, ledger, atau D1 produksi. Branch ini mengaktifkan `PASSKEY_AUTH_ENABLED` hanya di `[env.production.vars]`; top-level/preview tetap `false`. Banner **Tahap uji** tetap ada sampai produksi terverifikasi.

Migrasi `0002_passkey_auth.sql` bersifat aditif. Fitur memakai Pages Functions dan D1, tanpa Supabase atau peningkatan paket. Pengujian pada branch ini, bila lulus, hanya membuktikan perilaku lokal dengan fixture sintetis. Pengujian preview Workers Free yang pernah dilakukan sebelumnya memakai resource terisolasi yang kini telah dihapus; hasil itu bukan verifikasi produksi.

## Gerbang sebelum rollout

Owner telah menyetujui rollout Manager-only. Langkah berikut belum dilakukan: siapkan secret enrollment production, terapkan migrasi, deploy dari `main`, lalu kirim token ke Rahmat untuk enrollment. Backup privat D1 sudah dibuat; tidak ada bootstrap ulang.

### 1. Manager yang dipatok untuk recovery

ID Rahmat dibuat sebagai UUID acak saat bootstrap, jadi alamat login saja bukan pengikat yang cukup. UUID Manager sudah dibaca secara read-only setelah persetujuan rollout dan dipatok pada konfigurasi Production yang ditinjau. Bila akun dibootstrap ulang pada lingkungan baru, jalankan query read-only berikut dan pastikan hasilnya tepat satu baris aktif dengan role `manager`:

```sh
npx wrangler d1 execute pangsuma-app-prod --remote --config=wrangler.toml \
  --command "SELECT id, email, role, is_active FROM users WHERE email='rahmat@pangsumafc.com' COLLATE NOCASE;"
```

Pastikan nilai `id` sama persis dengan `PASSKEY_MANAGER_ID`; aplikasi menolak recovery bila UUID, email, role, atau status aktif tidak cocok.

### 2. Siapkan secret Production

Di environment **Production** proyek Pages `pangsuma-app` saja:

- Tetapkan `PASSKEY_MANAGER_ID` sebagai secret Production ke UUID Manager yang dibaca dari D1. ID ini bukan password, tetapi disimpan di luar repo.
- Tetapkan secret `MANAGER_ENROLLMENT_SECRET` ke token acak berentropi tinggi, minimal 32 karakter. Secret ini hanya untuk environment Production dan akan dihapus setelah Rahmat login; jangan taruh nilainya di Git, chat, atau log.
- Pertahankan `WEBAUTHN_ORIGIN=https://app.pangsumafc.com` dan `WEBAUTHN_RP_ID=app.pangsumafc.com`; top-level/preview tetap menonaktifkan passkey.

Verifikasi sebelum deploy bahwa nilai `PASSKEY_MANAGER_ID` sama dengan satu akun Manager aktif di D1. Recovery gagal tertutup bila secret hilang, ID tidak cocok, atau origin salah.

### 3. Migrasikan, deploy, lalu aktifkan secara terpisah

Setelah backup D1 tersedia, periksa status migrasi lalu terapkan migrasi yang belum tercatat:

```sh
npx wrangler d1 migrations list pangsuma-app-prod --remote --config=wrangler.toml
npx wrangler d1 migrations apply pangsuma-app-prod --remote --config=wrangler.toml
```

Rilis hanya dari `main` melalui workflow produksi yang sudah ada, setelah perubahan branch ini ditinjau dan disetujui. Konfigurasi `[env.production.vars]` pada commit rilis mengaktifkan passkey; top-level/preview tetap `false`. Secret recovery hanya boleh berada pada environment Production. Jangan mengaktifkan flag pada preview/staging dengan data produksi.

### 4. Enroll Manager tanpa memberi sesi recovery

Setelah konfigurasi aktif, Rahmat membuka halaman login Pangsuma lewat HTTPS, memperluas **Aktivasi awal akun Manager**, memasukkan secret satu kali, lalu mendaftarkan passkey. Server menyimpan hash secret dan grant yang kedaluwarsa dalam 15 menit; challenge berlaku 2 menit dan hanya dapat dipakai sekali.

Pendaftaran ini **tidak** membuat cookie sesi, tidak mengembalikan profil Manager, dan tidak membuka roster, saldo, atau API aplikasi. Sesudah konfirmasi pendaftaran, Rahmat harus memilih **Masuk dengan passkey** untuk membuat sesi Manager normal.

Jika grant awal kedaluwarsa sebelum pendaftaran selesai, ulangi aktivasi dengan secret yang masih dikonfigurasi oleh owner. Server hanya menerbitkan ulang grant yang sudah kedaluwarsa, belum dikonsumsi, dan akun Manager belum memiliki kredensial. Grant aktif tidak diperpanjang; grant yang sudah dikonsumsi tidak dibuka kembali. Challenge dari generasi grant lama ditolak setelah reissue. Secret tetap diverifikasi terhadap konfigurasi aktif, identitas Manager tetap dipatok, dan rate limit serta pemeriksaan origin tetap berlaku. Ini bukan jalur pemulihan untuk kehilangan passkey yang sudah terdaftar.

### 5. Ditunda: undangan User dan passkey cadangan

Sesuai arahan pemilik, tahap ini hanya enrollment dan login Rahmat sebagai Manager. Pemilik akan mengatur akun User belakangan. Jangan menghapus atau mengubah sembilan akun produksi yang ada. Endpoint penerbitan undangan, enrollment undangan, dan penambahan passkey Manager mengembalikan 404, termasuk untuk sesi Manager yang masuk dengan passkey. Form, dialog, dan tombol terkait dihapus dari UI. Handler tertunda tetap tidak terjangkau dan belum disertifikasi; jangan mengaktifkannya tanpa perbaikan serta pengujian terpisah. Pengelolaan User lewat tambah akun, atur password, dan nonaktifkan akses tetap tersedia seperti sebelumnya.

Setelah enrollment awal Manager dan login normal terverifikasi pada rollout yang disetujui, hapus secret `MANAGER_ENROLLMENT_SECRET` dari environment Production. Grant awal tetap sudah dikonsumsi. Pemulihan setelah seluruh passkey Manager hilang memerlukan prosedur insiden dan persetujuan owner tersendiri; jangan menghapus baris recovery atau kredensial secara ad hoc.

## Kill switch dan rollback

Untuk menghentikan endpoint serta UI passkey, set `PASSKEY_AUTH_ENABLED=false` dan rilis konfigurasi yang disetujui. Migrasi dan credential tetap disimpan; jangan menghapus tabel atau akun sebagai langkah rollback.

Cookie passkey yang sudah terbit tetap berlaku sampai kedaluwarsa (maksimal 8 jam). Bila owner perlu membatalkan semua sesi passkey segera, tindakan D1 berikut akan mencabut sesi tersebut dan memerlukan persetujuan tersendiri:

```sh
npx wrangler d1 execute pangsuma-app-prod --remote --config=wrangler.toml \
  --command "DELETE FROM sessions WHERE auth_method='passkey';"
```

Laporan tugas menyebut login password produksi saat ini masih gagal. Karena itu, menonaktifkan passkey setelah onboarding dapat mengunci pengguna dari aplikasi. Pastikan owner memiliki jalur pemulihan yang diuji sebelum memakai kill switch; jangan menjalankan perintah pembatalan sesi secara otomatis.

## Bukti dan batas klaim

- Suite lokal menggunakan database D1 Wrangler terpisah, origin localhost dinamis, akun sintetis, dan virtual authenticator Chromium. Tidak ada request pengujian yang diarahkan ke D1 atau domain produksi.
- Pengukuran CPU 1–5 ms berasal dari preview Workers Free terisolasi yang pernah diuji sebelumnya, bukan dari branch ini atau deployment produksi.
- Jangan hapus banner **Tahap uji** sampai pemilik menyetujui rilis dan autentikasi serta persistence produksi diverifikasi dengan prosedur baca-saja.
