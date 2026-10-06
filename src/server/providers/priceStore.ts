import type Database from 'better-sqlite3';
import type { Price } from './types.js';
import { logger } from '../logger.js';

/** Persist fetched prices to price_cache + append to price_history (for sparklines). */
export function storePrices(db: Database.Database, prices: Price[]): number {
  if (prices.length === 0) return 0;
  const upsert = db.prepare(
    `INSERT INTO price_cache (symbol, price_idr, source, fetched_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET price_idr = excluded.price_idr,
       source = excluded.source, fetched_at = datetime('now')`,
  );
  const hist = db.prepare(
    `INSERT OR IGNORE INTO price_history (symbol, price_idr, fetched_at) VALUES (?, ?, datetime('now'))`,
  );
  const tx = db.transaction(() => {
    for (const p of prices) {
      upsert.run(p.symbol, p.priceIdr, p.source);
      hist.run(p.symbol, p.priceIdr);
    }
    pruneHistory(db);
  });
  tx();
  logger.info({ count: prices.length }, 'prices stored');
  return prices.length;
}

/**
 * Keep full resolution for the last 48h plus one point per day before that,
 * so sparklines can show real all-time curves without unbounded growth.
 */
export function pruneHistory(db: Database.Database): void {
  db.prepare(
    `DELETE FROM price_history WHERE rowid NOT IN (
       SELECT rowid FROM price_history WHERE fetched_at > datetime('now', '-48 hours')
       UNION
       SELECT MAX(rowid) FROM price_history
       WHERE fetched_at <= datetime('now', '-48 hours')
       GROUP BY symbol, date(fetched_at)
     )`,
  ).run();
}

export function getPrices(db: Database.Database, symbols?: string[]) {
  if (symbols?.length) {
    return db
      .prepare(`SELECT * FROM price_cache WHERE symbol IN (${symbols.map(() => '?').join(',')})`)
      .all(...symbols);
  }
  return db.prepare('SELECT * FROM price_cache ORDER BY symbol').all();
}

export function getHistory(db: Database.Database, symbol: string, limit = 500) {
  return db
    .prepare('SELECT price_idr, fetched_at FROM price_history WHERE symbol = ? ORDER BY fetched_at ASC LIMIT ?')
    .all(symbol, limit);
}
