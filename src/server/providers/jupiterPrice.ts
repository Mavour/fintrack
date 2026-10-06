import type Database from 'better-sqlite3';
import type { Price, PriceProvider } from './types.js';
import { fetchWithTimeout, withRetry } from './types.js';

/**
 * Prices any Solana token by mint via Jupiter Price v3 (free Lite endpoint).
 * Mints come from `asset_map` rows with provider='jupiter' (auto-registered
 * on wallet import). USD -> IDR with the cached FX rate.
 */
export class JupiterPriceProvider implements PriceProvider {
  readonly name = 'jupiter';
  constructor(
    private db: Database.Database,
    private fxRate: () => Promise<number>,
  ) {}

  async fetch(symbols: string[]): Promise<Price[]> {
    if (symbols.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT symbol, provider_id FROM asset_map WHERE provider = 'jupiter' AND symbol IN (${symbols.map(() => '?').join(',')})`,
      )
      .all(...symbols) as Array<{ symbol: string; provider_id: string }>;
    if (rows.length === 0) return [];
    const mintToSymbol = new Map(rows.map((r) => [r.provider_id, r.symbol]));
    const rate = await this.fxRate();
    const out: Price[] = [];
    // Chunk to stay friendly to the free tier.
    for (let i = 0; i < rows.length; i += 50) {
      const ids = rows.slice(i, i + 50).map((r) => r.provider_id).join(',');
      try {
        const res = await withRetry(() =>
          fetchWithTimeout(`https://lite-api.jup.ag/price/v3?ids=${ids}`, 12_000),
        );
        if (!res.ok) continue;
        const json = (await res.json()) as Record<string, { usdPrice?: number }>;
        for (const [mint, v] of Object.entries(json)) {
          if (typeof v?.usdPrice === 'number' && mintToSymbol.has(mint)) {
            out.push({ symbol: mintToSymbol.get(mint)!, priceIdr: Math.round(v.usdPrice * rate), source: 'jupiter' });
          }
        }
      } catch {
        // Keep last cached price on failure.
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return out;
  }
}
