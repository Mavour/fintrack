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
  -- Chain aset manual (cth. solana) untuk badge; kunci dedup by mint diisi
  -- otomatis dari posisi wallet yang qty-nya identik.
  chain TEXT,
  mint TEXT,
  -- 1 = aset manual sama dengan posisi wallet (chain + simbol/mint sama) →
  -- disembunyikan dari UI (tidak dihapus; kembali tampil bila wallet dihapus).
  superseded_by_wallet INTEGER NOT NULL DEFAULT 0,
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

-- Linked public wallets for LP auto-refresh (address only, never secrets).
CREATE TABLE IF NOT EXISTS wallet_links (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chain, address)
);

-- Wallet registry (read-only, address only). network_type auto-detected.
CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL UNIQUE,
  network_type TEXT NOT NULL CHECK (network_type IN ('solana','evm')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Normalized snapshot of every wallet position (tokens, LP, staking, defi).
CREATE TABLE IF NOT EXISTS wallet_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('token','lp','staking','defi')),
  protocol TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  amount TEXT NOT NULL DEFAULT '0',
  price_usd REAL,
  value_usd REAL,
  meta TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wallet_positions_wallet ON wallet_positions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_positions_kind ON wallet_positions(kind);

-- Structured LP detail (no PnL columns by design).
CREATE TABLE IF NOT EXISTS lp_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  pool_address TEXT NOT NULL DEFAULT '',
  pair TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT '',
  chain_id TEXT NOT NULL DEFAULT '',
  position_value_usd REAL,
  unclaimed_fees_usd REAL,
  pool_tvl_usd REAL,
  in_range INTEGER,
  position_address TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (wallet_id, protocol, pool_address, position_address)
);
CREATE INDEX IF NOT EXISTS idx_lp_positions_wallet ON lp_positions(wallet_id);

-- Per-provider sync health. units_remaining tracks DeBank quota.
CREATE TABLE IF NOT EXISTS sync_status (
  provider TEXT NOT NULL,
  wallet_id INTEGER REFERENCES wallets(id) ON DELETE CASCADE,
  last_success_at TEXT,
  last_error TEXT,
  units_remaining INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, wallet_id)
);

-- Real DeBank unit measurements per EVM cycle (never guessed).
CREATE TABLE IF NOT EXISTS debank_meter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  measured_at TEXT NOT NULL DEFAULT (datetime('now')),
  units_before INTEGER,
  units_after INTEGER,
  units_used INTEGER,
  calls_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_debank_meter_time ON debank_meter(measured_at);

-- User-filled buy prices for wallet tokens (read-only positions).
-- P/L for wallet tokens is shown ONLY when a row exists here; otherwise "-".
CREATE TABLE IF NOT EXISTS cost_basis (
  symbol TEXT PRIMARY KEY,
  buy_price_idr INTEGER NOT NULL CHECK (buy_price_idr >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
