import type Database from 'better-sqlite3';
import { z } from 'zod';
import { parseQty, qtyTimesPriceIdr, costBasis, plNominal, plPercent } from './money.js';

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
  cost_idr: number;
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
  const cost = costBasis(asset.qty, asset.avg_buy_price_idr);
  if (!cached) {
    return {
      ...asset,
      current_price_idr: null,
      current_value_idr: null,
      cost_idr: cost,
      pl_idr: null,
      pl_percent: null,
      price_source: null,
      price_fetched_at: null,
      is_stale: true,
    };
  }
  const currentValue = qtyTimesPriceIdr(asset.qty, cached.price_idr);
  const pl = plNominal(currentValue, cost);
  const stale = nowMs - new Date(cached.fetched_at + 'Z').getTime() > STALE_THRESHOLD_MS;
  return {
    ...asset,
    current_price_idr: cached.price_idr,
    current_value_idr: currentValue,
    cost_idr: cost,
    pl_idr: pl,
    pl_percent: plPercent(currentValue, cost),
    price_source: cached.source,
    price_fetched_at: cached.fetched_at,
    is_stale: stale,
  };
}

export function listValuations(db: Database.Database, type?: AssetType): AssetValuation[] {
  return listAssets(db, type).map((a) => valuateAsset(db, a));
}

/** Diversification score 0-100: based on Herfindahl across asset types + count. */
export function diversificationScore(valuations: AssetValuation[]): number {
  const withValue = valuations.filter((v) => (v.current_value_idr ?? 0) > 0);
  if (withValue.length === 0) return 0;
  const total = withValue.reduce((s, v) => s + (v.current_value_idr ?? 0), 0);
  const byType = new Map<string, number>();
  for (const v of withValue) byType.set(v.type, (byType.get(v.type) ?? 0) + (v.current_value_idr ?? 0));
  let hhi = 0;
  for (const val of byType.values()) {
    const share = val / total;
    hhi += share * share;
  }
  // HHI 1/n..1 -> score inverted to 0..100. Bonus for holding >=3 assets.
  const n = byType.size;
  const base = n <= 1 ? 0 : ((1 - hhi) / (1 - 1 / n)) * 100;
  const bonus = Math.min(withValue.length * 2, 10);
  return Math.round(Math.min(100, base * 0.9 + bonus));
}
