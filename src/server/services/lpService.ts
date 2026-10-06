import type Database from 'better-sqlite3';
import { z } from 'zod';
import { fetchJupiterLp, lpSymbol, type LpPosition } from '../providers/jupiterPositions.js';
import { createFxRateProvider } from '../providers/fxRate.js';
import { upsertAsset } from './portfolioService.js';
import { storePrices } from '../providers/priceStore.js';
import { logger } from '../logger.js';

export const LpPreviewQuery = z.object({
  address: z.string().min(32).max(44),
});

export interface LpPreview extends LpPosition {
  symbol: string;
  already_tracked: boolean;
}

export async function previewLp(db: Database.Database, address: string): Promise<LpPreview[]> {
  const { address: a } = LpPreviewQuery.parse({ chain: 'solana', address });
  const positions = await fetchJupiterLp(a);
  const tracked = new Set(
    (db.prepare('SELECT symbol FROM assets').all() as Array<{ symbol: string }>).map((r) => r.symbol),
  );
  return positions.map((p) => {
    const symbol = lpSymbol(p.platform, p.pool);
    return { ...p, symbol, already_tracked: tracked.has(symbol) };
  });
}

export async function importLp(
  db: Database.Database,
  address: string,
  symbols?: string[],
): Promise<{ imported: Array<{ symbol: string; value_usd: number }>; removed: string[] }> {
  const list = await previewLp(db, address);
  const wanted = symbols?.map((s) => s.toUpperCase());
  const fx = createFxRateProvider(db, 3_600_000);
  const rate = await fx().catch(() => 16000);
  const out: Array<{ symbol: string; value_usd: number }> = [];
  const atomic = db.transaction(() => {
    db.prepare(
      `INSERT INTO wallet_links (chain, address) VALUES ('solana', ?) ON CONFLICT(chain, address) DO NOTHING`,
    ).run(address);
  });
  atomic();
  for (const p of list) {
    if (wanted && !wanted.includes(p.symbol)) continue;
    // LP tracked as ONE asset: qty 1 @ pool value. Avg = value at import,
    // so P/L means "since tracked" (entry price is unknowable onchain).
    const priceIdr = Math.max(1, Math.round(p.totalUsd * rate));
    const live = (db.prepare('SELECT avg_buy_price_idr FROM assets WHERE symbol = ?').get(p.symbol) ?? {}) as {
      avg_buy_price_idr?: number;
    };
    upsertAsset(db, {
      type: 'crypto',
      symbol: p.symbol,
      name: `${p.platform} ${p.label}`,
      qty: '1',
      avg_buy_price_idr: live.avg_buy_price_idr && live.avg_buy_price_idr > 0 ? live.avg_buy_price_idr : priceIdr,
    });
    db.prepare(
      `INSERT INTO asset_map (symbol, provider, provider_id, updated_at)
       VALUES (?, 'jupiter-lp', ?, datetime('now'))
       ON CONFLICT(symbol) DO UPDATE SET provider_id = excluded.provider_id, updated_at = datetime('now')`,
    ).run(p.symbol, p.pool);
    storePrices(db, [{ symbol: p.symbol, priceIdr: Math.max(1, Math.round(p.totalUsd * rate)), source: 'jupiter-lp' }]);
    out.push({ symbol: p.symbol, value_usd: p.totalUsd });
  }
  // Drop tracked LP whose pool vanished AND whose price is stale (>30 min):
  // the position was closed (funds left the pool), so a frozen value + P/L
  // would lie. A merely hiccuping API can't go stale (scheduler refreshes 5-minutely).
  const livePools = new Set(list.map((p) => p.pool));
  const tracked = db.prepare(`SELECT symbol, provider_id FROM asset_map WHERE provider = 'jupiter-lp'`).all() as Array<{
    symbol: string;
    provider_id: string;
  }>;
  const removed: string[] = [];
  for (const r of tracked) {
    if (livePools.has(r.provider_id)) continue;
    const pc = db.prepare('SELECT fetched_at FROM price_cache WHERE symbol = ?').get(r.symbol) as
      | { fetched_at: string }
      | undefined;
    const ageMs = pc ? Date.now() - new Date(pc.fetched_at + 'Z').getTime() : Infinity;
    if (ageMs > 30 * 60 * 1000) {
      db.prepare('DELETE FROM assets WHERE symbol = ?').run(r.symbol);
      db.prepare('DELETE FROM asset_map WHERE symbol = ?').run(r.symbol);
      db.prepare('DELETE FROM price_cache WHERE symbol = ?').run(r.symbol);
      removed.push(r.symbol);
    }
  }
  return { imported: out, removed };
}

/** Refresh LP values for all linked wallets (scheduler, every 5 min). */
export async function refreshLpPositions(db: Database.Database): Promise<void> {
  const links = db.prepare(`SELECT address FROM wallet_links WHERE chain = 'solana'`).all() as Array<{
    address: string;
  }>;
  if (links.length === 0) return;
  const fx = createFxRateProvider(db, 3_600_000);
  const rate = await fx().catch(() => 16000);
  const seenPools = new Set<string>();
  let ok = false;
  for (const { address } of links) {
    try {
      const positions = await fetchJupiterLp(address);
      ok = true;
      const byPool = new Map(positions.map((p) => [p.pool, p]));
      for (const pool of byPool.keys()) seenPools.add(pool);
      const rows = db.prepare(`SELECT symbol, provider_id FROM asset_map WHERE provider = 'jupiter-lp'`).all() as Array<{
        symbol: string;
        provider_id: string;
      }>;
      const prices = rows
        .filter((r) => byPool.has(r.provider_id))
        .map((r) => ({
          symbol: r.symbol,
          priceIdr: Math.max(1, Math.round(byPool.get(r.provider_id)!.totalUsd * rate)),
          source: 'jupiter-lp',
        }));
      storePrices(db, prices);
    } catch (e) {
      logger.warn({ err: e, address: address.slice(0, 6) }, 'LP refresh failed, keeping cache');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Prune closed positions: pool absent from a successful fetch AND price
  // older than 6h. The long grace period tolerates API hiccups.
  if (ok) {
    const rows = db.prepare(`SELECT symbol, provider_id FROM asset_map WHERE provider = 'jupiter-lp'`).all() as Array<{
      symbol: string;
      provider_id: string;
    }>;
    for (const r of rows) {
      if (seenPools.has(r.provider_id)) continue;
      const pc = db.prepare('SELECT fetched_at FROM price_cache WHERE symbol = ?').get(r.symbol) as
        | { fetched_at: string }
        | undefined;
      const ageMs = pc ? Date.now() - new Date(pc.fetched_at + 'Z').getTime() : Infinity;
      if (ageMs > 6 * 3600 * 1000) {
        db.prepare('DELETE FROM assets WHERE symbol = ?').run(r.symbol);
        db.prepare('DELETE FROM asset_map WHERE symbol = ?').run(r.symbol);
        db.prepare('DELETE FROM price_cache WHERE symbol = ?').run(r.symbol);
        logger.info({ symbol: r.symbol }, 'closed LP position pruned');
      }
    }
  }
}
