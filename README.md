# Dompet Saya — Dashboard Keuangan + Portofolio (self-hosted)

Dasar putih, kartu putih, aksen ungu-teal. Mobile-first, PWA-ready.

## Fitur
- Akun (bank/e-wallet/tunai), transaksi expense/income/transfer **atomik**
- Portofolio crypto/saham/reksadana, P/L, skor diversifikasi
- Dashboard + 3 donut (kategori, alokasi, per aset), sparkline 7 hari
- Harga otomatis: CoinGecko → fallback Binance (crypto, 60 dtk),
  Yahoo Finance `.JK` (saham, 5 mnt; tanggal perdagangan tetap ditampilkan),
  NAB publik Kontan (reksadana, dicek saat boot dan setiap 15 menit). Cache `price_cache`, badge
  `Sinkron Live` / `Harga tertunda` / `Harga manual`
- Auth single-user `APP_PASSWORD` (bcrypt), cookie httpOnly+samesite
- Backup SQLite harian (14 hari)

Harga kripto streaming memakai satu koneksi WebSocket publik Binance Spot untuk
SOL, ETH, HYPE, dan MET (Meteora). Harga dicocokkan lewat mint/kontrak atau mapping
CoinGecko manual yang dikenal, bukan ticker wallet. Gunakan Node 22+ agar native
WebSocket tersedia. UI menggabungkan tick paling sering sekali per detik dan
menampilkan `Live Binance · USDT`; acuan USDT diperlakukan sebagai estimasi USD
untuk konversi rupiah. Ini harga referensi pasar, bukan estimasi hasil jual DEX.
Token tanpa mapping/feed tetap memakai harga berkala. Tick lewat 20 detik atau
koneksi putus otomatis kembali ke harga provider berkala dan mencoba tersambung
kembali. Saldo, komposisi LP, fees, dan limit order tetap mengikuti sinkron on-chain;
label streaming berlaku pada harga token, bukan jaminan semua posisi live.

Reksadana otomatis memakai simbol produk yang dipetakan eksplisit: `RD66` (Avrist Ada Kas
Mutiara), `RD838` (Majoris Sukuk Negara Indonesia), `RD984` (Manulife Dana Kas Syariah),
`RD13` (ABF Indonesia Bond Index Fund), dan `RD1544` (Schroder Dana Mantap Plus II).
Produk lain tetap dapat memakai harga manual. Qty saham adalah jumlah lembar.
P/L total memakai total modal jika diisi; P/L harian saham/reksadana membandingkan
harga/NAB bertanggal dengan publikasi sebelumnya menggunakan qty saat ini, tanpa
dividen. Tanggal acuan ditampilkan; bila sumber gagal, harga terakhir dipertahankan.
NAB bukan harga real-time dan jadwal publikasi masing-masing sumber dapat berbeda.

## Mulai cepat (lokal)
```bash
cp .env.example .env   # isi APP_PASSWORD + SESSION_SECRET
npm install
npm test
npm run build
npm start              # http://localhost:3100
```

Dev: `npm run dev:server` + `npm run dev:web` (proxy /api → :3100).

Port backend default **3100**. Saat memperbarui VPS yang sudah punya `.env`,
ubah `PORT=3100` di file tersebut, lalu sesuaikan upstream Nginx/Caddy.
PM2: `pm2 restart ecosystem.config.cjs --update-env`. Docker: publish
`127.0.0.1:3100:3100` ke reverse proxy di host.

## Ubuntu VPS dari nol
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs sqlite3 git
git clone https://github.com/Mavour/fintrack.git /opt/dompet && cd /opt/dompet
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

Data bank/investasi dipindahkan menggunakan [seed privat](docs/portfolio-restore.md).
Snapshot berada di `data/` dan tidak ikut GitHub; salin file tersebut secara privat
ke VPS agar saldo, unit, dan modal tidak perlu diinput ulang.

## Sinkron dompet onchain (bebas API key)
- **Solana**: daftarkan alamat publik di **Akun & Bank > Wallet**, alamat
  terdeteksi otomatis. Saldo diambil dari Jupiter Ultra holdings + metadata
  token terverifikasi (tanpa API key).
