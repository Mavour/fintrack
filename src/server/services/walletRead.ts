import type Database from 'better-sqlite3';

export interface PositionRow {
  id: number;
  wallet_id: number;
  wallet_label: string;
  wallet_address: string;
  network_type: string;
  chain_id: string;
  kind: string;
  protocol: string;
  symbol: string;
  name: string;
  amount: string;
  price_usd: number | null;
  value_usd: number | null;
  meta: Record<string, unknown>;
  synced_at: string;
}

export interface LpRow {
  id: number;
  wallet_id: number;
  wallet_label: string;
  pool_address: string;
  pair: string;
  protocol: string;
  chain_id: string;
  position_value_usd: number | null;
  unclaimed_fees_usd: number | null;
  pool_tvl_usd: number | null;
  in_range: number | null;
  position_address: string;
  synced_at: string;
}

export function listPositions(
  db: Database.Database,
  opts: { wallet_id?: number; kind?: string; chain_id?: string; show_all?: boolean; min_usd?: number } = {},
): PositionRow[] {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (opts.wallet_id) { conds.push('wp.wallet_id = ?'); args.push(opts.wallet_id); }
  if (opts.kind) { conds.push('wp.kind = ?'); args.push(opts.kind); }
  if (opts.chain_id) { conds.push('wp.chain_id = ?'); args.push(opts.chain_id); }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT wp.*, w.label AS wallet_label, w.address AS wallet_address, w.network_type
     FROM wallet_positions wp JOIN wallets w ON w.id = wp.wallet_id
     ${where} ORDER BY COALESCE(wp.value_usd, 0) DESC, wp.symbol`,
  ).all(...args) as Array<Omit<PositionRow, 'meta' | 'wallet_label' | 'wallet_address' | 'network_type'> & { meta: string; wallet_label: string; wallet_address: string; network_type: string }>;
  const min = opts.min_usd ?? 1;
  return rows
    .map((r) => ({ ...r, meta: safeJson(r.meta) }))
    .filter((r) => (opts.show_all ? true : (r.value_usd ?? Infinity) >= min));
}

export function listLp(db: Database.Database, opts: { wallet_id?: number; chain_id?: string } = {}): LpRow[] {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (opts.wallet_id) { conds.push('lp.wallet_id = ?'); args.push(opts.wallet_id); }
  if (opts.chain_id) { conds.push('lp.chain_id = ?'); args.push(opts.chain_id); }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  return db.prepare(
    `SELECT lp.*, w.label AS wallet_label FROM lp_positions lp JOIN wallets w ON w.id = lp.wallet_id
     ${where} ORDER BY COALESCE(lp.position_value_usd, 0) DESC`,
  ).all(...args) as LpRow[];
}

export function lpSummary(db: Database.Database): { total_fees_usd: number; total_position_usd: number; count: number } {
  const row = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(position_value_usd,0)),0) AS tvl, COALESCE(SUM(COALESCE(unclaimed_fees_usd,0)),0) AS fees FROM lp_positions`,
  ).get() as { count: number; tvl: number; fees: number };
  return { total_fees_usd: row.fees, total_position_usd: row.tvl, count: row.count };
}

export interface SyncStatusRow {
  provider: string;
  wallet_id: number | null;
  last_success_at: string | null;
  last_error: string | null;
  units_remaining: number | null;
  updated_at: string;
}

export function getSyncStatus(db: Database.Database, walletId?: number): SyncStatusRow[] {
  if (walletId) return db.prepare('SELECT * FROM sync_status WHERE wallet_id = ? ORDER BY provider').all(walletId) as SyncStatusRow[];
  return db.prepare('SELECT * FROM sync_status ORDER BY updated_at DESC').all() as SyncStatusRow[];
}

/** "Sinkron Live" hanya bila sync wallet terakhir berhasil < 15 menit. */
export function walletSyncHealth(db: Database.Database, liveMs = 15 * 60 * 1000): { mode: 'live' | 'stale' | 'empty'; last_success_at: string | null } {
  const row = db.prepare(`SELECT MAX(last_success_at) AS last_at FROM sync_status WHERE last_success_at IS NOT NULL`).get() as {
    last_at: string | null;
  };
  if (!row?.last_at) return { mode: 'empty', last_success_at: null };
  const age = Date.now() - new Date(row.last_at.endsWith('Z') ? row.last_at : row.last_at + 'Z').getTime();
  return { mode: age < liveMs ? 'live' : 'stale', last_success_at: row.last_at };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
