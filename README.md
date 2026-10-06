# Dompet Saya — Dashboard Keuangan + Portofolio (self-hosted)

Dasar putih, kartu putih, aksen ungu-teal. Mobile-first, PWA-ready.

## Fitur
- Akun (bank/e-wallet/tunai), transaksi expense/income/transfer **atomik**
- Portofolio crypto/saham/reksadana, P/L, skor diversifikasi
- Dashboard + 3 donut (kategori, alokasi, per aset), sparkline 7 hari
- Harga otomatis: CoinGecko → fallback Binance (crypto, 60 dtk),
  Yahoo Finance `.JK` (saham, 5 mnt saat bursa 09–16 WIB),
  NAB manual (reksadana). Cache `price_cache`, badge
  `Sinkron Live` / `Harga tertunda` / `Harga manual`
- Auth single-user `APP_PASSWORD` (bcrypt), cookie httpOnly+samesite
- Backup SQLite harian (14 hari)

## Mulai cepat (lokal)
```bash
cp .env.example .env   # isi APP_PASSWORD + SESSION_SECRET
npm install
npm test
npm run build
npm start              # http://localhost:3000
```

Dev: `npm run dev:server` + `npm run dev:web` (proxy /api → :3000).

## Ubuntu VPS dari nol
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs sqlite3 git
git clone <repo> /opt/dompet && cd /opt/dompet
cp .env.example .env && nano .env
npm ci && npm run build && npm test
sudo npm i -g pm2
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
# Caddy (HTTPS otomatis):
sudo apt install -y caddy
sudo cp Caddyfile.example /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile
sudo systemctl reload caddy
# Backup cron (app juga backup internal via VACUUM INTO tiap 02:00):
(crontab -l; echo "0 2 * * * /opt/dompet/scripts/backup.sh") | crontab -
```

Update: `git pull && npm ci && npm run build && pm2 restart dompet-saya`.

## Sinkron dompet onchain (bebas API key)
- **Solana**: tempel alamat publik di Portofolio → Sinkron Dompet. Saldo diambil
  dari Jupiter Ultra holdings + metadata token terverifikasi (tanpa API key).
- **EVM** (Ethereum, Arbitrum, Base, Optimism, Polygon): via explorer Blockscout
  publik (tanpa API key). Harga mengikuti provider CoinGecko yang sudah ada.
- Hanya alamat publik (watch-only). Qty mengikuti onchain; harga beli lama
  dipertahankan bila ada (kalau tidak, P/L disembunyikan). Token tak dikenal
  (tanpa simbol) dilewati otomatis.

## Catatan harga
- `MET`: tidak ditebak — `verifyMetMapping()` memakai CoinGecko `/search`,
  memilih kandidat simbol MET berperingkat pasar tertinggi, menyimpan ke `asset_map`.
- Kurs USD/IDR di-cache 1 jam (`fx_cache`), fallback cache lama lalu 16000.
- Semua fetch: timeout + retry exponential backoff + jeda rate-limit.
- Tidak pernah meminta/menyimpan private key / seed phrase / API key trading.

## Struktur
`src/server/{routes,services,providers,db,jobs}` `src/web/{pages,components,lib}` `tests/`
