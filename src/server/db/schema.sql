-- Dompet Saya schema (SQLite)
-- Money stored as INTEGER (IDR, no decimals).
-- Asset qty stored as TEXT (decimal string) to avoid float errors.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('bank','e_wallet','cash')),
  balance_idr INTEGER NOT NULL DEFAULT 0 CHECK (balance_idr >= 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('expense','income','transfer')),
  amount_idr INTEGER NOT NULL CHECK (amount_idr > 0),
  account_id INTEGER,
  to_account_id INTEGER,
  category TEXT NOT NULL DEFAULT 'Lainnya',
  note TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (to_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  CHECK (
    (kind IN ('expense','income') AND account_id IS NOT NULL AND to_account_id IS NULL)
    OR (kind = 'transfer' AND account_id IS NOT NULL AND to_account_id IS NOT NULL AND account_id != to_account_id)
  )
);
CREATE INDEX IF NOT EXISTS idx_tx_occurred ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_tx_kind ON transactions(kind);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('crypto','saham','reksadana')),
  symbol TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  qty TEXT NOT NULL DEFAULT '0',
  avg_buy_price_idr INTEGER NOT NULL DEFAULT 0 CHECK (avg_buy_price_idr >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Maps user-facing symbol -> provider-specific id (e.g. HYPE -> hyperliquid)
CREATE TABLE IF NOT EXISTS asset_map (
  symbol TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_cache (
  symbol TEXT PRIMARY KEY,
  price_idr INTEGER NOT NULL CHECK (price_idr >= 0),
  source TEXT NOT NULL DEFAULT 'manual',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_history (
  symbol TEXT NOT NULL,
  price_idr INTEGER NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (symbol, fetched_at)
);
CREATE INDEX IF NOT EXISTS idx_history_symbol_time ON price_history(symbol, fetched_at);

CREATE TABLE IF NOT EXISTS fx_cache (
  pair TEXT PRIMARY KEY,
  rate REAL NOT NULL CHECK (rate > 0),
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
