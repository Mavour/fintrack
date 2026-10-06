import type Database from 'better-sqlite3';
import { z } from 'zod';
import { fetchSolanaHoldings, type ChainHolding } from '../providers/solana.js';
import { fetchEvmHoldings, EVM_CHAINS } from '../providers/evm.js';
import { fetchEtherscanHoldings } from '../providers/etherscan.js';
import { upsertAsset, getAssetBySymbol } from './portfolioService.js';

export const ChainSchema = z.enum(['solana', ...EVM_CHAINS, 'hoodi'] as [string, ...string[]]);
export type Chain = z.infer<typeof ChainSchema>;

export const PreviewQuerySchema = z.object({
  chain: ChainSchema,
  address: z.string().min(26).max(50),
});

export const ImportBodySchema = z.object({
  chain: ChainSchema,
  address: z.string().min(26).max(50),
  symbols: z.array(z.string().min(1).max(20)).max(100).optional(),
});

export interface HoldingPreview extends ChainHolding {
  /** Pre-collision base symbol (for stable import matching). */
  base_symbol: string;
  /** Current cached IDR price when already known, else null. */
  price_idr: number | null;
  already_tracked: boolean;
}

/** Ensure the display symbol is unique per mint (SI vs SI from another mint). */
function resolveFinalSymbol(db: Database.Database, base: string, mint: string | null): string {
  if (!mint) return base;
  let candidate = base;
  for (let len = 4; len <= 8; len += 2) {
    const row = db.prepare(`SELECT provider_id FROM asset_map WHERE symbol = ?`).get(candidate) as
      | { provider_id: string }
      | undefined;
    if (!row || row.provider_id === mint) return candidate;
    candidate = `${base}_${mint.slice(0, len).toUpperCase()}`;
  }
  return candidate;
}

export async function previewHoldings(
  db: Database.Database,
  chain: string,
  address: string,
  etherscanKey = '',
): Promise<HoldingPreview[]> {
  const { chain: c, address: a } = PreviewQuerySchema.parse({ chain, address });
  const holdings: ChainHolding[] =
    c === 'solana'
      ? await fetchSolanaHoldings(a)
      : c === 'hoodi'
        ? await fetchEtherscanHoldings(a, c, etherscanKey)
        : await fetchEvmHoldings(a, c);
  const priceRows = db.prepare('SELECT symbol, price_idr FROM price_cache').all() as Array<{
    symbol: string;
    price_idr: number;
  }>;
  const prices = new Map(priceRows.map((r) => [r.symbol, r.price_idr]));
  const tracked = new Set(
    (db.prepare('SELECT symbol FROM assets').all() as Array<{ symbol: string }>).map((r) => r.symbol),
  );
  return holdings.map((h) => {
    const base = h.symbol.toUpperCase();
    const symbol = resolveFinalSymbol(db, base, h.ref);
    return {
      ...h,
      base_symbol: base,
      symbol,
      price_idr: prices.get(symbol) ?? null,
      already_tracked: tracked.has(symbol),
    };
  });
}

/**
 * Import holdings as crypto assets. Qty follows the chain (source of truth).
 * Buy price: kept when already known; otherwise auto-filled with the current
 * market price at first sync (so P/L tracks from that moment, no typing needed).
 * Unknown price -> avg stays 0 and P/L is hidden.
 */
export async function importHoldings(
  db: Database.Database,
  chain: string,
  address: string,
  symbols?: string[],
  etherscanKey = '',
): Promise<Array<{ symbol: string; qty: string }>> {
  const parsed = ImportBodySchema.parse({ chain, address, symbols });
  const preview = await previewHoldings(db, parsed.chain, parsed.address, etherscanKey);
  const wanted = parsed.symbols?.map((s) => s.toUpperCase());
  const out: Array<{ symbol: string; qty: string }> = [];
  for (const h of preview) {
    if (wanted && !wanted.includes(h.symbol) && !wanted.includes(h.base_symbol)) continue;
    if (h.symbol === '???') continue;
    // Re-resolve every iteration: earlier loop writes change collision state.
    const symbol = resolveFinalSymbol(db, h.base_symbol, h.ref);
    const existing = getAssetBySymbol(db, symbol);
    // Retire placeholders for the same mint: previously shortened asset with
    // no buy price. Match by mapping first, then by exact qty (avg 0, unmapped).
    if (!existing && h.ref && !symbol.includes('…')) {
      const kill = (sym: string): void => {
        const oldAsset = getAssetBySymbol(db, sym);
        if (oldAsset && oldAsset.avg_buy_price_idr === 0) {
          db.prepare(`DELETE FROM assets WHERE symbol = ?`).run(sym);
          db.prepare(`DELETE FROM asset_map WHERE symbol = ?`).run(sym);
        }
      };
      const byMap = db.prepare(
        `SELECT symbol FROM asset_map WHERE provider_id = ? AND symbol != ?`,
      ).get(h.ref, symbol) as { symbol: string } | undefined;
      if (byMap) {
        kill(byMap.symbol);
      } else {
        const dups = db.prepare(
          `SELECT symbol FROM assets WHERE type = 'crypto' AND qty = ? AND avg_buy_price_idr = 0
           AND symbol LIKE '%…%' AND symbol NOT IN (SELECT symbol FROM asset_map)`,
        ).all(h.qty) as Array<{ symbol: string }>;
        if (dups.length === 1) kill(dups[0].symbol);
      }
    }
    const live = getAssetBySymbol(db, symbol);
    const avg = live && live.avg_buy_price_idr > 0 ? live.avg_buy_price_idr : (h.price_idr ?? 0);
    upsertAsset(db, {
      type: 'crypto',
      symbol,
      name: live?.name || h.name,
      qty: h.qty,
      avg_buy_price_idr: avg,
    });
    // Register Solana mint for price-by-mint (never overrides CoinGecko).
    if (parsed.chain === 'solana' && h.ref && h.mintSource !== 'native' && h.mintSource !== 'unknown') {
      const provider = h.mintSource === 'dex' ? 'dexscreener' : h.mintSource === 'gecko' ? 'geckoterminal' : 'jupiter';
      db.prepare(
        `INSERT INTO asset_map (symbol, provider, provider_id, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(symbol) DO NOTHING`,
      ).run(symbol, provider, h.ref);
    }
    out.push({ symbol, qty: h.qty });
  }
  return out;
}
