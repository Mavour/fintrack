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
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
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
  runColumnMigrations(database);
  seedAssetMap(database);
  backfillAssetMints(database);
}

/**
 * Migrasi kolom aditif untuk DB lama (schema.sql CREATE IF NOT EXISTS tidak
 * menambah kolom pada tabel yang sudah ada). Dijalankan idempotent tiap start.
 */
function runColumnMigrations(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'chain')) database.exec('ALTER TABLE assets ADD COLUMN chain TEXT');
  if (!cols.some((c) => c.name === 'mint')) database.exec('ALTER TABLE assets ADD COLUMN mint TEXT');
  if (!cols.some((c) => c.name === 'superseded_by_wallet'))
    database.exec('ALTER TABLE assets ADD COLUMN superseded_by_wallet INTEGER NOT NULL DEFAULT 0');
}

/**
 * Isi kunci dedup (chain + mint) untuk aset crypto manual yang belum punya mint.
 * Posisi wallet (seekor, kind token/staking) dengan jumlah yang IDENTIKAT sama
 * dengan aset manual dipakai sebagai sumber mint — inilah data nyata yang sama,
 * bukan tebakan (tanpa dentum jumlah berarti tidak diisi).
 */
function backfillAssetMints(database: Database.Database): void {
  const assets = database
    .prepare(`SELECT symbol, qty FROM assets WHERE type = 'crypto' AND (mint IS NULL OR mint = '')`)
    .all() as Array<{ symbol: string; qty: string }>;
  if (assets.length === 0) return;
  let rows: Array<{ chain_id: string; amount: string; symbol: string; meta: string }> = [];
  try {
    rows = database
      .prepare(`SELECT chain_id, amount, symbol, meta FROM wallet_positions WHERE kind IN ('token','staking')`)
      .all() as Array<{ chain_id: string; amount: string; symbol: string; meta: string }>;
  } catch {
    return;
  }
  const update = database.prepare('UPDATE assets SET chain = ?, mint = ?, updated_at = datetime(\'now\') WHERE symbol = ?');
  const set = (v: string): number => new Number(v).valueOf();
  for (const a of assets) {
    const aQty = set(a.qty);
    if (!Number.isFinite(aQty)) continue;
    const sameQty = rows.filter((r) => {
      const q = set(r.amount);
      return Number.isFinite(q) && Math.abs(q - aQty) < 1e-9;
    });
    const distinct = new Map<string, { chain_id: string; symbol: string }>();
    for (const r of sameQty) {
      let mint = '';
      try {
        mint = String((JSON.parse(r.meta) as Record<string, unknown>)?.mint ?? '');
      } catch {
        mint = '';
      }
      if (!mint) continue;
      if (!distinct.has(mint)) distinct.set(mint, { chain_id: r.chain_id, symbol: r.symbol.toUpperCase() });
    }
    if (distinct.size !== 1) continue;
    const [mint, info] = [...distinct.entries()][0];
    // Qty sama di banyak aset manual → pertahankan aman (jangan salah isi).
    const clashes = assets.filter((x) => x.symbol !== a.symbol && Math.abs(set(x.qty) - aQty) < 1e-9).length;
    if (clashes > 0) continue;
    update.run(info.chain_id || 'solana', mint, a.symbol);
  }
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
