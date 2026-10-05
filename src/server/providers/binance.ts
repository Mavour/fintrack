import type { Price, PriceProvider } from './types.js';
import { fetchWithTimeout, withRetry } from './types.js';

/** Fallback provider: Binance public klines. Only works for listed pairs (e.g. SOLUSDT). */
export class BinanceProvider implements PriceProvider {
  readonly name = 'binance';
  constructor(private fxRate: () => Promise<number>) {}

  async fetch(symbols: string[]): Promise<Price[]> {
    const rate = await this.fxRate();
    const out: Price[] = [];
    for (const symbol of symbols) {
      const pair = `${symbol}USDT`;
      try {
        const price = await withRetry(async () => {
          const res = await fetchWithTimeout(
            `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`,
            8000,
          );
          if (!res.ok) throw new Error(`Binance HTTP ${res.status} for ${pair}`);
          const json = (await res.json()) as { price: string };
          const usd = Number(json.price);
          if (!Number.isFinite(usd)) throw new Error(`Bad binance price for ${pair}`);
          return usd;
        }, 2);
        out.push({ symbol, priceIdr: Math.round(price * rate), source: 'binance' });
      } catch {
        // Pair not listed (e.g. HYPE before listing) -> skip silently, caller falls back to cache.
      }
      // Gentle rate limiting between symbols.
      await new Promise((r) => setTimeout(r, 210));
    }
    return out;
  }
}
