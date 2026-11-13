import type { Price, PriceProvider } from './types.js';
import { fetchWithTimeout, withRetry } from './types.js';

/**
 * IDX stocks via yahoo-finance2. Tickers end with .JK (e.g. BBCA.JK).
 * Prices from Yahoo are already in IDR, no FX conversion needed.
 */
export class YahooFinanceProvider implements PriceProvider {
  readonly name = 'yahoo';
  async fetch(symbols: string[]): Promise<Price[]> {
    const out: Price[] = [];
    for (const symbol of symbols) {
      try {
        const result = await withRetry(async () => {
          const res = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`);
          if (!res.ok) throw Object.assign(new Error(`Yahoo HTTP ${res.status}`), { httpStatus: res.status });
          const json = await res.json() as { chart?: { result?: Array<{
            meta?: { currency?: string }; timestamp?: number[];
            indicators?: { quote?: Array<{ close?: Array<number | null> }> };
          }> } };
          return json.chart?.result?.[0];
        }, 2);
        if (result?.meta?.currency !== 'IDR') continue;
        const closes = result.indicators?.quote?.[0]?.close ?? [];
        const history = (result.timestamp ?? []).flatMap((ts, i) => {
          const price = closes[i];
          return typeof price === 'number' && Number.isFinite(price) && price > 0
            ? [{ day: new Date(ts * 1000 + 7 * 3600_000).toISOString().slice(0, 10), priceIdr: Math.round(price) }]
            : [];
        });
        const last = history[history.length - 1];
        if (last) out.push({ symbol, priceIdr: last.priceIdr, source: 'yahoo', asOf: last.day, history });
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
