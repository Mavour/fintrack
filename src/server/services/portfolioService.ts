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
});
export type UpsertAssetInput = z.infer<typeof UpsertAssetSchema>;

export interface Asset {
  id: number;
  type: AssetType;
  symbol: string;
  name: string;
  qty: string;
  avg_buy_price_idr: number;
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
      `INSERT INTO assets (type, symbol, name, qty, avg_buy_price_idr, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(symbol) DO UPDATE SET type = excluded.type, name = excluded.name,
         qty = excluded.qty, avg_buy_price_idr = excluded.avg_buy_price_idr,
         updated_at = datetime('now')`,
    ).run(parsed.type, parsed.symbol, parsed.name, parsed.qty, parsed.avg_buy_price_idr);
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
