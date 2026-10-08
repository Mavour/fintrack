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
- **Solana**: daftarkan alamat publik di **Akun & Bank > Wallet**, alamat
  terdeteksi otomatis. Saldo diambil dari Jupiter Ultra holdings + metadata
  token terverifikasi (tanpa API key).
- **EVM** (Ethereum, Arbitrum, Base, Optimism, Polygon): via explorer Blockscout
  publik (tanpa API key). Harga mengikuti provider CoinGecko yang sudah ada.
- Hanya alamat publik (watch-only). Qty mengikuti onchain; harga beli lama
  dipertahankan bila ada (kalau tidak, P/L disembunyikan). Token tak dikenal
  (tanpa simbol) dilewati otomatis.
- **Posisi LP Solana** (Meteora dkk): terbaca dari Jupiter Portfolio, muncul
  di kartu **Crypto dari Wallet** (sub-tab LP & DeFi, qty 1 @ nilai pool),
  diperbarui otomatis tiap 5 menit. Debu <$1 dilewati.

## Wallet tracker + LP (otomatis, read-only)
- Daftarkan wallet di **Akun & Bank > Wallet** (label + alamat publik).
  Jaringan terdeteksi otomatis (Solana base58 / EVM `0x`). Satu alamat EVM
  berlaku untuk semua chain EVM. Tidak pernah meminta/menyimpan private key,
  seed phrase, atau koneksi wallet.
- Seed awal lewat `.env` (bukan hardcode): `SEED_WALLETS` (JSON
  `[{label, address}]`). Contoh palsu ada di `.env.example`. `.env` sudah
  di-`.gitignore` — jangan commit alamat asli.
- Sumber data resmi (tanpa scraping halaman web):
  - Solana token/staking: **Jupiter Portfolio API v1**
    `GET /positions/{address}` + `GET /platforms`, header
    `x-api-key: $JUPITER_API_KEY` (beta, cakupan platform Jupiter saja).
    Fallback: RPC `getTokenAccountsByOwner` + Jupiter Price API.
  - Solana LP: **Meteora Data API** (`METEORA_DLMM_BASE`,
    `METEORA_DAMM_V2_BASE`; hormati 30/10 req/detik). Path endpoint
    dioverride via `METEORA_DLMM_PATH` / `METEORA_DAMM_V2_PATH` setelah
    verifikasi Swagger di base URL. Orca/Raydium masih stub + TODO.
  - EVM token + LP semua chain: **DeBank Cloud OpenAPI**
    (`AccessKey: $DEBANK_ACCESS_KEY`; EVM saja, bukan Solana).
    Anggaran harian via `DEBANK_DAILY_UNIT_BUDGET`; sync EVM berhenti
    otomatis bila unit habis + peringatan di UI.
  - HyperCore spot (HYPE dkk): **Hyperliquid info API resmi tanpa key**
    (`POST /info` `spotClearinghouseState` per alamat + `spotMetaAndAssetCtxs`
    untuk harga `midPx` pair `COIN/USDC`; koin tanpa pair → harga null).
    Badge `HyperCore` (spot L1) vs `HyperEVM` (chain EVM id 999). Docs DeBank
    menunjukkan protocol "hyperliquid / Main-Account Spot" ikut terbaca dari
    DeBank, jadi sync membuang baris DeBank-hyperliquid yang koinnya juga ada
    di HyperCore (`dedupeHyperliquid`, sumber resmi menang). Cakupan Hyper
    DeBank diverifikasi runtime via `/v1/chain/list` (cache 24 jam).
- **Portofolio > Daftar Aset (terpadu)**: setiap baris crypto menampilkan
  badge chain + chip label wallet + penanda sumber **Wallet** (hijau,
  read-only — klik membuka input harga beli) atau **Manual** (abu, bisa
  diedit). Aset manual yang simbolnya juga ada di wallet ditandai
  **Duplikat wallet**, **dikecualikan dari total & pie** (tidak dihapus
  otomatis, ada tombol Hapus). P/L token wallet hanya dihitung dari tabel
  `cost_basis` (input per token via `PUT /api/cost-basis`); tanpa itu tampil
  "-". Tabel fixed-layout tanpa scroll horizontal di viewport ≥900px
  (kolom Tren 7h sembunyi <1100px, Bobot % <1000px).
- **Portofolio > Crypto dari Wallet**: sub-tab **Token** dan **LP & DeFi**,
  filter chip per chain + per wallet, aset sama lintas wallet digabung
  (detail per wallet tetap ada). Debu `<$1` disembunyikan default
  (toggle "Tampilkan semua"). Kartu LP: **Fees belum diklaim, TVL posisi,
  TVL pool** + badge protokol/chain + status In/Out of range bila ada.
  **Tanpa PnL/APR/IL untuk LP.**
- Nilai USD dikonversi ke IDR di tampilan memakai kurs `fx_cache` yang ada.
- Validasi alamat memakai lib resmi: Solana `PublicKey` (`@solana/web3.js`),
  EVM `isAddress` (`viem`). Tipe jaringan terdeteksi otomatis.
