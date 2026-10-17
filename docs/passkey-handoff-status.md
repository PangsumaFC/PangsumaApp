# Pangsuma: enrollment dan login passkey Manager lulus lokal

**Arsip eksperimen passkey:** hasil, branch, path, dan persetujuan di dokumen ini bersifat historis. Konfigurasi branch aktif menonaktifkan passkey untuk default dan production; jangan menggunakan langkah produksi di bawah sebagai izin aktivasi. Rujukan terkini: [status kesiapan rilis](release-status.md).

## Hasil utama

E2E minimal Manager lulus menggunakan Chromium virtual authenticator dan D1 Wrangler lokal sintetis. Tidak ada deployment atau perubahan produksi. Sembilan User ditunda sesuai arahan pemilik dan bukan blocker tahap ini.

Branch: `feature/workers-free-passkeys-20261017`

Worktree: `/workspace/PangsumaApp-webauthn-worktree-20261017`

Base HEAD: `52251137af20668869818cf85d167e60e7cc6420`. Perubahan belum di-commit/push. Main, APK, DNS, D1/Secrets Cloudflare dan akun/data produksi belum diubah. Branch menyiapkan flag `PASSKEY_AUTH_ENABLED=true` khusus `[env.production.vars]`; top-level/preview tetap `false`. Website live belum berubah dan banner Tahap uji tetap ada.

## Blocker yang diperbaiki

Credential Manager sebenarnya berhasil tersimpan, tetapi endpoint recovery mengembalikan 401 karena D1 `meta.changes` menghitung trigger konsumsi recovery dan audit, bukan hanya satu insert. Pemeriksaan sukses kini memakai `INSERT ... RETURNING credential_id` dan mencocokkan ID yang dihasilkan. Pesan enrollment dipindahkan dari toast yang tersembunyi saat logout ke status inline `role=status` pada layar login.

## Bukti tes

Perintah: `bash tests/run-local.sh --manager-only`, dijalankan di bawah timeout 120 detik. Putaran terakhir selesai sukses dalam sekitar 22 detik, tanpa mengulang baseline atau tes User.

Log: `/workspace/PangsumaApp-manager-passkey-test.log`.

Lulus:
- Migrasi D1 lokal 0001 dan 0002, unit parser/flags/counter WebAuthn.
- Enrollment Manager melalui UI dan UUID sintetis yang dipin; secret salah ditolak, secret benar sekali pakai.
- Enrollment tidak menerbitkan sesi dan tidak membuka profil/roster; akses baru diperoleh melalui login passkey biasa.
- Discoverable Manager login melalui UI, identitas/role Manager, akses overview, cookie HttpOnly/SameSite Strict.
- Logout mencabut sesi dan login ulang bekerja.
- Penolakan origin salah, RP hash salah, signature salah, UP/UV hilang, backup flags tidak sah, challenge salah dan replay.
- Delapan signature gagal memicu throttling credential (429).

Baseline E2E aplikasi sebelumnya telah lulus dan tidak dijalankan ulang: role/isolation, password, ledger/idempotency, finance/CSV/audit, sesi dan responsive overflow. Hasil lokal bukan bukti login produksi atau CPU produksi. Sampel CPU preview terdahulu tetap bukti historis terpisah, bukan hasil branch ini.

## Batas keamanan dan fitur

Jalur recovery terikat UUID/email/role/aktif Manager; grant disimpan sebagai hash, singkat dan sekali pakai. Recovery tidak memberi sesi atau mengubah role/saldo. Produksi memakai origin/RP persis app.pangsumafc.com dan flag default off. Secure cookie produksi diperiksa lewat konfigurasi/source; pengujian localhost hanya membuktikan HttpOnly/SameSite dan sesi.

Gerbang fungsional/Antislop untuk jalur Manager: PASS berdasarkan UI enrollment/login dan security checks tersebut. Bukan sertifikasi menyeluruh atas semua jalur passkey. Jalur undangan User dan backup key masih memiliki pemeriksaan insert `meta.changes === 1`; jangan dipakai sebelum diperbaiki/diuji pada tahap berikutnya. Tidak ada akun User produksi yang dihapus atau diubah.

## File berubah

Backend: `functions/_lib/auth.js`, `functions/_lib/webauthn.js`, `functions/api/[[path]].js`.
Data/config: `migrations/0002_passkey_auth.sql`, `wrangler.toml`.
UI/PWA: `site/app.js`, `site/index.html`, `site/pangsuma-theme.css`, `site/sw.js`.
Tes: `tests/e2e_local.py`, `tests/webauthn_e2e.py`, `tests/manager_passkey_e2e.py`, `tests/webauthn_unit.mjs`, `tests/run-local.sh`, `tests/wrangler.local.toml`, `tests/.dev.vars.example`.
Dokumentasi: `docs/passkey-auth-operations.md`, `docs/passkey-handoff-status.md`.

## Langkah produksi belum dilakukan

Pemilik sudah menyetujui Manager-only rollout. Sebelum langkah produksi: tinjauan dan backup privat selesai/ditinjau, UUID Rahmat produksi dibaca read-only, dan deployment masih menunggu migrasi aditif, secret enrollment production sekali pakai, push/deploy dari `main`, enrollment Rahmat di domain sebenarnya, verifikasi login Manager lalu penghapusan secret. Onboarding sembilan User ditunda. Produksi belum dipulihkan.
