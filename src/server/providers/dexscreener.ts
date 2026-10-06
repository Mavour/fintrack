import type Database from 'better-sqlite3';
import type { Price, PriceProvider } from './types.js';
import { fetchWithTimeout, withRetry } from './types.js';

export interface DexToken {
  symbol: string;
  name: string;
  priceUsd: number | null;
}

interface DexPair {
  baseToken: { address: string; symbol: string; name: string };
  priceUsd?: string;
}

/**
 * DexScreener token lookup + prices by mint (Solana). Free, keyless.
 * Covers long-tail memecoins that Jupiter/CoinGecko don't price.
 */
export async function fetchDexTokens(mints: string[]): Promise<Map<string, DexToken>> {
  const out = new Map<string, DexToken>();
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const res = await withRetry(() =>
        fetchWithTimeout(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`, 12_000),
      );
      if (!res.ok) continue;
      const pairs = (await res.json()) as DexPair[];
      for (const p of pairs) {
        if (out.has(p.baseToken.address)) continue; // first pair wins
        const usd = Number(p.priceUsd);
        out.set(p.baseToken.address, {
          symbol: p.baseToken.symbol,
          name: p.baseToken.name,
          priceUsd: Number.isFinite(usd) ? usd : null,
        });
      }
    } catch {
      // Keep going with what we have.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

export class DexScreenerPriceProvider implements PriceProvider {
  readonly name = 'dexscreener';
  constructor(
    private db: Database.Database,
    private fxRate: () => Promise<number>,
  ) {}

  async fetch(symbols: string[]): Promise<Price[]> {
    if (symbols.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT symbol, provider_id FROM asset_map WHERE provider = 'dexscreener' AND symbol IN (${symbols.map(() => '?').join(',')})`,
      )
      .all(...symbols) as Array<{ symbol: string; provider_id: string }>;
    if (rows.length === 0) return [];
    const rate = await this.fxRate();
    const dex = await fetchDexTokens(rows.map((r) => r.provider_id));
    const out: Price[] = [];
    for (const r of rows) {
      const t = dex.get(r.provider_id);
      if (t?.priceUsd) {
        out.push({ symbol: r.symbol, priceIdr: Math.max(1, Math.round(t.priceUsd * rate)), source: 'dexscreener' });
      }
    }
    return out;
  }
}
