import type { Price, PriceProvider } from './types.js';
import { withRetry } from './types.js';

/**
 * IDX stocks via yahoo-finance2. Tickers end with .JK (e.g. BBCA.JK).
 * Prices from Yahoo are already in IDR, no FX conversion needed.
 */
export class YahooFinanceProvider implements PriceProvider {
  readonly name = 'yahoo';
  async fetch(symbols: string[]): Promise<Price[]> {
    const { default: yahooFinance } = await import('yahoo-finance2');
    const out: Price[] = [];
    for (const symbol of symbols) {
      try {
        const quote = await withRetry(
          () =>
            (
              yahooFinance as unknown as {
                quote: (s: string) => Promise<{ regularMarketPrice?: number }>;
              }
            ).quote(symbol),
          2,
        );
        const price = quote?.regularMarketPrice;
        if (typeof price === 'number' && Number.isFinite(price)) {
          out.push({ symbol, priceIdr: Math.round(price), source: 'yahoo' });
        }
      } catch {
        // Keep last cached price on failure.
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return out;
  }
}

/** True when IDX is open: Mon-Fri 09:00-16:00 WIB (UTC+7). */
export function isMarketOpen(now = new Date()): boolean {
  const wib = new Date(now.getTime() + (7 * 60 + now.getTimezoneOffset()) * 60_000);
  const day = wib.getDay();
  if (day === 0 || day === 6) return false;
  const mins = wib.getHours() * 60 + wib.getMinutes();
  return mins >= 9 * 60 && mins < 16 * 60;
}
