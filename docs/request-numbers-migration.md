# Nomor pengajuan Pangsuma

Implementasi disiapkan lokal dari versi produksi **2026.10.19.11**, commit `bf903a89a9a1481b2372f1855d837e0ad068c8dc`. Belum di-deploy dan belum ada migrasi, pembacaan data pengajuan, backfill, atau upload ke produksi.

## Yang akan terlihat

Petty Cash menggunakan `PCMMYYYYNNNNNN`, sedangkan Request Finance menggunakan `RFMMYYYYNNNNNN`. Contohnya `PC112026000001` dan `RF112026000001`. Bulan dan tahun berasal dari waktu pengajuan dibuat dalam WIB, bukan tanggal transaksi. Seluruh nomor ditulis tanpa slash, spasi, atau tanda hubung. Nomor urut dimulai dari `000001` untuk setiap kategori dan bulan/tahun. Jika bulan tersebut sudah mempunyai pengajuan lama yang diberi nomor, pengajuan berikutnya melanjutkan urutan yang tersedia.

Nomor tetap sama setelah persetujuan, penolakan, dan pengiriman ke Finance. Reservasi nomor disimpan sebelum transaksi pengajuan; jika transaksi gagal karena saldo tidak cukup, nomor itu tetap tercatat dan tidak diberikan kepada pengajuan lain. Pengiriman ulang dengan kunci yang sama memakai identitas yang sama. UUID internal dan izin akses tetap terpisah.

Nomor tampil pada kartu pengajuan, antrean persetujuan, detail, aktivitas, dan riwayat terkait. Pencarian berlangsung di server dengan batas akses sesuai peran, bukan hanya halaman yang sedang terlihat.

PDF Petty Cash dan Request Finance mempunyai kolom **No. Pengajuan** tersendiri. Setiap tautan Dropbox berwarna biru memakai nomor persis tanpa pemisah, dan tetap mengarah ke berkas yang bersangkutan. Baris saldo awal atau penambahan kas yang bukan pengajuan tidak diberi nomor fiktif. Keterangan tetap hanya Keperluan; Catatan tidak dimasukkan. Penanda DATA DEMO tetap kecil.

## Nama lampiran baru

Hanya upload baru yang diberi nama, misalnya `PC112026000001.jpg`. Berkas berikutnya diberi akhiran `-01`, `-02`, dan seterusnya. Ekstensi `.jpg`, `.jpeg`, atau `.png` yang cocok dengan isi gambar dipertahankan. Nomor urut berkas ditentukan dalam transaksi database, dan setiap berkas memiliki lokasi unik sehingga tidak menimpa berkas lain. Retry menggunakan path yang sudah disimpan, bukan membuat nama atau tautan pengganti.

**Berkas, path, tautan, kepemilikan, dan izin Dropbox yang sudah ada tidak diganti.** Tidak ada publikasi folder; tautan tetap per berkas dengan akses viewer seperti sebelumnya. Dukungan tipe berkas tidak diperluas: aplikasi tetap menerima format gambar yang sudah didukung.

## Dampak jika migrasi disetujui

1. `migrations/0010_request_numbers.sql` menambah satu kolom `request_number` pada tabel pengajuan serta tabel reservasi dan penghitung nomor. Seluruh pengajuan lama diberi nomor berdasarkan kategori dan bulan/tahun pembuatan WIB, dengan urutan deterministik waktu pembuatan lalu UUID untuk waktu yang sama. Sesudah pengisian, nomor dan identitas reservasi dikunci agar tidak dapat diubah atau digunakan ulang.
2. `migrations/0011_request_number_receipts.sql` mengganti hanya aturan validasi saat metadata lampiran baru dimasukkan. Path dan tautan lampiran lama, termasuk upload pending yang dapat dicoba ulang, tidak ditulis ulang.
3. Nominal, status, tanggal transaksi, Keperluan, Catatan, pengaju, keputusan, saldo kas, ledger, dan audit lama tidak diubah. Pemberian nomor tidak membuat transaksi keuangan baru.

Jumlah pengajuan produksi yang akan mendapat nomor **belum diketahui**, karena produksi tidak dibaca untuk tugas ini. Dry-run dan pengujian memakai data sintetis/lokal saja; jumlah pada hasil dry-run bukan jumlah data produksi. Data lama dengan tanggal atau referensi yang tidak valid harus diperbaiki melalui persetujuan tersendiri; migrasi tidak boleh memaksakan nomor pada data yang tidak dapat divalidasi.

## Sebelum diterapkan di produksi

Diperlukan persetujuan eksplisit terpisah untuk kedua migrasi dan pemberian nomor pada seluruh pengajuan lama. Setelah disetujui, siapkan titik pemulihan database, cocokkan kondisi data dengan rencana, lalu jalankan migrasi melalui alur yang ada sebelum merilis kode yang bergantung pada skema baru. Hentikan jika ditemukan benturan atau data tidak valid. Jangan mengubah nama atau tautan Dropbox lama.

Peralihan skema dan kode harus dikoordinasikan dengan jeda pengiriman pengajuan dan lampiran. Setelah aturan nomor wajib dipasang, kode produksi lama tidak dapat membuat pengajuan tanpa nomor; aturan nama lampiran baru juga menunggu kode yang sesuai. Karena itu migrasi dan rilis tidak boleh dibiarkan terpisah saat pengguna masih mengirim data. Jeda ini hanya rencana pemasangan setelah disetujui, bukan perubahan yang sudah dilakukan.

Pertanyaan persetujuan: **“Apakah Ibu menyetujui penerapan migrasi 0010 dan 0011 di produksi serta pemberian nomor pada seluruh pengajuan lama, tanpa mengubah transaksi keuangan maupun berkas dan tautan Dropbox lama?”**
