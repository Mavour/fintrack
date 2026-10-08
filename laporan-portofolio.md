# Laporan Perbaikan Portofolio Crypto

Tanggal: 7 Oktober 2026 · Lingkungan: production (port 3000) + demo (screenshots)

## Ringkasan

Perbaikan portofolio crypto selesai dan terverifikasi live: tidak ada lagi penghitungan dobel
antara aset manual dan token dari wallet, simbol token wallet ditampilkan dengan nama aslinya,
SOL native ikut dihitung, posisi LP Meteora DLMM dibaca dari endpoint resmi, dan seluruh tier
sinkronisasi (`price`, `lp`, `solana`, `evm`) berstatus sehat (`lastError: null`).

Kendala yang diikuti: **tidak menambah banyak API baru** — hanya memakai sumber data yang sudah ada
(Jupiter, DeBank, GeckoTerminal, DexScreener) plus **membaca langsung on-chain lewat RPC yang sudah
dipakai** untuk deteksi posisi DAMM v2.

## Item yang dikerjakan

### 1. Satu sumber, tanpa dobel (manual + wallet)
- Dedup kini berbasis **mint** (lebih tepat), bukan hanya simbol. Diverifikasi live bahwa dua mint
  berbeda (`J7cXcHp8…` dan `q6ifXvFe…`) sama-sama ber-simbol **FEBU**, sehingga dedup by-symbol saja
  tidak cukup.
- Simbol asli dipastikan via **GeckoTerminal**: `q6ifXvFe…` → `febu`, `77FgtkZkBGXq…` → `SV151`
  ("Scarlet & Violet 151"), `J7cXcHp8…` → `febu`. DexScreener mengembalikan `[]` untuk ketiganya.
- Kolom `chain` + `mint` ditambahkan ke tabel `assets`. Backfill saat startup mencocokkan aset
  crypto manual dengan `wallet_positions` berdasar **qty identik** (epsilon 1e-9), hanya bila tepat
  satu mint distinct dan tidak ambigu. Hasil production terverifikasi:

  | Aset manual | Qty | Mint hasil backfill | Status |
  |---|---|---|---|
  | FEBU | 56.158085 | `J7cXcHp8…` | excluded (by mint) |
  | SV151 | 14 | `77FgtkZk…` | excluded (by mint) |
  | FEBU_Q6IF | 61.442144 | `q6ifXvFe…` | excluded (by mint) |
  | SOL | 1.00156509 | — (qty beda dgn wallet) | excluded (by symbol) |

- `getUnifiedPortfolio` sekarang: `match = byMint ?? bySymbol`, lalu `in_wallet=true` / `excluded=true`.
- Upsert aset memakai `COALESCE(excluded.chain, assets.chain)` agar edit harga via UI tidak menghapus
  hasil backfill.

### 2. Badge chain aset manual
- `wallet_chains` jatuh ke kolom `chain` milik aset bila tidak tertutup posisi wallet → badge
  jaringan muncul untuk aset crypto manual yang memakai jaringan.

### 3. Simbol token wallet yang benar + native SOL
- Resolver bersama baru `tokenMeta.ts`: Jupiter verified (cache 24 jam) → DexScreener →
  GeckoTerminal, semua best-effort (`source: verified|dex|gecko`).
- `solanaRpcFallback` ditulis ulang:
  - membaca **dua** program token (SPL `Tokenkeg…` **dan** Token-2022 `TokenzQdBNbLq…`);
  - SOL native lewat `getBalance`, digabung dengan wSOL (`So111…`, desimal 9, `source: native`);
  - jumlah token = `toFixed(decimals)` agar tidak ada angka koma palsu; harga via Jupiter lite
    `https://lite-api.jup.ag/price/v3`.
- Hasil live: **20 token** tersinkron (sebelumnya hanya 5) — termasuk 15 token pump Token-2022 yang
  sebelumnya terlewati, dengan simbol asli (`febu`, `SV151`, `AUTON`, `honse`, `HOTBOT`, dll).

### 4. Posisi LP Meteora DLMM (endpoint resmi)
- Endpoint lama `/wallet/open-positions` sudah **404**. Dipakai ulang setelah verifikasi live:
  `GET /portfolio/open?user=<wallet>&page=1&page_size=50`.
  Nilai `balances`/`unclaimedFees`/`outOfRange`/`listPositions` dipakai apa adanya — **PnL tidak
  dikarang**; kolom PnL memang tidak ada di respons.
- TVL pool via `GET /pools?filter_by=pool_address=` per pool (multi-pool `A|B` rusak di API),
  dibatasi ~1 request/33ms (rate limit 30 rps), gagal → null.
- Skema zod dibuat **longgar** karena live API mencampur tipe `string`/`number` untuk field yang
  tidak dipakai (`feePerTvl24h`, `updatedAt`, dsb) — field tak terpakai dilewatkan via `passthrough`.
