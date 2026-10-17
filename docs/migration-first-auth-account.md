# Rilis profil harus dimulai dari migrasi

Fitur profil hanya menambah tabel `user_profiles` melalui `0003_user_profiles.sql`. Nama akun, jabatan resmi (`users.position`), role, status akses, pengajuan, laporan, ledger, dan saldo tidak diubah oleh penyimpanan profil. `dashboard_position` adalah teks tampilan tersendiri.

## Pengaman yang tersedia

`ensureUserProfilesSchema(db)` di `functions/_lib/migration-guard.js` memeriksa keberadaan tabel profil sebelum query auth/account yang bergantung padanya. Dispatcher API menjalankannya sebelum seluruh rute selain logout; `getSessionUser()` juga memeriksanya untuk pemanggil di luar dispatcher. Hasilnya tidak di-cache.

Bila 0003 belum diterapkan, API dan health check mengembalikan HTTP 503 `migration_required`, bukan error SQL mentah atau 401 password salah. Server yang sama dapat pulih pada request berikutnya sesudah migrasi tersedia. Ini adalah pengaman fail-closed, bukan janji bahwa login tetap tersedia bila urutan rilis dilanggar.

File workflow `.github/workflows/deploy.yml` mensyaratkan job tes dari `.github/workflows/test.yml` lulus sebelum job deploy dimulai. Job tes menjalankan unit JavaScript dan regresi SQLite offline tanpa secret produksi. Tes yang gagal menghentikan seluruh job deploy, termasuk pemeriksaan domain dan D1 remote.

Setelah tes lulus, langkah **Require auth and profile migrations before deploy (read-only, no migrations)** memeriksa kolom profil dari 0003 serta `sessions.auth_method` dan `users.webauthn_user_handle` dari 0002. Query `SELECT ... LIMIT 0` tetap memeriksa tabel kosong tanpa mengembalikan data akun/sesi. Tabel/kolom hilang, akses D1 gagal, atau hasil tidak sukses menghentikan workflow. Workflow tidak menerapkan migrasi otomatis. Perluasan gate dan workflow tes masih lokal pada branch `chore/local-test-gate`, belum di-commit, di-push, atau dijalankan pada produksi; lihat [status rilis](release-status.md).

## Urutan aman untuk rilis yang kelak disetujui

1. Review diff dan jalankan pengujian lokal pada D1 sementara. Jangan memakai binding atau state produksi untuk pengujian.
2. Dengan aplikasi lama masih aktif, operator yang berwenang menerapkan migrasi hingga **0003** pada database target yang benar. Langkah ini memerlukan persetujuan rilis tersendiri.
3. Verifikasi secara read-only bahwa migrasi selesai, semua kolom tersedia, dan definisi `photo` memiliki CHECK panjang maksimal 131072 byte.
4. Setelah verifikasi berhasil, baru deploy backend dan app shell baru. Gate workflow harus tetap lulus sebelum deploy. Tidak boleh melewati gate melalui jalur deploy lain yang belum dilindungi.
5. Jika migrasi atau verifikasi gagal, jangan deploy. Jika rilis telanjur mengalami 503 `migration_required`, pulihkan versi aplikasi sebelumnya atau selesaikan migrasi yang telah disetujui. Jangan menghapus tabel atau data pengguna untuk menghindari guard.

Migrasi ini aditif sehingga kode lama tidak perlu membaca tabel baru. Rollback kode tidak membutuhkan penghapusan tabel profil. Jika 0003 pernah diterapkan sebelumnya dengan definisi berbeda, `CREATE TABLE IF NOT EXISTS` tidak memperbarui CHECK yang sudah ada; buat migrasi lanjutan yang direview, jangan menganggap mengedit file 0003 akan memperbaiki database tersebut.

## Konflik dua Manager

Editor mengambil profil terbaru melalui GET saat dibuka, bukan dari roster yang mungkin lama. PUT mewajibkan `profileVersion`. Server menulis dengan compare-and-swap atomik dalam batch D1; penyimpanan dari versi lama mendapat HTTP 409 `profile_conflict`. Audit dibuat hanya untuk penulisan yang benar-benar berhasil.

Saat konflik, draf tetap terlihat agar dapat disalin, tetapi Simpan dinonaktifkan. Tutup lalu buka editor untuk memuat versi terbaru sebelum mengedit ulang. Tidak ada retry otomatis yang menimpa hasil Manager lain.

## Pengujian lokal

`bash tests/run-profile-local.sh` menggunakan direktori `mktemp`, ID database dummy, port loopback acak, dan kredensial acak khusus tes. Runner menerapkan 0001/0002 terlebih dahulu, menguji 503 untuk health/login/session/overview/users/profile, baru menerapkan 0003 dengan `--local` dan memeriksa pemulihan di server yang sama. Selanjutnya browser headless menguji alur profil, konflik, upload, sinkronisasi, akses, dan keutuhan data.

Tes browser hanya mengizinkan origin loopback milik runner; HTTP helper menolak URL non-loopback dan redirect. Jangan mengganti runner ini dengan skrip pengujian yang menunjuk produksi.
