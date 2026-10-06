import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let db: Database.Database | null = null;

export function getDatabase(dbPath?: string): Database.Database {
  if (db) return db;
  const resolved = dbPath ?? process.env.DATABASE_PATH ?? './data/app.db';
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function runMigrations(database: Database.Database): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'schema.sql'), path.join(here, '..', '..', '..', 'src', 'server', 'db', 'schema.sql')];
  const schemaPath = candidates.find((p) => fs.existsSync(p));
  if (!schemaPath) throw new Error('schema.sql not found');
  const sql = fs.readFileSync(schemaPath, 'utf-8');
  database.exec(sql);
  seedAssetMap(database);
}

/** Default CoinGecko id mapping. MET is verified below (see providers/coingecko.ts). */
function seedAssetMap(database: Database.Database): void {
  const defaults: Array<[string, string, string]> = [
    ['HYPE', 'coingecko', 'hyperliquid'],
    ['SOL', 'coingecko', 'solana'],
    ['BTC', 'coingecko', 'bitcoin'],
    ['ETH', 'coingecko', 'ethereum'],
    ['USDC', 'coingecko', 'usd-coin'],
    ['USDT', 'coingecko', 'tether'],
    // MET: Metronome? There are multiple "MET" tokens. We do NOT guess here;
    // the CoinGecko provider resolves it at runtime via /search and persists
    // the verified id. This row is a placeholder that gets corrected.
    ['MET', 'coingecko', 'metronome'],
  ];
  const stmt = database.prepare(
    `INSERT INTO asset_map (symbol, provider, provider_id) VALUES (?, ?, ?)
     ON CONFLICT(symbol) DO NOTHING`,
  );
  const tx = database.transaction(() => {
    for (const row of defaults) stmt.run(...row);
  });
  tx();
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export type { Database };
