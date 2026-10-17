# Pangsuma App

Source statis untuk Pangsuma App. File aplikasi dan aset PWA berada di `site/`.

## Deployment

Setiap push ke branch `main` menjalankan GitHub Actions workflow `.github/workflows/deploy.yml`, yang menerbitkan isi `site/` ke proyek Cloudflare Pages yang sudah ada, `pangsuma-app`. Workflow menggunakan secret repository `CLOUDFLARE_API_TOKEN`.

## Catatan aplikasi

Aplikasi ini masih berupa prototipe demo sisi klien. Login di browser bukan autentikasi atau kontrol akses; data dan kredensial demo dapat diperiksa atau dilewati dari source. Jangan gunakan password, informasi, atau data operasional yang sungguhan.
