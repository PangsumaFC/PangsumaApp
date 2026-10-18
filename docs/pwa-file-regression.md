# Berkas di PWA dan APK WebView

PWA dan APK WebView adalah dua lingkungan berbeda. APK yang diberikan pemilik membuka `https://app.pangsumafc.com/` tanpa aset web bawaan dan hanya memiliki bridge unduhan CSV lama (`PangsumaFileBridge.saveCsv`). Sumber Android tidak tersedia. Perubahan web tidak mengubah APK/bridge tersebut dan bukan bukti simpan PDF native pada APK.

## Jalur foto

Form memakai input file native yang terlihat dan label terkait, dengan `accept="image/*"` agar penyedia galeri dapat menawarkan gambar. Ini hanya petunjuk pemilih, bukan validasi keamanan. Klien tetap membatasi format, ukuran 10 MiB, resolusi, decoding nyata, pemotongan persegi dan normalisasi JPEG; server tetap memvalidasi isi dan menghapus metadata.

Penyedia berkas dapat mengirim foto tanpa ekstensi atau MIME yang berguna. JPEG, PNG dan WebP dengan metadata generik kini dikenali dari maksimal 32 byte awal, lalu tetap melewati decoder dan validasi server. MIME eksplisit yang tidak didukung tidak ditafsirkan ulang. Pembatalan pemilih tidak menghapus draf foto sebelumnya. Kembali dari galeri tidak boleh mereset dialog atau isian profil.

## Jalur PDF

PWA standalone Chrome memiliki user-agent yang sama dengan tab biasa. `downloadPdf` memeriksa `display-mode` standalone/fullscreen serta `navigator.standalone`; jalur PWA memakai dialog `PwaFiles.prepare`, fetch same-origin dan Blob yang tetap tersedia sampai dialog ditutup, serta opsi simpan/bagikan. Filter yang sudah diterapkan tetap dipakai dan cookie sesi tetap dikirim oleh browser. Jalur attachment langsung tetap tersedia untuk iOS dan fallback tanpa helper.

Jalur tab Chrome tetap memakai fetch autentikasi dan Blob dengan penanganan error. Tautan unduh langsung tetap tersedia sebagai fallback. Respons PDF tetap `application/pdf`, `Content-Disposition: attachment`, dan tidak dicache. Pesan UI hanya mengonfirmasi permintaan diteruskan, bukan mengklaim file sudah tersimpan pada perangkat.

## APK dengan bridge CSV saja — versi 2026.10.18.8

WebView dikenali lewat bridge bernama `PangsumaFileBridge` atau UA Android WebView, sebelum pemeriksaan standalone. Tombol PDF dan tautan fallback membuka dialog **Unduh PDF melalui Chrome**, bukan memanggil `saveCsv`, membuat Blob, atau mengklaim native download didukung. Tombol **Buka Chrome** mencoba intent Chrome dengan fallback URL same-origin; bila host APK tidak membuka browser, pengguna dapat **Salin tautan** atau memilih URL lengkap secara manual lalu menempelkannya di browser lain. Dukungan intent pada APK fisik belum dibuktikan.

Halaman `/pdf-browser.html` membawa hanya tujuh filter aktif (`q`, `periode`, `jenis`, `status`, `pengaju`, `start`, `end`), tanpa cookie/token sesi, kunci, atau parameter redirect. Login browser terpisah: pengguna membuka login Manager di tab browser lain, kembali ke halaman handoff, lalu memeriksa sesi. Link PDF baru diaktifkan sesudah `/api/session` mengonfirmasi Manager dan password tidak wajib diganti. Server tetap memeriksa otorisasi pada unduhan. Jika halaman handoff masih berada di WebView, link PDF tetap disembunyikan dan instruksi salin URL ditampilkan.

Halaman handoff memakai `no-store`, `no-referrer`, tidak dicegat service worker, dan tidak menjadi cache shell `/`. Tidak ada dekompilasi, perubahan, penandatanganan ulang, atau build APK. Menyimpan PDF langsung melalui native bridge tetap memerlukan pembaruan APK dari sumber Android.

## Versi dan cache

Seluruh script/style, meta build, teks versi dan `version.json` harus memiliki build yang sama. Service worker memakai cache shell baru dan tidak menangani `/api/*` maupun `version.json`. Pembaruan hanya ditawarkan untuk nomor build yang lebih baru, tersedia juga untuk User dan layar login, tidak memuat ulang otomatis, serta tetap melindungi draf/transaksi aktif.

## Batas pengujian

Uji unit dan browser lokal memverifikasi alur kode, API, decoding, pemilih native Chromium, draf, PDF aktual, filter, sesi, cache, dan ukuran viewport. Simulasi `display-mode` atau user-agent bukan bukti PWA Android terpasang. Hasil aktual dan perintah uji rilis dicatat di `release-status.md`.

`bash tests/run-profile-local.sh --mobile-download` menguji WebView UA, bridge CSV dengan UA Chrome biasa, dan Chrome tab. Fixture hanya di database lokal sementara. Uji memeriksa bridge tidak dipanggil, tidak ada permintaan PDF dari WebView, filter tepat, halaman yang terperangkap tetap menolak simpan native, login browser terpisah, isi PDF aktual, clipboard gagal/manual, dan viewport 320/390/844/1280 px. Ini bukan pengujian perangkat Android fisik.

Penerimaan minimum di HP Android: buka dari ikon PWA; pastikan build terbaru terlihat; pilih JPG/PNG dari galeri lalu simpan dan buka ulang; batalkan pemilih lalu pilih lagi; tinggalkan aplikasi dan kembali sebelum menyimpan; unduh PDF hasil filter dan buka file dari Unduhan; periksa nama/isi laporan serta sesi masih aktif; ulangi pada layar kecil dengan keyboard terbuka. Jika masih gagal, catat model/versi Android dan browser pemasang, build yang terlihat, serta titik gagal (pemilih tidak terbuka, foto tidak terbaca, simpan gagal, atau PDF tidak tersimpan). Jangan menghapus data aplikasi atau menginstal ulang sebagai langkah pertama karena dapat menghilangkan draf.
