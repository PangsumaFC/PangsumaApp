# Kandidat rilis PDF dan kontrol keuangan

## Status saat ini

Kandidat disiapkan di branch `feat/corporate-pdf-controls-20261018`, berbasis `3315b04`. Branch produksi `main` masih berada pada commit tersebut saat diperiksa. Kandidat **belum di-deploy** dan tidak menjalankan migrasi atau transaksi produksi. Riwayat rilis CSV sebelumnya tetap tersedia dalam Git; instruksi lama bukan persetujuan untuk migrasi baru.

## Perubahan utama

Unduhan Manager menjadi PDF korporat: periode, ringkasan saldo/arus kas, buku kas bersaldo berjalan, pengajuan User/Manager terpisah menurut jenis, status, catatan lengkap, audit, header tabel berulang, dan nomor halaman. Tabel pengajuan memakai nomor urut, bukan UUID panjang yang menghabiskan ruang. Ekspor mencakup semua hasil filter, bukan halaman yang sedang terlihat. Endpoint CSV lama tetap ada hanya untuk kompatibilitas.

Dashboard Manager menonjolkan saldo, kesehatan kas, antrean, isi ulang atomik, riwayat terperinci WIB, ledger harian, dan tren 30 hari. User memiliki satu CTA utama, status/timeline berdasarkan data nyata, serta draf tahan offline/gagal kirim. Pemberitahuan versi tidak memaksa reload dan melindungi draf/transaksi aktif; navigasi lokal tidak menunggu jaringan.

Kontrol tambahan mencakup rekonsiliasi akhir bulan tanpa koreksi saldo, nota JPEG/PNG privat, pengaturan ambang organisasi opt-in dengan audit versi, daftar laporan melewati batas usia, dan deteksi duplikasi yang hanya memperingatkan. Riwayat serta pencarian memakai cursor dan jumlah baris UI terbatas. Detail akses nota, batas berkas, dan kontrak fitur ada di README.

Tampilan diuji pada 320/390px, landscape, dan desktop. Aksi Finance dibuat dua kolom di HP agar konten utama tidak tertutup tombol. Safe-area, viewport keyboard, dialog, fokus, target sentuh, disabled/busy states, dan reduced motion mendapat penjagaan tambahan. Emulasi browser bukan bukti kompatibilitas perangkat fisik tertentu.

## Validasi lokal

- Suite JavaScript/SQLite: **200 tes lulus**.
- SQLite profil: **9 tes lulus**.
- E2E kontrol keuangan: lulus untuk selisih rekonsiliasi tanpa perubahan saldo, pengaturan, duplikasi non-blocking, nota privat, respons unggahan hilang/retry dengan kunci sama, pagination 25 baris, seluruh 83 hasil filter di PDF, serta empat ukuran layar.
- Regresi operasional dan passkey penuh: **lulus**. Cakupan mencakup debit sekali, rollback, cursor tanpa duplikasi/gap, keputusan Finance, status, ekspor, audit, dan akun. Skenario request-budget passkey menggunakan reset counter fixture `--local` agar terpisah dari skenario signature/replay sebelumnya; kebijakan keamanan aplikasi tidak diturunkan.
- `git diff --check` dan sintaks workflow YAML: lulus.

Hasil lokal bukan bukti deployment. Status CI branch tetap harus lulus sebelum merge. Tidak ada klaim reproduksi pada perangkat fisik pengguna atau ekspor terautentikasi produksi.

## Prasyarat produksi yang belum disetujui

Migrasi `0005_cash_topups.sql` membangun ulang ledger untuk jenis isi ulang sambil menyalin ID/baris lama dan memulihkan proteksi. `0006_financial_controls.sql`, `0007_submission_receipts.sql`, dan `0008_financial_alert_settings.sql` menambahkan rekonsiliasi, nota privat, pengaturan, serta audit/proteksi. Persetujuan 0004 sebelumnya **tidak mencakup** paket baru ini.

Penerapan 0005–0008 memerlukan persetujuan pemilik yang spesifik, backup/bookmark pemulihan, pemilihan target database yang dikunci, dan pembandingan saldo, identitas/jumlah baris ledger, audit, serta trigger sebelum/sesudah. Jangan mengisi saldo, membuat transaksi contoh, mengoreksi selisih rekonsiliasi, atau mengubah akun/DNS sebagai bagian rilis ini.

Workflow deploy hanya memeriksa kolom dan trigger secara read-only; ia tidak menerapkan 0005–0008 dan akan menghentikan deployment jika skema belum lengkap. Jangan melewati gate tersebut atau mengaktifkan jalur migrasi 0004 lama untuk menerapkan paket baru. Setelah prosedur migrasi yang disetujui selesai, verifikasi skema dan deploy commit yang sama melalui gerbang CI biasa; pemeriksaan live harus tetap read-only.