- **EVM** (Ethereum, Arbitrum, Base, Optimism, Polygon): bila `DEBANK_ACCESS_KEY`
  diisi, posisi token + DeFi/LP diambil dari DeBank Cloud OpenAPI. **Tanpa key**
  (default), sync memakai explorer **Blockscout publik tanpa API key** untuk
  native + ERC-20 semua chain EVM (DeFi/LP EVM butuh DeBank; bila unit DeBank
  habis, fallback Blockscout otomatis menjaga saldo tetap tersinkron). Harga
  mengikuti provider CoinGecko yang sudah ada (token via contract, native via
  kontrak wrapped kanonikal).
- Hanya alamat publik (watch-only). Qty mengikuti onchain; harga beli lama
  dipertahankan bila ada (kalau tidak, P/L disembunyikan). Token tak dikenal
  (tanpa simbol) dilewati otomatis.
- **Posisi LP Solana** (Meteora dkk): terbaca dari Jupiter Portfolio, muncul
  di kartu **Crypto dari Wallet** (sub-tab LP & DeFi, qty 1 @ nilai pool),
  diperbarui otomatis tiap 5 menit. Debu <$1 dilewati.

## Wallet tracker + LP (otomatis, read-only)
- Robinhood Chain mainnet **4663**: discovery ERC-20/NFT dari log transfer RPC,
  kemudian `balanceOf` dan `ownerOf` pada blok yang sama via Multicall3.
  LP aktif Uniswap v3/v4 yang dimiliki langsung dibaca dari kontrak resmi:
  principal + fees dihitung sekali; out-of-range tetap termasuk aset.
  NFT kosong/burn/berpindah pemilik dikecualikan. LP custodial staking/vault,
  posisi yang sudah kosong dengan fees tersisa, dan DEX lain belum dicakup.
  Discovery dan snapshot dibatasi sekali per menit per wallet; error RPC
  mempertahankan snapshot lama. Harga token dicocokkan chain+kontrak,
  termasuk harga quote USDG dari rasio pasangan; ticker bukan bukti harga $1.
- Elysium **Kinetiq mainnet (99901)** ikut dibaca untuk alamat EVM yang
  terdaftar: native HYPE via RPC, kontrak ERC-20 dari riwayat explorer resmi,
  lalu saldo `balanceOf` pada blok yang sama. Tidak menghitung saldo dari
  penjumlahan transfer. Token tanpa harga ditandai dan tidak masuk total;
  cakupan ini belum termasuk LP/DeFi Elysium.
- Staking MET di program referral dibaca lewat posisi staking Jupiter.
  Reward referral pending/claimable memerlukan sesi verifikasi wallet di
  Meteora dan **belum termasuk total**. Pelacak ini tidak meminta tanda tangan.
- Limit order mencakup input tersisa **dan hasil fill yang belum ditarik**.
  Hasil fill tampil terpisah agar tidak tertukar dengan saldo wallet bebas.
- Posisi LP bernilai dari Jupiter melengkapi DLMM Data API (termasuk DAMM v2,
  sesuai cakupan Jupiter). Pool DLMM yang muncul di kedua sumber dihitung sekali.
- Provider gagal mempertahankan posisi dan waktu sinkron terakhirnya. Kegagalan
  parsial tampil tertunda; status sukses lama tidak menutupi error terbaru.
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


## Agent Dorm / Karo: API integrasi baca-saja

Backend menyediakan server status terpisah di 127.0.0.1:9002 untuk agentId
portfolio. API ikut lifecycle fintrack dan tidak menjalankan scheduler sendiri.
Tidak ada dependency baru. API tidak otomatis diaktifkan atau menjalankan app.

Tambahkan ke .env saat siap mengaktifkan (file .env asli tidak diubah oleh patch):

```env
STATUS_API_ENABLED=true
STATUS_API_HOST=127.0.0.1
STATUS_API_PORT=9002
STATUS_API_KEY=<kunci-acak-khusus-integrasi>
STATUS_API_DAY_TIMEZONE=Asia/Makassar
STATUS_API_FX_MAX_AGE_SEC=86400
STATUS_API_MONTHLY_BUDGET_IDR=
```

STATUS_API_KEY wajib, termasuk di loopback. Jika key dan STATUS_API_ENABLED
belum diisi, API nonaktif. Key bukan password aplikasi atau session secret.
Saat memakai .env.example, ubah STATUS_API_ENABLED=false menjadi true setelah
key diisi. Gunakan SSH tunnel atau reverse proxy HTTPS untuk lintas mesin;
jangan kirim Bearer key lewat internet HTTP.

