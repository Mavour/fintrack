import type Database from 'better-sqlite3';
import { fetchWithTimeout, withRetry } from './types.js';

/** USD/IDR rate with 1-hour cache in fx_cache. Falls back to 16000 on total failure. */
export function createFxRateProvider(db: Database.Database, ttlMs: number) {
  return async function getUsdIdr(): Promise<number> {
    const cached = db.prepare('SELECT rate, fetched_at FROM fx_cache WHERE pair = ?').get('USDIDR') as
      | { rate: number; fetched_at: string }
      | undefined;
    if (cached && Date.now() - new Date(cached.fetched_at + 'Z').getTime() < ttlMs) {
      return cached.rate;
    }
    try {
      const rate = await withRetry(async () => {
        const res = await fetchWithTimeout('https://open.er-api.com/v6/latest/USD', 8000);
        if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
        const json = (await res.json()) as { rates?: Record<string, number> };
        const idr = json.rates?.IDR;
        if (!idr || !Number.isFinite(idr)) throw new Error('Bad FX payload');
        return idr;
      });
      db.prepare(
        `INSERT INTO fx_cache (pair, rate, fetched_at) VALUES ('USDIDR', ?, datetime('now'))
         ON CONFLICT(pair) DO UPDATE SET rate = excluded.rate, fetched_at = datetime('now')`,
      ).run(rate);
      return rate;
    } catch {
      if (cached) return cached.rate;
      return 16000;
    }
  };
}
