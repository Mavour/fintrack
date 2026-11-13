import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import fs from 'node:fs';

const TABLES = ['accounts', 'assets', 'wallet_links', 'wallets', 'wallet_positions', 'lp_positions',
  'cost_basis', 'asset_map', 'price_cache', 'price_history', 'fx_cache'] as const;
const MARKER = 'portfolio_seed_v1';
export interface PortfolioSeed {
  version: number;
  capturedAt: string;
  tables: Record<(typeof TABLES)[number], Array<Record<string, string | number | null>>>;
}

/** Restore automatically only into an empty app. Existing data requires explicit --replace. */
export function restorePortfolioSeed(db: Database.Database, replace = false, data?: PortfolioSeed): boolean {
  const file = process.env.PORTFOLIO_SNAPSHOT_PATH ?? './data/portfolio-snapshot.json';
  if (!data && !fs.existsSync(file)) return false;
  const snapshot = data ?? JSON.parse(fs.readFileSync(file, 'utf8')) as PortfolioSeed;
  if (snapshot.version !== 1) throw new Error('Unsupported portfolio snapshot version');
  for (const table of TABLES) {
    if (!Array.isArray(snapshot.tables?.[table])) throw new Error(`Missing snapshot table: ${table}`);
  }
  if (!snapshot.tables.accounts.length && !snapshot.tables.assets.length && !snapshot.tables.wallets.length) return false;
  return db.transaction(() => {
    if (!replace) {
      if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(MARKER)) return false;
      for (const table of ['accounts', 'assets', 'wallets', 'transactions'])
        if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return false;
    } else {
      // These are imported balances, not transaction reversals. Never apply bookkeeping effects.
      db.prepare('DELETE FROM transactions').run();
      db.prepare('DELETE FROM wealth_history').run();
      for (const table of [...TABLES].reverse()) db.prepare(`DELETE FROM ${table}`).run();
    }
    for (const table of TABLES) {
      const available = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      const rows = snapshot.tables[table];
      for (const source of rows) {
        const row = { ...source };
        // Older releases lack total_cost_idr. Preserve exact total modal through fractional average price.
        if (table === 'assets' && !available.has('total_cost_idr') && row.total_cost_idr != null && new Decimal(row.qty!).gt(0))
          row.avg_buy_price_idr = new Decimal(row.total_cost_idr).div(row.qty!).toNumber();
        const columns = Object.keys(row).filter((column) => available.has(column));
        db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...columns.map((c) => row[c]));
      }
    }
    db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run(MARKER, snapshot.capturedAt);
    return true;
  })();
}
