# Berkas di PWA terpasang

Aplikasi terpasang yang dilaporkan pemilik adalah PWA dari origin `https://app.pangsumafc.com`, bukan wrapper Android terpisah. Perbaikan ini tidak memerlukan build APK baru, sumber Android terpisah, atau perubahan saluran distribusi.

## Jalur foto

Form memakai input file native yang terlihat dan label terkait, dengan `accept="image/*"` agar penyedia galeri dapat menawarkan gambar. Ini hanya petunjuk pemilih, bukan validasi keamanan. Klien tetap membatasi format, ukuran 10 MiB, resolusi, decoding nyata, pemotongan persegi dan normalisasi JPEG; server tetap memvalidasi isi dan menghapus metadata.

Penyedia berkas dapat mengirim foto tanpa ekstensi atau MIME yang berguna. JPEG, PNG dan WebP dengan metadata generik kini dikenali dari maksimal 32 byte awal, lalu tetap melewati decoder dan validasi server. MIME eksplisit yang tidak didukung tidak ditafsirkan ulang. Pembatalan pemilih tidak menghapus draf foto sebelumnya. Kembali dari galeri tidak boleh mereset dialog atau isian profil.

## Jalur PDF

PWA standalone Chrome memiliki user-agent yang sama dengan tab biasa. `downloadPdf` memeriksa `display-mode` standalone/fullscreen serta `navigator.standalone`; jalur ini meneruskan tautan attachment same-origin secara sinkron pada gestur pengguna, tanpa menunggu Blob dan tanpa membuat tab eksternal. Filter yang sudah diterapkan tetap dipakai dan cookie sesi tetap dikirim oleh browser.

Jalur tab Chrome tetap memakai fetch autentikasi dan Blob dengan penanganan error. Tautan unduh langsung tetap tersedia sebagai fallback. Respons PDF tetap `application/pdf`, `Content-Disposition: attachment`, dan tidak dicache. Pesan UI hanya mengonfirmasi permintaan diteruskan, bukan mengklaim file sudah tersimpan pada perangkat.

## Versi dan cache

Seluruh script/style, meta build, teks versi dan `version.json` harus memiliki build yang sama. Service worker memakai cache shell baru dan tidak menangani `/api/*` maupun `version.json`. Pembaruan hanya ditawarkan untuk nomor build yang lebih baru, tersedia juga untuk User dan layar login, tidak memuat ulang otomatis, serta tetap melindungi draf/transaksi aktif.

## Batas pengujian

Uji unit dan browser lokal memverifikasi alur kode, API, decoding, pemilih native Chromium, draf, PDF aktual, filter, sesi, cache, dan ukuran viewport. Simulasi `display-mode` atau user-agent bukan bukti PWA Android terpasang. Hasil aktual dan perintah uji rilis dicatat di `release-status.md`.

Penerimaan minimum di HP Android: buka dari ikon PWA; pastikan build terbaru terlihat; pilih JPG/PNG dari galeri lalu simpan dan buka ulang; batalkan pemilih lalu pilih lagi; tinggalkan aplikasi dan kembali sebelum menyimpan; unduh PDF hasil filter dan buka file dari Unduhan; periksa nama/isi laporan serta sesi masih aktif; ulangi pada layar kecil dengan keyboard terbuka. Jika masih gagal, catat model/versi Android dan browser pemasang, build yang terlihat, serta titik gagal (pemilih tidak terbuka, foto tidak terbaca, simpan gagal, atau PDF tidak tersimpan). Jangan menghapus data aplikasi atau menginstal ulang sebagai langkah pertama karena dapat menghilangkan draf.
