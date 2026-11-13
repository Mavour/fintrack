import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Explicitly run to create a private bank/investment snapshot (ignored by Git).
// Authentication, sessions, transactions and environment credentials are excluded.
const tables = ['accounts', 'assets', 'wallet_links', 'wallets', 'wallet_positions', 'lp_positions',
  'cost_basis', 'asset_map', 'price_cache', 'price_history', 'fx_cache'];
const db = new Database(process.env.DATABASE_PATH ?? './data/app.db', { readonly: true });
try {
  const snapshot = db.transaction(() => ({
    version: 1, capturedAt: new Date().toISOString(),
    tables: Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
  }))();
  const json = JSON.stringify(snapshot, null, 2);
  if (/password|token_hash|api[_-]?key|authorization|bearer|session_secret/i.test(json))
    throw new Error('Snapshot contains a credential field; export refused');
  const output = process.env.PORTFOLIO_SNAPSHOT_PATH ?? './data/portfolio-snapshot.json';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, json + '\n', { mode: 0o600 });
  console.log('Private portfolio snapshot exported:', output, Object.fromEntries(Object.entries(snapshot.tables).map(([table, rows]) => [table, rows.length])));
} finally { db.close(); }
