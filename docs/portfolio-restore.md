# Seed privat bank dan investasi ke VPS

File `data/portfolio-snapshot.json` dihasilkan dari database lokal. Direktori
`data/` diabaikan Git sehingga data ini tidak diunggah ke GitHub. Password/hash
login, sesi, transaksi, private key dan isi `.env` tidak disertakan.

## Siapkan snapshot lokal

```sh
node scripts/export-portfolio.mjs
```

Ekspor membaca database dalam satu transaksi agar saldo, unit/modal, posisi,
dan harga tersimpan berasal dari snapshot yang konsisten.

## VPS dengan database kosong

1. Siapkan kode, jalankan `npm ci` dan `npm run build`.
2. Salin file privat ke `<direktori-fintrack>/data/portfolio-snapshot.json`
   menggunakan SCP/SFTP. Jangan tambahkan file ini ke Git.
3. Jalankan aplikasi. Database kosong otomatis diisi sekali dari snapshot.

Startup berikutnya tidak menimpa data yang sudah ada. Konfigurasi login tetap
mengikuti `.env`/database VPS. Setelah restore berhasil, file snapshot di VPS
boleh dihapus karena datanya sudah tersimpan di SQLite.

## VPS yang sudah berisi data

Hentikan aplikasinya, salin snapshot, lalu jalankan dari direktori proyek:

```sh
node scripts/restore-portfolio.mjs --replace
```

Skrip mencadangkan database lama ke `backups/`, lalu mengganti data keuangan
sesuai snapshot. Transaksi/tren lama dibersihkan tanpa membalik efek saldo.
Login dan `.env` dipertahankan. Setelah itu jalankan ulang aplikasi.

Saldo bank, jumlah unit, modal, alamat wallet dan posisi tersimpan mengikuti
snapshot lokal. Nilai pasar dapat berubah setelah sinkron harga/on-chain aktif;
itu bukan selisih hasil impor. Harga streaming di memori mengikuti feed terbaru.
`PORTFOLIO_SNAPSHOT_PATH` bisa dipakai untuk lokasi file privat lain.