- GET /status: envelope portfolio untuk Agent Dorm; HTTP 200 juga jika warn/error.
- GET /health: HTTP 200 hanya jika snapshot ok, selain itu 503.
- Kedua endpoint wajib Authorization: Bearer <STATUS_API_KEY>.
- POST/PUT/PATCH/DELETE ditolak. Tidak ada endpoint membuat transaksi,
  mengubah saldo, mengubah budget aplikasi, refresh provider, atau impor wallet.
- Auth/login dan endpoint aplikasi fintrack yang sudah ada tidak diubah.

Aktivasi membutuhkan build backend dan restart fintrack dengan environment yang
sudah dikonfigurasi. Patch ini tidak melakukan restart atau membuka database
keuangan asli selama pengujian. Build normal tetap npm run build; untuk backend
saja, jalankan tsc -p tsconfig.server.json melalui TypeScript lokal.

Konfigurasi Dorm pada tahap penyambungan nanti (base URL tanpa /status):

```env
PORTFOLIO_MODE=http
PORTFOLIO_URL=http://127.0.0.1:9002
PORTFOLIO_API_KEY=<key-yang-sama>
PORTFOLIO_POLL_MS=5000
```

### Jaminan jalur baca dan pemetaan data

- Koneksi SQLite API terpisah dibuka readonly + query_only, fileMustExist=true.
  Tidak memanggil migrasi, seeding, pencatatan wealth history, atau sinkronisasi.
- Snapshot dibaca konsisten dalam read transaction, diperbarui tiap 30 detik.
  GET hanya menyajikan cache. Jika pembaruan gagal atau cache lebih tua dari
  90 detik, status menjadi error; updatedAt tidak dimajukan oleh polling HTTP.
- Deduplikasi aset manual/wallet mengikuti getUnifiedPortfolio. Mode readOnly
  melewatkan penulisan flag superseded_by_wallet; perilaku default fungsi
  untuk UI fintrack tetap sama. LP dihitung dari lp_positions bersama fee-nya,
  bukan ditambah lagi dari baris LP duplikat di wallet_positions.
- Saldo rekening nonaktif dikecualikan. Empat bucket akun (cash/stable/lp/spot)
  menghindari hilangnya eksposur LP pada advisor Dorm yang membaca per tipe.
  Saham/reksadana dan order DeFi masuk bucket investasi spot, bukan stable cair.
- IDR tetap tersedia di metrics.native. USD dikonversi memakai fx_cache pair
  USDIDR yang sudah tersimpan dan belum basi. Tidak ada fetch kurs baru atau
  fallback angka kurs tetap. Nilai USD adalah estimasi pada kurs cache saat ini,
  bukan kurs historis saat transaksi. Kurs hilang/basi menghasilkan null + alert.
- Aset tanpa valuasi lengkap menghasilkan valuationComplete=false dan
  netWorthUsd=null; knownNetWorthUsd adalah subtotal yang diketahui. Harga atau
  data wallet basi dan error sinkronisasi diberi peringatan tanpa membocorkan
  raw error provider, alamat wallet, session, password hash, atau path database.
- Arus kas mengecualikan transfer antar-akun dan transaksi di masa depan.
  Hari ini / 7 hari / 30 hari adalah hari kalender lokal termasuk hari ini;
  monthSpentUsd mengikuti bulan lokal STATUS_API_DAY_TIMEZONE.
- Daftar transaksi maksimal 60, terbaru dulu dengan ID stabil; agregat arus kas
  memakai seluruh transaksi dalam periodenya, tidak dibatasi 60 item.
- Fintrack belum mempunyai fitur budget belanja. Jika diperlukan, isi
  STATUS_API_MONTHLY_BUDGET_IDR dengan anggaran nyata pengguna (integer IDR).
  Field ini hanya metadata integrasi, tidak menulis transaksi atau mengubah saldo.
  Blank = budgetConfigured=false, dailyUsd/monthlyUsd=null. Budget harian adalah
  pembagian budget bulanan sesuai jumlah hari pada bulan berjalan; nilai 0 yang
  diisi eksplisit berarti budget nol, bukan tidak diketahui.
- events=[]; rapor/advisor tetap merupakan tugas Dorm. Sebelum menyambungkan UI,
  tangani budgetConfigured=false, valuationComplete=false, dan field USD null
  agar advisor tidak menafsirkan data belum tersedia sebagai nol atau boros.

Verifikasi: npm run typecheck, npm test. Tes API memakai database fixture dan
menguji query-only, perubahan saldo nol, transfer/date boundaries, deduplikasi,
FX/budget tidak tersedia, Bearer auth, dan larangan endpoint mutasi.