- **Sinkronisasi bertingkat** (semua interval detik, min 10, via `.env`):
  Harga `PRICE_REFRESH_SEC=15` (harga token dikenal + hitung ulang
  `value = amount × price`, tanpa baca wallet) | LP Meteora `LP_REFRESH_SEC=15`
  | Solana `SOL_REFRESH_SEC=15` | EVM `EVM_REFRESH_SEC=15`.
  Scheduler satu proses: mutex per tier (tidak tumpang tindih), jitter ±10%,
  hormati `Retry-After` + backoff saat HTTP 429, hash-skip (hasil identik
  tidak ditulis & tidak emit SSE), mode hemat (interval ×5 bila 30 mnt tanpa
  klien SSE). Tombol Sinkron Ulang memicu semua tingkat (cooldown 30 dtk).
  Idempoten (upsert 1 transaksi). Satu provider gagal tidak merusak lain.
- **Pengaman DeBank (diukur, bukan ditebak):** unit dibaca via
  `/v1/account/units` sebelum & sesudah tiap siklus EVM, tercatat di
  `debank_meter` per endpoint; proyeksi harian tampil di menu Wallet. Bila
  proyeksi > `DEBANK_DAILY_UNIT_BUDGET`, interval EVM naik bertahap
  (15d→30d→1m→5m→maks 10m) + chip "EVM melambat (hemat unit)"; bila unit
  habis, sync EVM berhenti + peringatan.
- **Sumber harga tingkat harga:** Solana Jupiter Price API v3 per mint; EVM
  CoinGecko `simple/token_price` per contract (di luar DeBank agar hemat
  unit; tanpa harga → harga DeBank terakhir dipakai). CoinGecko free
  ~5–15/mnt (pacing 1,2 dtk/chain). **Rate limit paket key Jupiter tidak
  dipublikasikan di docs** — 429 ditangani generik (backoff + naikkan
  interval sementara). Meteora: DLMM 30 req/detik, DAMM v2 10 req/detik
  (dari spec Data API).
- **Live update:** `GET /api/events` (SSE, auth cookie, heartbeat 25 dtk);
  event `sync:done` berisi cakupan berubah, frontend refresh maks 1×/detik,
  scroll + modal dipertahankan. Putus → reconnect backoff eksponensial +
  fallback polling 30 dtk. Tab tersembunyi >60 dtk → SSE ditutup; fokus lagi
  → sambung + segarkan bila data >60 dtk.
- **Tahan banting:** circuit breaker per provider (buka setelah 5 gagal
  beruntun, half-open trial), zod toleran (item rusak dilewati + warn),
  guard drop >90% (data lama dipertahankan, terima setelah 2 konfirmasi),
  respons kosong tidak menimpa snapshot, SQLite WAL + `busy_timeout`,
  `unhandledRejection`/`uncaughtException` + graceful shutdown (PM2 restart).
  Badge topbar "Sinkron Live" bila semua tingkat fresh dalam 2× interval
  aktifnya (klik untuk rincian per tingkat); selain itu "Tertunda"/"Harga manual".

## Data demo (tidak pernah di jalur runtime)
- Kode `src/` tidak mengandung data contoh: satu-satunya INSERT adalah dari
  input user/API dan snapshot provider. Skrip `scripts/seed-dummy.mjs`,
  `scripts/shot.mjs`,   `scripts/shot-wallet.mjs` **menolak berjalan kecuali `DEMO_MODE=true`** (default false) dan menulis ke DB
  temporer (shot) atau server yang dituju (seed-dummy, mencatat simbol ke
  `meta.demo_seed`). Pembersihan satu kali: `node scripts/clean-demo.mjs`
  (dry-run) / `--apply` — menghapus hanya fingerprint persis data demo,
  tidak menyentuh aset user.
- Token tanpa harga tidak disembunyikan: grup **Tanpa harga (n)** ("Harga
  belum tersedia", nilai "-", keluar dari total). Filter debu hanya untuk
  posisi berharga <$1. Harga cadangan: Jupiter Price v3 (Solana),
  CoinGecko per contract (EVM).
- Bila key kosong/provider gagal: empty state eksplisit per provider
  ("Belum tersinkron: ..."), status per provider di menu Wallet, tanpa
  angka palsu.
- **Status jujur endpoint (Okt 2026):** Meteora Data API `GET /wallet/open-positions`
  → **404** (path wallet belum terverifikasi; root hanya `{"status":"ok"}`,
  tanpa `/docs`/`/openapi.json`) — adapter error terkontrol + circuit, UI
  "Tertunda". Hyperliquid `spotClearinghouseState` → 200; saldo user
  **kosong** (tidak punya HYPE — terkonfirmasi onchain, bukan bug).

## Catatan harga
- `MET`: tidak ditebak — `verifyMetMapping()` memakai CoinGecko `/search`,
  memilih kandidat simbol MET berperingkat pasar tertinggi, menyimpan ke `asset_map`.
- Kurs USD/IDR di-cache 1 jam (`fx_cache`), fallback cache lama lalu 16000.
- Semua fetch: timeout + retry exponential backoff + jeda rate-limit.
- Tidak pernah meminta/menyimpan private key / seed phrase / API key trading.

## Struktur
`src/server/{routes,services,providers,db,jobs}` `src/web/{pages,components,lib}` `tests/`
