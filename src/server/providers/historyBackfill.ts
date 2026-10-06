import type Database from 'better-sqlite3';
import { fetchWithTimeout, withRetry } from './types.js';
import { createFxRateProvider } from './fxRate.js';
import { logger } from '../logger.js';

function toSqlite(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * One-time (and daily top-up) history backfill so charts show real all-time
 * curves instead of only post-install points. Free sources only:
 * CoinGecko market_chart 365d (crypto) and Yahoo Finance daily (saham .JK).
 */
export async function backfillSymbol(db: Database.Database, symbol: string): Promise<number> {
  const asset = db.prepare('SELECT type FROM assets WHERE symbol = ?').get(symbol) as
    | { type: string }
    | undefined;
  if (!asset) return 0;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO price_history (symbol, price_idr, fetched_at) VALUES (?, ?, ?)`,
  );
  let inserted = 0;

  if (asset.type === 'saham') {
    const { default: yahooFinance } = await import('yahoo-finance2');
    const chart = await withRetry(
      () =>
        (
          yahooFinance as unknown as {
            chart: (s: string, o: object) => Promise<{ quotes: Array<{ date?: Date | string; close?: number | null }> }>;
          }
        ).chart(symbol, { period1: '2020-01-01', interval: '1d' }),
      2,
    );
    const tx = db.transaction(() => {
      for (const q of chart.quotes ?? []) {
        if (!q.date || typeof q.close !== 'number' || !Number.isFinite(q.close)) continue;
        const r = ins.run(symbol, Math.round(q.close), toSqlite(new Date(q.date).getTime()));
        inserted += r.changes;
      }
    });
    tx();
  } else if (asset.type === 'crypto') {
    const map = db.prepare(`SELECT provider_id FROM asset_map WHERE symbol = ? AND provider = 'coingecko'`).get(symbol) as
      | { provider_id: string }
      | undefined;
    if (!map) return 0;
    const res = await withRetry(() =>
      fetchWithTimeout(`https://api.coingecko.com/api/v3/coins/${map.provider_id}/market_chart?vs_currency=usd&days=365`, 20_000),
    );
    if (!res.ok) throw new Error(`CoinGecko chart HTTP ${res.status}`);
    const json = (await res.json()) as { prices?: Array<[number, number]> };
    const fx = createFxRateProvider(db, 3_600_000);
    const rate = await fx();
    const tx = db.transaction(() => {
      for (const [ms, usd] of json.prices ?? []) {
        if (!Number.isFinite(usd)) continue;
        const r = ins.run(symbol, Math.round(usd * rate), toSqlite(ms));
        inserted += r.changes;
      }
    });
    tx();
  }
  if (inserted > 0) logger.info({ symbol, inserted }, 'history backfilled');
  return inserted;
}

/** Backfill assets lacking depth: fewer than 60 points OR nothing older than 30 days. */
export async function backfillThinHistories(db: Database.Database): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const assets = db.prepare('SELECT symbol FROM assets').all() as Array<{ symbol: string }>;
  for (const { symbol } of assets) {
    const c = db.prepare('SELECT COUNT(*) AS c, MIN(fetched_at) AS oldest FROM price_history WHERE symbol = ?').get(symbol) as {
      c: number;
      oldest: string | null;
    };
    const thin =
      c.c < 60 || !c.oldest || Date.now() - new Date(c.oldest + 'Z').getTime() < 30 * 86400 * 1000;
    if (!thin) continue;
    try {
      out[symbol] = await backfillSymbol(db, symbol);
    } catch (e) {
      logger.warn({ err: e, symbol }, 'backfill failed, will retry tomorrow');
    }
    await new Promise((r) => setTimeout(r, 2000)); // gentle pacing for free tiers
  }
  return out;
}
