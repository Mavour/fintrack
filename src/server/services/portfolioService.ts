import type Database from 'better-sqlite3';
import { z } from 'zod';
import { parseQty, qtyTimesPriceIdr, costBasis, plNominal, plPercent } from './money.js';
import { getCachedUsdIdr } from '../providers/fxRate.js';
import { readCachedIcons } from '../providers/tokenMeta.js';
import { Decimal } from 'decimal.js';
import { getLiveQuote, liveAssetId } from './liveCrypto.js';

export const AssetTypeSchema = z.enum(['crypto', 'saham', 'reksadana']);
export type AssetType = z.infer<typeof AssetTypeSchema>;

export const UpsertAssetSchema = z.object({
  type: AssetTypeSchema,
  symbol: z.string().min(1).max(20).transform((s) => s.toUpperCase().trim()),
  name: z.string().max(120).default(''),
  qty: z.string().min(1).max(40).refine(
    (v) => {
      try {
        parseQty(v);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid qty decimal string' },
  ),
  avg_buy_price_idr: z.number().int().min(0),
  total_cost_idr: z.number().int().min(0).nullable().optional(),
  price_idr: z.number().finite().min(0).optional(),
  /** Opsional: badge chain aset manual + kunci dedup by mint. */
  chain: z.string().trim().max(40).nullable().optional(),
  mint: z.string().trim().max(60).nullable().optional(),
});
export type UpsertAssetInput = z.infer<typeof UpsertAssetSchema>;

export interface Asset {
  id: number;
  type: AssetType;
  symbol: string;
  name: string;
  qty: string;
  avg_buy_price_idr: number;
  total_cost_idr?: number | null;
  chain: string | null;
  mint: string | null;
  superseded_by_wallet: number;
  created_at: string;
  updated_at: string;
}

export interface AssetValuation extends Asset {
  current_price_idr: number | null;
  current_value_idr: number | null;
  /** USD equivalents for crypto (converted with cached FX rate). Null when unavailable. */
  current_price_usd: number | null;
  current_value_usd: number | null;
  cost_idr: number;
  /** Null when buy price unknown (avg_buy_price_idr = 0) — P/L is hidden in UI. */
  pl_idr: number | null;
  pl_percent: number | null;
  price_source: string | null;
  price_fetched_at: string | null;
  is_stale: boolean;
  price_date?: string | null;
  daily_pl_idr?: number | null;
  daily_pl_percent?: number | null;
  daily_base_date?: string | null;
  price_mode?: 'stream' | 'periodic';
}

export const STALE_THRESHOLD_MS = 15 * 60 * 1000;

export function upsertAsset(db: Database.Database, input: UpsertAssetInput): Asset {
  const parsed = UpsertAssetSchema.parse(input);
  const atomic = db.transaction(() => {
    db.prepare(
      `INSERT INTO assets (type, symbol, name, qty, avg_buy_price_idr, total_cost_idr, chain, mint, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(symbol) DO UPDATE SET type = excluded.type, name = excluded.name,
         qty = excluded.qty, avg_buy_price_idr = excluded.avg_buy_price_idr,
         total_cost_idr = CASE WHEN ? THEN excluded.total_cost_idr ELSE assets.total_cost_idr END,
         chain = COALESCE(excluded.chain, assets.chain),
         mint = COALESCE(excluded.mint, assets.mint),
         updated_at = datetime('now')`,
    ).run(
      parsed.type, parsed.symbol, parsed.name, parsed.qty, parsed.avg_buy_price_idr, parsed.total_cost_idr ?? null,
      parsed.chain ?? null, parsed.mint ?? null, Number(parsed.total_cost_idr !== undefined),
    );
    if (parsed.price_idr !== undefined) {
      db.prepare(
        `INSERT INTO price_cache (symbol, price_idr, source, fetched_at)
         VALUES (?, ?, 'manual', datetime('now'))
         ON CONFLICT(symbol) DO UPDATE SET price_idr = excluded.price_idr,
           source = 'manual', price_date = NULL, fetched_at = datetime('now')`,
      ).run(parsed.symbol, parsed.price_idr);
    }
  });
  atomic();
  return getAssetBySymbol(db, parsed.symbol)!;
}

export function getAssetBySymbol(db: Database.Database, symbol: string): Asset | undefined {
  return db.prepare('SELECT * FROM assets WHERE symbol = ?').get(symbol) as Asset | undefined;
}

export function listAssets(db: Database.Database, type?: AssetType): Asset[] {
  if (type) return db.prepare('SELECT * FROM assets WHERE type = ? ORDER BY symbol').all(type) as Asset[];
  return db.prepare('SELECT * FROM assets ORDER BY type, symbol').all() as Asset[];
}

export function deleteAsset(db: Database.Database, symbol: string): void {
  const info = db.prepare('DELETE FROM assets WHERE symbol = ?').run(symbol);
  if (info.changes === 0) throw Object.assign(new Error('Asset not found'), { statusCode: 404 });
}

export function valuateAsset(
  db: Database.Database,
  asset: Asset,
  nowMs = Date.now(),
): AssetValuation {
  const cached = db.prepare('SELECT * FROM price_cache WHERE symbol = ?').get(asset.symbol) as
    | { price_idr: number; source: string; fetched_at: string }
    | undefined;
  // avg_buy_price_idr = 0 means "unknown" (user forgot) -> hide P/L instead of showing nonsense.
  const buyKnown = asset.total_cost_idr != null || asset.avg_buy_price_idr > 0;
  const cost = asset.total_cost_idr ?? (buyKnown ? costBasis(asset.qty, asset.avg_buy_price_idr) : 0);
  const toUsd = (priceIdr: number | null): number | null => {
    if (priceIdr === null || asset.type !== 'crypto') return null;
    const rate = getCachedUsdIdr(db);
    if (!rate) return null;
    return new Decimal(priceIdr).div(rate).toNumber();
  };
  if (!cached) {
    return {
      ...asset,
      current_price_idr: null,
      current_value_idr: null,
      current_price_usd: null,
      current_value_usd: null,
      cost_idr: cost,
      pl_idr: null,
      pl_percent: null,
      price_source: null,
      price_fetched_at: null,
      is_stale: true,
    };
  }
  const currentValue = qtyTimesPriceIdr(asset.qty, cached.price_idr);
  const priceUsd = toUsd(cached.price_idr);
  const valueUsd = priceUsd === null ? null : parseQty(asset.qty).times(priceUsd).toNumber();
  const stale = nowMs - new Date(cached.fetched_at + 'Z').getTime() > (asset.type === 'crypto' ? STALE_THRESHOLD_MS : 4 * 86400_000);
  return {
    ...asset,
    current_price_idr: cached.price_idr,
    current_value_idr: currentValue,
    current_price_usd: priceUsd,
    current_value_usd: valueUsd,
    cost_idr: cost,
    pl_idr: buyKnown ? plNominal(currentValue, cost) : null,
    pl_percent: buyKnown ? plPercent(currentValue, cost) : null,
    price_source: cached.source,
    price_fetched_at: cached.fetched_at,
    is_stale: stale,
  };
}

export function listValuations(db: Database.Database, type?: AssetType): AssetValuation[] {
  const assets = listAssets(db, type);
  if (assets.length === 0) return [];
  // Batch: 1 query price_cache + 1 query fx (hindari N+1 2N+1 query).
  const symbols = [...new Set(assets.map((a) => a.symbol))];
  const priceMap = new Map<string, { price_idr: number; source: string; fetched_at: string; price_date: string | null }>();
  for (let i = 0; i < symbols.length; i += 200) {
    const chunk = symbols.slice(i, i + 200);
    const found = db.prepare(`SELECT symbol, price_idr, source, fetched_at, price_date FROM price_cache WHERE symbol IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ symbol: string; price_idr: number; source: string; fetched_at: string; price_date: string | null }>;
    for (const f of found) priceMap.set(f.symbol, f);
  }
  const rate = getCachedUsdIdr(db);
  const nowMs = Date.now();
  const mappedIds = new Map((db.prepare("SELECT symbol, provider_id FROM asset_map WHERE provider = 'coingecko'").all() as Array<{ symbol: string; provider_id: string }>).map((r) => [r.symbol, r.provider_id]));
  return assets.map((a) => {
    let cached = priceMap.get(a.symbol);
    const liveId = a.mint ? liveAssetId(a.chain ?? '', { mint: a.mint }) : mappedIds.get(a.symbol) ?? null;
    const live = a.type === 'crypto' ? getLiveQuote(liveId) : null;
    if (live && rate) cached = { price_idr: live.price * rate, source: live.source, fetched_at: new Date(live.at).toISOString().slice(0, 19).replace('T', ' '), price_date: null };
    const value = valuateAssetCached(a, cached, rate, nowMs);
    if (a.type === 'crypto') return { ...value, price_mode: live && rate ? 'stream' : 'periodic' };
    const day = cached?.price_date;
    const previous = day ? db.prepare(`SELECT price_idr, date(fetched_at) AS day FROM price_history
      WHERE symbol = ? AND fetched_at < ? ORDER BY fetched_at DESC LIMIT 1`).get(a.symbol, `${day} 00:00:00`) as
      { price_idr: number; day: string } | undefined : undefined;
    const daily = previous && cached ? parseQty(a.qty).times(new Decimal(cached.price_idr).minus(previous.price_idr)) : null;
    return {
      ...value, price_date: day ?? null,
      is_stale: value.is_stale || (!!day && nowMs - Date.parse(day) > 4 * 86400_000),
      daily_pl_idr: daily?.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber() ?? null,
      daily_pl_percent: previous && cached && previous.price_idr > 0 ? plPercent(cached.price_idr, previous.price_idr) : null,
      daily_base_date: previous?.day ?? null,
    };
  });
}

function valuateAssetCached(
  asset: Asset,
  cached: { price_idr: number; source: string; fetched_at: string } | undefined,
  rate: number | null,
  nowMs: number,
): AssetValuation {
  const buyKnown = asset.total_cost_idr != null || asset.avg_buy_price_idr > 0;
  const cost = asset.total_cost_idr ?? (buyKnown ? costBasis(asset.qty, asset.avg_buy_price_idr) : 0);
  if (!cached) {
    return {
      ...asset,
      current_price_idr: null,
      current_value_idr: null,
      current_price_usd: null,
      current_value_usd: null,
      cost_idr: cost,
      pl_idr: null,
      pl_percent: null,
      price_source: null,
      price_fetched_at: null,
      is_stale: true,
    };
  }
  const currentValue = qtyTimesPriceIdr(asset.qty, cached.price_idr);
  const priceUsd = asset.type !== 'crypto' || !rate ? null : new Decimal(cached.price_idr).div(rate).toNumber();
  const valueUsd = priceUsd === null ? null : parseQty(asset.qty).times(priceUsd).toNumber();
  const stale = nowMs - new Date(cached.fetched_at + 'Z').getTime() > (asset.type === 'crypto' ? STALE_THRESHOLD_MS : 4 * 86400_000);
  return {
    ...asset,
    current_price_idr: cached.price_idr,
    current_value_idr: currentValue,
    current_price_usd: priceUsd,
    current_value_usd: valueUsd,
    cost_idr: cost,
    pl_idr: buyKnown ? plNominal(currentValue, cost) : null,
    pl_percent: buyKnown ? plPercent(currentValue, cost) : null,
    price_source: cached.source,
    price_fetched_at: cached.fetched_at,
    is_stale: stale,
  };
}

// ---------------------------------------------------------------------------
// Cost basis wallet (tabel terpisah): P/L token wallet HANYA bila ada baris.
// ---------------------------------------------------------------------------

export const CostBasisSchema = z.object({
  symbol: z.string().min(1).max(40).transform((s) => s.toUpperCase().trim()),
  buy_price_idr: z.number().int().min(0),
});

export function getCostBasis(db: Database.Database, symbol: string): number | null {
  try {
    const row = db.prepare('SELECT buy_price_idr FROM cost_basis WHERE symbol = ?').get(symbol.toUpperCase()) as
      | { buy_price_idr: number }
      | undefined;
    return row?.buy_price_idr ?? null;
  } catch {
    return null;
  }
}

export function setCostBasis(db: Database.Database, symbol: string, buyPriceIdr: number): { symbol: string; buy_price_idr: number } {
  const parsed = CostBasisSchema.parse({ symbol, buy_price_idr: buyPriceIdr });
  db.prepare(
    `INSERT INTO cost_basis (symbol, buy_price_idr, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET buy_price_idr = excluded.buy_price_idr, updated_at = datetime('now')`,
  ).run(parsed.symbol, parsed.buy_price_idr);
  return { symbol: parsed.symbol, buy_price_idr: parsed.buy_price_idr };
}

export function deleteCostBasis(db: Database.Database, symbol: string): void {
  const info = db.prepare('DELETE FROM cost_basis WHERE symbol = ?').run(symbol.toUpperCase());
  if (info.changes === 0) throw Object.assign(new Error('Cost basis not found'), { statusCode: 404 });
}

export function listCostBasis(db: Database.Database): Record<string, number> {
  try {
    const rows = db.prepare('SELECT symbol, buy_price_idr FROM cost_basis').all() as Array<{
      symbol: string;
      buy_price_idr: number;
    }>;
    return Object.fromEntries(rows.map((r) => [r.symbol, r.buy_price_idr]));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Portofolio terpadu: aset manual + token wallet (read-only).
// Aset manual crypto yang simbolnya juga ada di wallet = duplikat →
// ditandai dan DIKECUALIKAN dari total (tidak dihapus otomatis).
// ---------------------------------------------------------------------------

export interface WalletTokenV {
  price_mode?: 'stream' | 'periodic' | 'mixed';
  price_source?: string;
  asset_key?: string;
  source: 'wallet';
  type: 'crypto';
  symbol: string;
  name: string;
  amount: string;
  price_usd: number | null;
  value_usd: number | null;
  price_idr: number | null;
  value_idr: number | null;
  cost_idr: number | null;
  pl_idr: number | null;
  pl_percent: number | null;
  has_cost: boolean;
  chains: string[];
  wallets: string[];
  /** Alamat per wallet (sejajar dengan `wallets`, untuk link detail onchain). */
  wallet_addrs: string[];
  /** Mint representatif (untuk logo). Null bila tak diketahui. */
  mint: string | null;
  /** URL logo resmi (Jupiter verified → DexScreener). Null = frontend fallback. */
  icon: string | null;
}

/** Limit order / posisi DeFi wallet (kind='defi'): dana dikunci di order. */
export interface DefiV {
  source: 'wallet';
  type: 'crypto';
  symbol: string;
  name: string;
  amount: string;
  price_usd: number | null;
  value_usd: number | null;
  price_idr: number | null;
  value_idr: number | null;
  output_symbol: string | null;
  order_side?: 'input' | 'output';
  filled_pct: number | null;
  protocol: string;
  chains: string[];
  wallets: string[];
  /** Rincian per wallet pembentuk baris gabungan (untuk popup). */
  breakdown: Array<{
    wallet: string;
    address: string;
    amount: string;
    value_usd: number | null;
    value_idr: number | null;
    filled_pct: number | null;
  }>;
}

export interface ManualAssetV extends AssetValuation {
  source: 'manual';
  /** URL logo resmi bila mint dikenal. Null = frontend fallback. */
  icon: string | null;
}

export interface UnifiedPortfolio {
  unpriced_manual_assets: number;
  assets: ManualAssetV[];
  wallet_tokens: WalletTokenV[];
  /** Token wallet disembunyikan dari Portofolio (tanpa harga atau < $1).
   *  Daftarnya hanya tampil di Akun & Bank > Wallet. */
  hidden_tokens: number;
  /** Limit order / DeFi wallet (terpisah dari token agar terlihat sebagai order). */
  wallet_defi: DefiV[];
  total_value_idr: number;
  total_cost_idr: number;
  floating_pl_idr: number;
  by_type: Record<string, number>;
  cost_basis: Record<string, number>;
  diversification_score: number;
  diversification_label: string;
  /** Nilai posisi LP & DeFi wallet (sudah termasuk di total_value_idr). */
  lp_value_idr: number;
  /** Fees LP belum diklaim (bagian dari lp_value_idr). */
  lp_fees_idr: number;
}

export interface WalletMatch {
  chains: string[];
  labels: string[];
}

export interface WalletIndex {
  /** Simbol UPPER -> wallet match. */
  bySymbol: Map<string, WalletMatch>;
  /** Mint (address/contract) -> wallet match. Lebih tepat untuk dedup. */
  byMint: Map<string, WalletMatch>;
}

/** Parse meta JSON tabel wallet_positions dengan aman. */
function metaJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Indeks posisi wallet (token/staking) per simbol UPPER DAN per mint. */
export function getWalletIndex(db: Database.Database): WalletIndex {
  const bySymbol = new Map<string, { chains: Set<string>; labels: Set<string> }>();
  const byMint = new Map<string, { chains: Set<string>; labels: Set<string> }>();
  try {
    const rows = db.prepare(
      `SELECT UPPER(wp.symbol) AS sym, wp.chain_id, wp.meta, w.label AS label
       FROM wallet_positions wp JOIN wallets w ON w.id = wp.wallet_id
       WHERE wp.kind IN ('token','staking')`,
    ).all() as Array<{ sym: string; chain_id: string; meta: string; label: string }>;
    for (const r of rows) {
      if (!bySymbol.has(r.sym)) bySymbol.set(r.sym, { chains: new Set(), labels: new Set() });
      bySymbol.get(r.sym)!.chains.add(r.chain_id);
      bySymbol.get(r.sym)!.labels.add(r.label || 'Wallet');
      const mint = metaJson(r.meta).mint;
      if (typeof mint === 'string' && mint) {
        if (!byMint.has(mint)) byMint.set(mint, { chains: new Set(), labels: new Set() });
        byMint.get(mint)!.chains.add(r.chain_id);
        byMint.get(mint)!.labels.add(r.label || 'Wallet');
      }
    }
  } catch {
    // Tabel belum ada (DB lama) — anggap tidak ada posisi wallet.
  }
  const toWalletMatch = (m: Map<string, { chains: Set<string>; labels: Set<string> }>): Map<string, WalletMatch> =>
    new Map([...m].map(([k, v]) => [k, { chains: [...v.chains], labels: [...v.labels] }]));
  return { bySymbol: toWalletMatch(bySymbol), byMint: toWalletMatch(byMint) };
}

/** Manual aset crypto yang sama dengan posisi wallet (chain + simbol/mint
 * sama) ditandai `superseded_by_wallet` di DB. Dipanggil tiap
 * `getUnifiedPortfolio` supaya selalu sinkron: saat wallet dihapus, flag
 * turun dan aset manual kembali tampil. Baris tak berubah = tidak ditulis. */
export function syncSupersedeFlags(db: Database.Database, index: WalletIndex): void {
  const rows = db.prepare(
    `SELECT symbol, type, chain, mint, superseded_by_wallet FROM assets`,
  ).all() as Array<{ symbol: string; type: string; chain: string | null; mint: string | null; superseded_by_wallet: number }>;
  const update = db.prepare('UPDATE assets SET superseded_by_wallet = ? WHERE symbol = ?');
  for (const r of rows) {
    if (r.type !== 'crypto') continue;
    const mintMatch = r.mint ? index.byMint.get(r.mint) : undefined;
    const symMatch = !mintMatch ? index.bySymbol.get(r.symbol.toUpperCase()) : undefined;
    const chainOk = !symMatch || !r.chain || symMatch.chains.includes(r.chain);
    const flag = mintMatch || (symMatch && chainOk) ? 1 : 0;
    if (Number(r.superseded_by_wallet) !== flag) update.run(flag, r.symbol);
  }
}

/** Agregasi token wallet per simbol lintas wallet (detail per wallet tetap ada). */
export function getWalletTokens(
  db: Database.Database,
  opts: { minUsd?: number } = {},
): { tokens: WalletTokenV[]; hiddenCount: number } {
  const rate = getCachedUsdIdr(db);
  const basis = listCostBasis(db);
  const minUsd = opts.minUsd ?? 1;
  const groups = new Map<string, { symbol: string; name: string; amount: InstanceType<typeof Decimal>; valueUsd: number | null; chains: Set<string>; wallets: Set<string>; mint: string | null; addrByLabel: Map<string, string>; streamed: number; periodic: number }>();
  try {
    const rows = db.prepare(
      `SELECT UPPER(wp.symbol) AS sym, wp.name, wp.amount, wp.value_usd, wp.chain_id, wp.meta, w.label AS label, w.address AS address
       FROM wallet_positions wp JOIN wallets w ON w.id = wp.wallet_id
       WHERE wp.kind IN ('token','staking')`,
    ).all() as Array<{ sym: string; name: string; amount: string; value_usd: number | null; chain_id: string; meta: string; label: string; address: string }>;
    for (const r of rows) {
      const contract = metaJson(r.meta).token_id;
      // Robinhood has many unrelated airdrops impersonating USDG. Never mix
      // their quantities/cost basis with the real contract merely by ticker.
      const key = r.chain_id === 'robinhood' && typeof contract === 'string' && /^0x[\da-f]{40}$/i.test(contract)
        ? `${r.sym}:robinhood:${contract.toLowerCase()}` : r.sym;
      if (!groups.has(key)) {
        groups.set(key, { symbol: r.sym, name: r.name, amount: new Decimal(0), valueUsd: null, chains: new Set(), wallets: new Set(), mint: null, addrByLabel: new Map(), streamed: 0, periodic: 0 });
      }
      const g = groups.get(key)!;
      try {
        g.amount = g.amount.plus(parseQty(r.amount));
      } catch {
        // Qty rusak dilewati, nilai tetap dijumlah bila ada.
      }
      const live = getLiveQuote(liveAssetId(r.chain_id, metaJson(r.meta)));
      let rowValue = r.value_usd;
      if (live) {
        try { rowValue = parseQty(r.amount).times(live.price).toNumber(); g.streamed++; }
        catch { g.periodic++; }
      } else g.periodic++;
      if (rowValue !== null && rowValue !== undefined) g.valueUsd = (g.valueUsd ?? 0) + rowValue;
      if (!g.mint) {
        try {
          const m = (JSON.parse(r.meta) as Record<string, unknown>)?.mint;
          if (typeof m === 'string' && m.length > 0) g.mint = m;
        } catch {
          // Meta rusak diabaikan.
        }
      }
      g.chains.add(r.chain_id);
      g.wallets.add(r.label || 'Wallet');
      if (!g.addrByLabel.has(r.label || 'Wallet') && r.address) g.addrByLabel.set(r.label || 'Wallet', r.address);
    }
  } catch {
    return { tokens: [], hiddenCount: 0 };
  }
  const icons = readCachedIcons(db, [...groups.values()].map((g) => g.mint).filter((m): m is string => !!m));
  const out: WalletTokenV[] = [];
  let hiddenCount = 0;
  for (const [key, g] of groups) {
    const sym = g.symbol;
    const amtNum = g.amount.toNumber();
    const hasValue = g.valueUsd !== null && g.valueUsd > 0;
    // Filter token: hanya posisi berharga DAN ≥ $1 yang tampil di Portofolio.
    // Tanpa harga atau debu (< $1) → tersembunyi (dihitung, daftar di Akun & Bank).
    if (!hasValue || (g.valueUsd as number) < minUsd) {
      hiddenCount++;
      continue;
    }
    const priceUsd = new Decimal(g.valueUsd as number).div(amtNum).toNumber();
    const valueIdr = rate !== null && rate !== undefined ? new Decimal(g.valueUsd as number).times(rate).toDecimalPlaces(0, 4).toNumber() : null;
    const unitIdr = valueIdr !== null && amtNum > 0 ? new Decimal(valueIdr).div(amtNum).toDecimalPlaces(0, 4).toNumber() : null;
    const buy = key === sym ? basis[sym] : undefined;
    // P/L HANYA bila user mengisi cost basis. Tanpa itu: cost & P/L null → UI "-".
    const hasCost = buy !== undefined && buy !== null;
    const costIdr = hasCost ? Math.round(new Decimal(buy).times(g.amount).toNumber()) : null;
    const plIdr = hasCost && valueIdr !== null ? valueIdr - (costIdr ?? 0) : null;
    const plPct = hasCost && plIdr !== null && (costIdr ?? 0) > 0 ? (plIdr / (costIdr as number)) * 100 : null;
    out.push({
      ...(key === sym ? {} : { asset_key: key }),
      source: 'wallet',
      type: 'crypto',
      symbol: sym,
      name: g.name,
      amount: g.amount.toString(),
      price_usd: priceUsd,
      value_usd: g.valueUsd,
      price_idr: unitIdr,
      value_idr: valueIdr,
      cost_idr: costIdr,
      pl_idr: plIdr,
      pl_percent: plPct,
      has_cost: hasCost,
      price_mode: g.streamed ? (g.periodic ? 'mixed' : 'stream') : 'periodic',
      price_source: g.streamed ? 'binance-stream-usdt' : 'wallet-provider',
      chains: [...g.chains],
      wallets: [...g.wallets],
      wallet_addrs: [...g.wallets].map((l) => g.addrByLabel.get(l) ?? ''),
      mint: g.mint,
      icon: g.mint ? (icons.get(g.mint) ?? null) : null,
    });
  }
  return { tokens: out.sort((a, b) => (b.value_idr ?? 0) - (a.value_idr ?? 0)), hiddenCount };
}

/** Agregasi posisi DeFi wallet (limit order dkk) per pair per arah.
 *  Satu baris = satu pair input→output lintas wallet; klik baris membuka
 *  popup rincian per wallet (breakdown). TIDAK digabung by simbol input:
 *  semua order USDC→X akan lenyap maknanya bila disatukan jadi "USDC". */
export function getWalletDefi(
  db: Database.Database,
  opts: { minUsd?: number } = {},
): { tokens: DefiV[]; hiddenCount: number } {
  const rate = getCachedUsdIdr(db);
  const minUsd = opts.minUsd ?? 1;
  const groups = new Map<
    string,
    {
      name: string; amount: InstanceType<typeof Decimal>; valueUsd: number | null;
      output: string | null; side: 'input' | 'output'; filled: { sum: number; weight: number } | null; protocol: string;
      chains: Set<string>; wallets: Set<string>; symbol: string;
      parts: Array<{ wallet: string; address: string; amount: string; valueUsd: number | null; filled: number | null }>;
    }
  >();
  try {
    const rows = db.prepare(
      `SELECT UPPER(wp.symbol) AS sym, wp.name, wp.amount, wp.value_usd, wp.chain_id,
              wp.protocol, wp.meta, w.label AS label, w.address AS address
       FROM wallet_positions wp JOIN wallets w ON w.id = wp.wallet_id
       WHERE wp.kind = 'defi'`,
    ).all() as Array<{
      sym: string; name: string; amount: string; value_usd: number | null;
      chain_id: string; protocol: string; meta: string; label: string; address: string;
    }>;
    for (const r of rows) {
      const m = metaJson(r.meta);
      const outSym = typeof m.output_symbol === 'string' && m.output_symbol ? m.output_symbol.toUpperCase() : '?';
      const side = m.order_side === 'output' ? 'output' : 'input';
      // Kunci per pair input→output lintas wallet (popup memecah per wallet).
      const key = `${r.chain_id}::${r.protocol}::${r.sym}::${outSym}::${side}`;
      if (!groups.has(key)) {
        groups.set(key, {
          name: r.name, amount: new Decimal(0), valueUsd: null,
          output: outSym === '?' ? null : outSym, side, filled: null, protocol: r.protocol,
          chains: new Set(), wallets: new Set(), symbol: r.sym, parts: [],
        });
      }
      const g = groups.get(key)!;
      let partAmt = '0';
      try {
        const q = parseQty(r.amount);
        g.amount = g.amount.plus(q);
        partAmt = q.toString();
      } catch {
        // Qty rusak dilewati, nilai tetap dijumlah bila ada.
      }
      if (r.value_usd !== null && r.value_usd !== undefined) g.valueUsd = (g.valueUsd ?? 0) + r.value_usd;
      const filled = typeof m.filled_pct === 'number' ? m.filled_pct : null;
      if (filled !== null) {
        // Rata-rata tertimbang nilai (order lebih besar lebih menentukan).
        const w = r.value_usd ?? 0;
        g.filled = { sum: (g.filled?.sum ?? 0) + filled * w, weight: (g.filled?.weight ?? 0) + w };
      }
      g.parts.push({
        wallet: r.label || 'Wallet',
        address: r.address ?? '',
        amount: partAmt,
        valueUsd: r.value_usd ?? null,
        filled,
      });
      g.chains.add(r.chain_id);
      g.wallets.add(r.label || 'Wallet');
    }
  } catch {
    return { tokens: [], hiddenCount: 0 };
  }
  const out: DefiV[] = [];
  let hiddenCount = 0;
  for (const g of groups.values()) {
    const sym = g.symbol;
    const amtNum = g.amount.toNumber();
    const hasValue = g.valueUsd !== null && g.valueUsd > 0;
    if (!hasValue || (g.valueUsd as number) < minUsd) {
      hiddenCount++;
      continue;
    }
    const priceUsd = new Decimal(g.valueUsd as number).div(amtNum).toNumber();
    const valueIdr = rate !== null && rate !== undefined ? new Decimal(g.valueUsd as number).times(rate).toDecimalPlaces(0, 4).toNumber() : null;
    const unitIdr = valueIdr !== null && amtNum > 0 ? new Decimal(valueIdr).div(amtNum).toDecimalPlaces(0, 4).toNumber() : null;
    const idrOf = (v: number | null): number | null =>
      v !== null && rate !== null && rate !== undefined ? new Decimal(v).times(rate).toDecimalPlaces(0, 4).toNumber() : null;
    out.push({
      source: 'wallet',
      type: 'crypto',
      symbol: sym,
      name: g.name,
      amount: g.amount.toString(),
      price_usd: priceUsd,
      value_usd: g.valueUsd,
      price_idr: unitIdr,
      value_idr: valueIdr,
      output_symbol: g.output,
      order_side: g.side,
      filled_pct: g.filled && g.filled.weight > 0 ? g.filled.sum / g.filled.weight : null,
      protocol: g.protocol,
      chains: [...g.chains],
      wallets: [...g.wallets],
      breakdown: g.parts.map((p) => ({
        wallet: p.wallet,
        address: p.address,
        amount: p.amount,
        value_usd: p.valueUsd,
        value_idr: idrOf(p.valueUsd),
        filled_pct: p.filled,
      })),
    });
  }
  return { tokens: out.sort((a, b) => (b.value_idr ?? 0) - (a.value_idr ?? 0)), hiddenCount };
}

export function getUnifiedPortfolio(db: Database.Database, type?: AssetType, opts: { readOnly?: boolean } = {}): UnifiedPortfolio {
  const vals = listValuations(db, type);
  const index = getWalletIndex(db);
  const basis = listCostBasis(db);
  if (!opts.readOnly) syncSupersedeFlags(db, index);
  const manualIcons = readCachedIcons(
    db,
    vals.filter((v) => v.type === 'crypto' && !!v.mint).map((v) => v.mint as string),
  );
  const assets: ManualAssetV[] = [];
  let unpricedManualAssets = 0;
  for (const v of vals) {
    // Duplikat: manual sama dengan posisi wallet (chain + mint/simbol sama) →
    // disembunyikan total (tanpa badge/tombol Hapus/teks "dikecualikan").
    const mintMatch = v.type === 'crypto' && v.mint ? index.byMint.get(v.mint) : undefined;
    const symMatch = !mintMatch && v.type === 'crypto' ? index.bySymbol.get(v.symbol.toUpperCase()) : undefined;
    const chainOk = !symMatch || !v.chain || symMatch.chains.includes(v.chain);
    const superseded = v.type === 'crypto' && !!(mintMatch || (symMatch && chainOk));
    if (superseded) continue;
    // Filter token: wajib ada harga; crypto bernilai ≥ $1 (LP legacy dikecualikan).
    const isLp = v.symbol.startsWith('LP-');
    if (v.current_price_idr === null) {
      if (new Decimal(v.qty).gt(0)) unpricedManualAssets++;
      continue;
    }
    if (v.type === 'crypto' && !isLp && v.current_value_usd !== null && v.current_value_usd < 1) continue;
    assets.push({ ...v, source: 'manual', icon: v.mint ? (manualIcons.get(v.mint) ?? null) : null });
  }
  const wt = !type || type === 'crypto' ? getWalletTokens(db) : { tokens: [], hiddenCount: 0 };
  const walletTokens = wt.tokens;
  let hiddenTokens = wt.hiddenCount;
  const defi = !type || type === 'crypto' ? getWalletDefi(db) : { tokens: [], hiddenCount: 0 };
  const walletDefi = defi.tokens;
  hiddenTokens += defi.hiddenCount;

  let totalValue = 0;
  let totalCost = 0;
  let plSum = 0;
  const byType: Record<string, number> = {};
  const add = (t: string, v: number | null, c: number | null, p: number | null): void => {
    totalValue += v ?? 0;
    totalCost += c ?? 0;
    if (p !== null && p !== undefined) plSum += p;
    byType[t] = (byType[t] ?? 0) + (v ?? 0);
  };
  for (const a of assets) {
    add(a.type, a.current_value_idr, a.cost_idr, a.pl_idr);
  }
  for (const w of walletTokens) {
    add('crypto', w.value_idr, w.cost_idr, w.pl_idr);
  }
  for (const d of walletDefi) {
    // Dana dikunci di order: masuk total & bucket crypto, tanpa modal/P/L.
    add('crypto', d.value_idr, null, null);
  }
  // LP & DeFi wallet (tabel lp_positions) ikut total — sebelumnya hilang dari
  // Total Investasi. Masuk bucket crypto. Cost tidak diketahui → P/L LP = null
  // (tidak menambah modal maupun P/L, hanya nilai).
  let lpValueIdr = 0;
  let lpFeesIdr = 0;
  if (!type || type === 'crypto') {
    try {
      const lp = db.prepare(
        `SELECT COALESCE(SUM(COALESCE(position_value_usd,0)),0) AS v,
                COALESCE(SUM(COALESCE(unclaimed_fees_usd,0)),0) AS f
         FROM lp_positions`,
      ).get() as { v: number; f: number };
      const rate = getCachedUsdIdr(db);
      if (rate) {
        lpValueIdr = Math.round((lp.v + lp.f) * rate);
        lpFeesIdr = Math.round(lp.f * rate);
      }
    } catch {
      // Tabel belum ada (DB lama) — LP dianggap nol.
    }
    totalValue += lpValueIdr;
    byType.crypto = (byType.crypto ?? 0) + lpValueIdr;
  }

  // Diversifikasi dari baris yang dihitung (manual inklusi + token wallet + LP).
  const divInput = [
    ...assets.map((a) => ({ current_value_idr: a.current_value_idr })),
    ...walletTokens.map((w) => ({ current_value_idr: w.value_idr })),
    ...walletDefi.map((d) => ({ current_value_idr: d.value_idr })),
    ...(lpValueIdr > 0 ? [{ current_value_idr: lpValueIdr }] : []),
  ];
  const score = diversificationScore(divInput as AssetValuation[]);
  return {
    unpriced_manual_assets: unpricedManualAssets,
    assets,
    wallet_tokens: walletTokens,
    hidden_tokens: hiddenTokens,
    wallet_defi: walletDefi,
    total_value_idr: totalValue,
    total_cost_idr: totalCost,
    floating_pl_idr: plSum,
    by_type: byType,
    cost_basis: basis,
    diversification_score: score,
    diversification_label: diversificationLabel(score),
    lp_value_idr: lpValueIdr,
    lp_fees_idr: lpFeesIdr,
  };
}

/** Diversification score 0-100 based on normalized Shannon entropy of asset weights.
 *  Evenly spread assets score high; a single dominant asset scores low. */
export function diversificationScore(valuations: AssetValuation[]): number {
  const withValue = valuations.filter((v) => (v.current_value_idr ?? 0) > 0);
  if (withValue.length <= 1) return 0;
  const total = withValue.reduce((s, v) => s + (v.current_value_idr ?? 0), 0);
  if (total <= 0) return 0;
  let entropy = 0;
  for (const v of withValue) {
    const w = (v.current_value_idr ?? 0) / total;
    if (w > 0) entropy -= w * Math.log(w);
  }
  return Math.round((entropy / Math.log(withValue.length)) * 100);
}

/** Indonesian label for a diversification score. */
export function diversificationLabel(score: number): string {
  if (score <= 20) return 'Sangat terpusat';
  if (score <= 40) return 'Terpusat';
  if (score <= 60) return 'Cukup merata';
  if (score <= 80) return 'Baik';
  return 'Sangat baik';
}
