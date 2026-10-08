import type Database from 'better-sqlite3';
import { z } from 'zod';
import { parseQty, qtyTimesPriceIdr, costBasis, plNominal, plPercent } from './money.js';
import { getCachedUsdIdr } from '../providers/fxRate.js';
import { Decimal } from 'decimal.js';

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
  price_idr: z.number().int().min(0).optional(),
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
}

export const STALE_THRESHOLD_MS = 15 * 60 * 1000;

export function upsertAsset(db: Database.Database, input: UpsertAssetInput): Asset {
  const parsed = UpsertAssetSchema.parse(input);
  const atomic = db.transaction(() => {
    db.prepare(
      `INSERT INTO assets (type, symbol, name, qty, avg_buy_price_idr, chain, mint, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(symbol) DO UPDATE SET type = excluded.type, name = excluded.name,
         qty = excluded.qty, avg_buy_price_idr = excluded.avg_buy_price_idr,
         chain = COALESCE(excluded.chain, assets.chain),
         mint = COALESCE(excluded.mint, assets.mint),
         updated_at = datetime('now')`,
    ).run(
      parsed.type, parsed.symbol, parsed.name, parsed.qty, parsed.avg_buy_price_idr,
      parsed.chain ?? null, parsed.mint ?? null,
    );
    if (parsed.price_idr !== undefined) {
      db.prepare(
        `INSERT INTO price_cache (symbol, price_idr, source, fetched_at)
         VALUES (?, ?, 'manual', datetime('now'))
         ON CONFLICT(symbol) DO UPDATE SET price_idr = excluded.price_idr,
           source = 'manual', fetched_at = datetime('now')`,
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
  const buyKnown = asset.avg_buy_price_idr > 0;
  const cost = buyKnown ? costBasis(asset.qty, asset.avg_buy_price_idr) : 0;
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
  const stale = nowMs - new Date(cached.fetched_at + 'Z').getTime() > STALE_THRESHOLD_MS;
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
  return listAssets(db, type).map((a) => valuateAsset(db, a));
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
}

export interface ManualAssetV extends AssetValuation {
  source: 'manual';
}

export interface UnifiedPortfolio {
  assets: ManualAssetV[];
  wallet_tokens: WalletTokenV[];
  /** Token wallet disembunyikan dari Portofolio (tanpa harga atau < $1).
   *  Daftarnya hanya tampil di Akun & Bank > Wallet. */
  hidden_tokens: number;
  total_value_idr: number;
  total_cost_idr: number;
  floating_pl_idr: number;
  by_type: Record<string, number>;
  cost_basis: Record<string, number>;
  diversification_score: number;
  diversification_label: string;
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
  const groups = new Map<string, { name: string; amount: InstanceType<typeof Decimal>; valueUsd: number | null; chains: Set<string>; wallets: Set<string> }>();
  try {
    const rows = db.prepare(
      `SELECT UPPER(wp.symbol) AS sym, wp.name, wp.amount, wp.value_usd, wp.chain_id, w.label AS label
       FROM wallet_positions wp JOIN wallets w ON w.id = wp.wallet_id
       WHERE wp.kind IN ('token','staking')`,
    ).all() as Array<{ sym: string; name: string; amount: string; value_usd: number | null; chain_id: string; label: string }>;
    for (const r of rows) {
      if (!groups.has(r.sym)) {
        groups.set(r.sym, { name: r.name, amount: new Decimal(0), valueUsd: null, chains: new Set(), wallets: new Set() });
      }
      const g = groups.get(r.sym)!;
      try {
        g.amount = g.amount.plus(parseQty(r.amount));
      } catch {
        // Qty rusak dilewati, nilai tetap dijumlah bila ada.
      }
      if (r.value_usd !== null && r.value_usd !== undefined) g.valueUsd = (g.valueUsd ?? 0) + r.value_usd;
      g.chains.add(r.chain_id);
      g.wallets.add(r.label || 'Wallet');
    }
  } catch {
    return { tokens: [], hiddenCount: 0 };
  }
  const out: WalletTokenV[] = [];
  let hiddenCount = 0;
  for (const [sym, g] of groups) {
    const amtNum = g.amount.toNumber();
    const hasValue = g.valueUsd !== null && g.valueUsd > 0;
    // Filter token: hanya posisi berharga DAN ≥ $1 yang tampil di Portofolio.
    // Tanpa harga atau debu (< $1) → tersembunyi (dihitung, daftar di Akun & Bank).
    if (!hasValue || (g.valueUsd as number) < minUsd) {
      hiddenCount++;
      continue;
    }
    const priceUsd = (g.valueUsd as number) / amtNum;
    const valueIdr = rate !== null && rate !== undefined ? Math.round((g.valueUsd as number) * rate) : null;
    const unitIdr = valueIdr !== null && amtNum > 0 ? Math.round(valueIdr / amtNum) : null;
    const buy = basis[sym];
    // P/L HANYA bila user mengisi cost basis. Tanpa itu: cost & P/L null → UI "-".
    const hasCost = buy !== undefined && buy !== null;
    const costIdr = hasCost ? Math.round(new Decimal(buy).times(g.amount).toNumber()) : null;
    const plIdr = hasCost && valueIdr !== null ? valueIdr - (costIdr ?? 0) : null;
    const plPct = hasCost && plIdr !== null && (costIdr ?? 0) > 0 ? (plIdr / (costIdr as number)) * 100 : null;
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
      cost_idr: costIdr,
      pl_idr: plIdr,
      pl_percent: plPct,
      has_cost: hasCost,
      chains: [...g.chains],
      wallets: [...g.wallets],
    });
  }
  return { tokens: out.sort((a, b) => (b.value_idr ?? 0) - (a.value_idr ?? 0)), hiddenCount };
}

export function getUnifiedPortfolio(db: Database.Database, type?: AssetType): UnifiedPortfolio {
  const vals = listValuations(db, type);
  const index = getWalletIndex(db);
  const basis = listCostBasis(db);
  syncSupersedeFlags(db, index);
  const assets: ManualAssetV[] = [];
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
    if (v.current_price_idr === null) continue;
    if (v.type === 'crypto' && !isLp && v.current_value_usd !== null && v.current_value_usd < 1) continue;
    assets.push({ ...v, source: 'manual' });
  }
  const wt = !type || type === 'crypto' ? getWalletTokens(db) : { tokens: [], hiddenCount: 0 };
  const walletTokens = wt.tokens;
  const hiddenTokens = wt.hiddenCount;

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

  // Diversifikasi dari baris yang dihitung (manual inklusi + token wallet).
  const divInput = [
    ...assets.map((a) => ({ current_value_idr: a.current_value_idr })),
    ...walletTokens.map((w) => ({ current_value_idr: w.value_idr })),
  ];
  const score = diversificationScore(divInput as AssetValuation[]);
  return {
    assets,
    wallet_tokens: walletTokens,
    hidden_tokens: hiddenTokens,
    total_value_idr: totalValue,
    total_cost_idr: totalCost,
    floating_pl_idr: plSum,
    by_type: byType,
    cost_basis: basis,
    diversification_score: score,
    diversification_label: diversificationLabel(score),
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
