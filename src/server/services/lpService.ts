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
): Promise<Array<{ symbol: string; value_usd: number }>> {
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
    // LP tracked as ONE asset: qty 1 @ pool value (avg unknown -> P/L hidden).
    upsertAsset(db, {
      type: 'crypto',
      symbol: p.symbol,
      name: `${p.platform} ${p.label}`,
      qty: '1',
      avg_buy_price_idr: 0,
    });
    db.prepare(
      `INSERT INTO asset_map (symbol, provider, provider_id, updated_at)
       VALUES (?, 'jupiter-lp', ?, datetime('now'))
       ON CONFLICT(symbol) DO UPDATE SET provider_id = excluded.provider_id, updated_at = datetime('now')`,
    ).run(p.symbol, p.pool);
    storePrices(db, [{ symbol: p.symbol, priceIdr: Math.max(1, Math.round(p.totalUsd * rate)), source: 'jupiter-lp' }]);
    out.push({ symbol: p.symbol, value_usd: p.totalUsd });
  }
  return out;
}

/** Refresh LP values for all linked wallets (scheduler, every 5 min). */
export async function refreshLpPositions(db: Database.Database): Promise<void> {
  const links = db.prepare(`SELECT address FROM wallet_links WHERE chain = 'solana'`).all() as Array<{
    address: string;
  }>;
  if (links.length === 0) return;
  const fx = createFxRateProvider(db, 3_600_000);
  const rate = await fx().catch(() => 16000);
  for (const { address } of links) {
    try {
      const positions = await fetchJupiterLp(address);
      const byPool = new Map(positions.map((p) => [p.pool, p]));
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
}
