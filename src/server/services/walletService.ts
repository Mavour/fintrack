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
  /** Current cached IDR price when already known, else null. */
  price_idr: number | null;
  already_tracked: boolean;
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
  return holdings.map((h) => ({
    ...h,
    symbol: h.symbol.toUpperCase(),
    price_idr: prices.get(h.symbol.toUpperCase()) ?? null,
    already_tracked: tracked.has(h.symbol.toUpperCase()),
  }));
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
    if (wanted && !wanted.includes(h.symbol)) continue;
    // Skip dust / placeholder symbols without real identity.
    if (h.symbol === '???' || h.symbol.includes('…')) continue;
    const existing = getAssetBySymbol(db, h.symbol);
    const avg =
      existing && existing.avg_buy_price_idr > 0
        ? existing.avg_buy_price_idr
        : (h.price_idr ?? 0);
    upsertAsset(db, {
      type: 'crypto',
      symbol: h.symbol,
      name: existing?.name || h.name,
      qty: h.qty,
      avg_buy_price_idr: avg,
    });
    // Register Solana mint for Jupiter price-by-mint (never overrides CoinGecko).
    if (parsed.chain === 'solana' && h.ref) {
      db.prepare(
        `INSERT INTO asset_map (symbol, provider, provider_id, updated_at)
         VALUES (?, 'jupiter', ?, datetime('now'))
         ON CONFLICT(symbol) DO NOTHING`,
      ).run(h.symbol, h.ref);
    }
    out.push({ symbol: h.symbol, qty: h.qty });
  }
  return out;
}
