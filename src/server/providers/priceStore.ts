import type Database from 'better-sqlite3';
import type { Price } from './types.js';
import { logger } from '../logger.js';
import { emitSyncDone } from '../services/sse.js';

/** Persist fetched prices to price_cache + append to price_history (for sparklines). */
export function storePrices(db: Database.Database, prices: Price[]): number {
  if (prices.length === 0) return 0;
  const upsert = db.prepare(
    `INSERT INTO price_cache (symbol, price_idr, source, price_date, fetched_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET price_idr = excluded.price_idr,
       source = excluded.source, price_date = excluded.price_date, fetched_at = datetime('now')
     WHERE excluded.price_date IS NULL OR price_cache.price_date IS NULL OR excluded.price_date >= price_cache.price_date`,
  );
  const hist = db.prepare(
    `INSERT OR IGNORE INTO price_history (symbol, price_idr, fetched_at) VALUES (?, ?, datetime('now'))`,
  );
  const previous = db.prepare('SELECT price_idr, source, price_date FROM price_cache WHERE symbol = ?');
  let changed = false;
  const tx = db.transaction(() => {
    const datedHistory = db.prepare(`INSERT INTO price_history (symbol, price_idr, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(symbol, fetched_at) DO UPDATE SET price_idr = excluded.price_idr
      WHERE price_history.price_idr != excluded.price_idr`);
    for (const p of prices) {
      if (!Number.isFinite(p.priceIdr) || p.priceIdr <= 0) continue;
      const old = previous.get(p.symbol) as { price_idr: number; source: string; price_date: string | null } | undefined;
      const saved = upsert.run(p.symbol, p.priceIdr, p.source, p.asOf ?? null);
      if (saved.changes > 0 && (!old || old.price_idr !== p.priceIdr || old.source !== p.source || old.price_date !== (p.asOf ?? null))) changed = true;
      if (p.asOf) {
        for (const point of p.history ?? []) {
          if (Number.isFinite(point.priceIdr) && point.priceIdr > 0 && point.day <= p.asOf)
            if (datedHistory.run(p.symbol, point.priceIdr, `${point.day} 00:00:00`).changes > 0) changed = true;
        }
        if (datedHistory.run(p.symbol, p.priceIdr, `${p.asOf} 00:00:00`).changes > 0) changed = true;
      } else hist.run(p.symbol, p.priceIdr);
    }
    pruneHistory(db);
  });
  tx();
  if (changed) emitSyncDone(['price']);
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
