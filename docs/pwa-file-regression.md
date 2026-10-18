# Berkas di PWA dan APK WebView

PWA dan APK WebView adalah dua lingkungan berbeda. APK yang diberikan pemilik membuka `https://app.pangsumafc.com/` tanpa aset web bawaan dan hanya memiliki bridge unduhan CSV lama (`PangsumaFileBridge.saveCsv`). Sumber Android tidak tersedia. Perubahan web tidak mengubah APK/bridge tersebut dan bukan bukti simpan PDF native pada APK.

## Jalur foto

Form memakai input file native yang terlihat dan label terkait, dengan `accept="image/*"` agar penyedia galeri dapat menawarkan gambar. Ini hanya petunjuk pemilih, bukan validasi keamanan. Klien tetap membatasi format, ukuran 10 MiB, resolusi, decoding nyata, pemotongan persegi dan normalisasi JPEG; server tetap memvalidasi isi dan menghapus metadata.

Penyedia berkas dapat mengirim foto tanpa ekstensi atau MIME yang berguna. JPEG, PNG dan WebP dengan metadata generik kini dikenali dari maksimal 32 byte awal, lalu tetap melewati decoder dan validasi server. MIME eksplisit yang tidak didukung tidak ditafsirkan ulang. Pembatalan pemilih tidak menghapus draf foto sebelumnya. Kembali dari galeri tidak boleh mereset dialog atau isian profil.

## Jalur PDF

PWA standalone Chrome memiliki user-agent yang sama dengan tab biasa. `downloadPdf` memeriksa `display-mode` standalone/fullscreen serta `navigator.standalone`; jalur PWA memakai dialog `PwaFiles.prepare`, fetch same-origin dan Blob yang tetap tersedia sampai dialog ditutup, serta opsi simpan/bagikan. Filter yang sudah diterapkan tetap dipakai dan cookie sesi tetap dikirim oleh browser. Jalur attachment langsung tetap tersedia untuk iOS dan fallback tanpa helper.

Jalur tab Chrome tetap memakai fetch autentikasi dan Blob dengan penanganan error. Tautan unduh langsung tetap tersedia sebagai fallback. Respons PDF tetap `application/pdf`, `Content-Disposition: attachment`, dan tidak dicache. Pesan UI hanya mengonfirmasi permintaan diteruskan, bukan mengklaim file sudah tersimpan pada perangkat.

## APK dengan bridge CSV saja — versi 2026.10.18.9

APK dikenali hanya lewat interface `PangsumaFileBridge` yang sudah terbukti tertanam, sebelum pemeriksaan standalone. Tidak ada tebakan user-agent; PWA terpasang di browser tanpa bridge tetap memakai jalur PWA. Wrapper lain tanpa interface ini tidak dapat diidentifikasi dengan bukti yang tersedia.

Tombol PDF menampilkan status ringkas **Unduh PDF langsung memerlukan APK yang diperbarui.** Hanya tersedia tombol Tutup. Fallback Chrome/intent, clipboard, URL salin manual, dan link PDF langsung tidak ditawarkan pada APK. `prepare` juga memiliki guard APK agar tidak fetch PDF, membuat Blob, memanggil bagikan OS atau bridge CSV. Browser biasa tetap memakai unduhan PDF normal dengan filter aktif dan sesi sendiri.

Halaman lama `/pdf-browser.html` tetap dapat dipakai browser, membawa hanya tujuh filter aktif (`q`, `periode`, `jenis`, `status`, `pengaju`, `start`, `end`) dan memverifikasi sesi Manager sebelum mengaktifkan PDF. Di APK, halaman ini menyembunyikan instruksi login browser dan seluruh kontrol download, tidak meminta sesi, dan menampilkan status pembaruan APK yang sama. Kontrol salin URL telah dihapus.

Halaman PDF memakai `no-store`, `no-referrer`, tidak dicegat service worker, dan tidak menjadi cache shell `/`. Perubahan ini hanya pada situs, bukan modifikasi, build atau penandatanganan ulang APK. Menyimpan PDF langsung tetap memerlukan handler native di APK yang diperbarui.

## Versi dan cache

Seluruh script/style, meta build, teks versi dan `version.json` harus memiliki build yang sama. Service worker memakai cache shell baru dan tidak menangani `/api/*` maupun `version.json`. Pembaruan hanya ditawarkan untuk nomor build yang lebih baru, tersedia juga untuk User dan layar login, tidak memuat ulang otomatis, serta tetap melindungi draf/transaksi aktif.

## Batas pengujian

Uji unit dan browser lokal memverifikasi alur kode, API, decoding, pemilih native Chromium, draf, PDF aktual, filter, sesi, cache, dan ukuran viewport. Simulasi `display-mode` atau user-agent bukan bukti PWA Android terpasang. Hasil aktual dan perintah uji rilis dicatat di `release-status.md`.

`bash tests/run-profile-local.sh --mobile-download` menguji bridge CSV dengan UA WebView maupun Chrome biasa, Chrome tab, dan simulasi standalone. Fixture hanya di database lokal sementara. Regresi memeriksa tidak ada export PDF, intent, popup, clipboard atau panggilan CSV pada APK; status tanpa fallback keluar; halaman PDF lama terblokir; filter dan isi PDF browser aktual; serta sesi tetap aktif. Ini bukan pengujian APK/perangkat Android fisik.

Penerimaan minimum di HP Android: buka dari ikon PWA; pastikan build terbaru terlihat; pilih JPG/PNG dari galeri lalu simpan dan buka ulang; batalkan pemilih lalu pilih lagi; tinggalkan aplikasi dan kembali sebelum menyimpan; unduh PDF hasil filter dan buka file dari Unduhan; periksa nama/isi laporan serta sesi masih aktif; ulangi pada layar kecil dengan keyboard terbuka. Jika masih gagal, catat model/versi Android dan browser pemasang, build yang terlihat, serta titik gagal (pemilih tidak terbuka, foto tidak terbaca, simpan gagal, atau PDF tidak tersimpan). Jangan menghapus data aplikasi atau menginstal ulang sebagai langkah pertama karena dapat menghilangkan draf.