- Hasil live tersimpan di `wallet_positions` (kind `lp`):
  `HOTBOT/SOL` nilai **$58.67**, fees $0.015, TVL pool **$108,033.96**, in-range, alamat posisi tercatat.

### 5. Posisi LP Meteora DAMM v2 (on-chain, tanpa API baru)
- Data API **tidak punya endpoint posisi per-wallet** (diverifikasi dari OpenAPI damm-v2).
- Posisi DAMM v2 adalah **NFT Token-2022**; dideteksi on-chain: `getTokenAccountsByOwner` (program
  Token-2022) → `getMultipleAccounts` → filter `mint.owner == cp_amm`
  (`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`).
- Program ID Token-2022 yang benar: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`.
- Hasil live untuk wallet utama: **15 akun Token-2022 ditemukan, 0 milik cp_amm** → tidak ada posisi
  DAMM v2 (hasil kosong yang jujur). Bila ada, nilainya sengaja dikosongkan (`—`) karena butuh decode
  IDL, **tidak dikarang**.

### 6. Tampilan LP + status provider
- Kartu wallet di Portofolio kini **hanya menampilkan LP & DeFi** (sub-tab Token/LP dihapus; token
  wallet tetap terwakili di Daftar Aset). Baris LP memuat pool, protokol, chain, wallet, TVL posisi,
  fees belum diklaim, TVL pool, dan status in/out range. Pesan kosong mengarahkan ke Daftar Aset.

### 7. Status wallet/provider di Akun & Bank
- Halaman Akun & Bank sudah menampilkan wallet + status sinkron (`sync_status` per provider, live,
  tertunda, atau error). Status terkini via `/api/wallets/status`:
  semua tier sukses (`price`/`lp`/`solana`/`evm` → `lastError: null`), DeBank belum dikonfigurasi.

### 8. Tabel responsive
- Seluruh page lolos cek tak ada scroll horizontal: `scrollW == lebar viewport` pada 360/390/768/1440
  (beranda, portofolio, transaksi, akun), bottom nav 4 item di mobile dan sidebar 4 item di desktop.

### 9. Verifikasi & laporan
- `npm run build` hijau; `npx tsc -p tsconfig.server.json` bersih.
- **79/79 test** lulus (`npm test`), termasuk tambahan baru: parse fixture DLMM `/portfolio/open`
  (2 pool, fee, in-range, tanpa PnL), 404 ter-kontrol, dedup dua mint ber-simbol sama, dan dedup
  by-symbol untuk aset tanpa mint.
- Server production di-restart ke build baru; tier-lp sudah hidup (dari "Semua provider data gagal").
- Screenshot tersimpan di `screenshots/` (dll `wallet-portofolio-1440.png` / `wallet-portofolio-1000.png`;
  4 page × 390/768/1440; probe 360px).

## Perubahan file

- `src/server/db/schema.sql` — kolom `chain` / `mint` di `assets`.
- `src/server/db/database.ts` — `runColumnMigrations` (ALTER guarded) + `backfillAssetMints`.
- `src/server/providers/tokenMeta.ts` — baru: resolver Jupiter verified → DexScreener → Gecko.
- `src/server/providers/solanaRpcFallback.ts` — tulis ulang: SPL + Token-2022 + SOL native + simbol asli.
- `src/server/providers/meteora.ts` — DLMM `/portfolio/open` + TVL per pool; DAMM v2 deteksi on-chain.
- `src/server/providers/fixtures/meteora.example.json` — fixture bentuk mentah `/portfolio/open`.
- `src/server/services/portfolioService.ts` — `WalletIndex{bySymbol,byMint}`, dedup by-mint,
  `chain`/`mint` pada aset, upsert COALESCE.
- `src/web/pages/portfolio.ts` — kartu wallet LP/DeFi-only, pesan empty, counts tanpa duplikat.
- `tests/walletProviders.test.ts`, `tests/portfolio.test.ts` — stub & fixture diperbarui + test dedup baru.
- `scripts/shot.mjs` — `NODE_ENV=production` pada spawn server (logger memakai `pino-pretty` hanya di dev).

## Catatan / batasan

- DeBank belum terisi API key: EVM mengikuti jalur Flasko/eksplorasi lama; Solana memakai fallback RPC
  (Jupiter v1 butuh `JUPITER_API_KEY`).
- Perubahan path DLMM bisa di-override via `METEORA_DLMM_BASE` / `METEORA_DLMM_PATH`; pesan error 404
  menunjukkan bagaimana menyesuaikan.
- Harga token kecil (debu) tetap ditampilkan (`Tampilkan semua`), nominal $ sangat kecil.
- Nilai posisi DAMM v2 sengaja dikosongkan (butuh decode IDL); tidak ada angka rekayasa.