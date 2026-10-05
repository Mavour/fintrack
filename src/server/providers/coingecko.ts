import type Database from 'better-sqlite3';
import type { Price, PriceProvider } from './types.js';
import { fetchWithTimeout, withRetry } from './types.js';

/**
 * CoinGecko is the primary crypto provider.
 * Symbol -> coin id mapping is read from `asset_map` so it can be
 * corrected at runtime (see verifyMetMapping below).
 */
export class CoinGeckoProvider implements PriceProvider {
  readonly name = 'coingecko';
  constructor(
    private db: Database.Database,
    private fxRate: () => Promise<number>,
    private apiKey = '',
  ) {}

  async fetch(symbols: string[]): Promise<Price[]> {
    if (symbols.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT symbol, provider_id FROM asset_map WHERE symbol IN (${symbols.map(() => '?').join(',')})`)
      .all(...symbols) as Array<{ symbol: string; provider_id: string }>;
    const idToSymbol = new Map(rows.map((r) => [r.provider_id, r.symbol]));
    if (rows.length === 0) return [];
    const ids = [...idToSymbol.keys()].join(',');
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['x-cg-demo-api-key'] = this.apiKey;
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`;
    const res = await withRetry(() => fetchWithTimeout(url, 10_000, { headers }));
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, { usd: number }>;
    const rate = await this.fxRate();
    return Object.entries(json)
      .filter(([, v]) => typeof v?.usd === 'number')
      .map(([id, v]) => ({
        symbol: idToSymbol.get(id)!,
        priceIdr: Math.round(v.usd * rate),
        source: 'coingecko',
      }));
  }
}

/**
 * Verify that symbol MET maps to the correct CoinGecko id.
 * There are several tokens named MET; we use /search and pick the
 * top result with matching symbol, then persist it to asset_map.
 * Never guess — always verify via API before overwriting.
 */
export async function verifyMetMapping(db: Database.Database, apiKey = ''): Promise<string | null> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['x-cg-demo-api-key'] = apiKey;
    const res = await fetchWithTimeout(
      'https://api.coingecko.com/api/v3/search?query=MET',
      10_000,
      { headers },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { coins?: Array<{ id: string; symbol: string; market_cap_rank?: number | null }> };
    const candidates = (json.coins ?? []).filter((c) => c.symbol?.toUpperCase() === 'MET');
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.market_cap_rank ?? 99999) - (b.market_cap_rank ?? 99999));
    const best = candidates[0].id;
    db.prepare(
      `INSERT INTO asset_map (symbol, provider, provider_id, updated_at)
       VALUES ('MET','coingecko',?,datetime('now'))
       ON CONFLICT(symbol) DO UPDATE SET provider_id = excluded.provider_id, updated_at = datetime('now')`,
    ).run(best);
    return best;
  } catch {
    return null;
  }
}
