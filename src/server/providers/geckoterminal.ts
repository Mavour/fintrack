import type Database from 'better-sqlite3';
import type { Price, PriceProvider } from './types.js';
import { fetchWithTimeout, withRetry } from './types.js';

interface GeckoAttrs {
  address: string;
  symbol: string;
  name: string;
  price_usd: string | null;
}

/** Symbol lookup for mints DexScreener doesn't know (often dead tokens). */
export async function fetchGeckoSymbols(mints: string[]): Promise<Map<string, { symbol: string; name: string }>> {
  const out = new Map<string, { symbol: string; name: string }>();
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const res = await withRetry(() =>
        fetchWithTimeout(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/multi/${batch.join(',')}`, 12_000),
      );
      if (!res.ok) continue;
      const json = (await res.json()) as { data?: Array<{ attributes: GeckoAttrs }> };
      for (const t of json.data ?? []) {
        if (t.attributes?.address && t.attributes.symbol) {
          const name = (t.attributes.name ?? 'Token Solana')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"');
          out.set(t.attributes.address, { symbol: t.attributes.symbol, name });
        }
      }
    } catch {
      // Non-fatal.
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

/** Prices by mint via GeckoTerminal (picks up tokens that gain liquidity later). */
export class GeckoTerminalPriceProvider implements PriceProvider {
  readonly name = 'geckoterminal';
  constructor(
    private db: Database.Database,
    private fxRate: () => Promise<number>,
  ) {}

  async fetch(symbols: string[]): Promise<Price[]> {
    if (symbols.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT symbol, provider_id FROM asset_map WHERE provider = 'geckoterminal' AND symbol IN (${symbols.map(() => '?').join(',')})`,
      )
      .all(...symbols) as Array<{ symbol: string; provider_id: string }>;
    if (rows.length === 0) return [];
    const rate = await this.fxRate();
    const out: Price[] = [];
    for (let i = 0; i < rows.length; i += 30) {
      const batch = rows.slice(i, i + 30);
      try {
        const res = await withRetry(() =>
          fetchWithTimeout(
            `https://api.geckoterminal.com/api/v2/networks/solana/tokens/multi/${batch.map((r) => r.provider_id).join(',')}`,
            12_000,
          ),
        );
        if (!res.ok) continue;
        const json = (await res.json()) as { data?: Array<{ attributes: GeckoAttrs }> };
        const byAddr = new Map((json.data ?? []).map((t) => [t.attributes.address, t.attributes]));
        for (const r of batch) {
          const usd = Number(byAddr.get(r.provider_id)?.price_usd);
          if (Number.isFinite(usd) && usd > 0) {
            out.push({ symbol: r.symbol, priceIdr: Math.max(1, Math.round(usd * rate)), source: 'geckoterminal' });
          }
        }
      } catch {
        // Keep cache.
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return out;
  }
}
