import type Database from 'better-sqlite3';
import type { DlmmPosition, DlmmWalletSnapshot } from '../../shared/meteoraDlmm.js';
import { logger } from '../logger.js';
import { fetchDlmmPositionDetails } from '../providers/meteoraDlmm.js';
import { emitSyncDone } from './sse.js';
import { getWallet, type WalletRow } from './walletRegistry.js';
import type { LpRow } from './walletRead.js';

export async function refreshDlmmMonitor(
  db: Database.Database, wallet: WalletRow, read = fetchDlmmPositionDetails,
): Promise<void> {
  if (wallet.network_type !== 'solana') return;
  const now = Date.now();
  const started = db.prepare(`INSERT INTO meteora_dlmm_snapshots (wallet_id, wallet_address, attempted_at)
    SELECT id, address, ? FROM wallets WHERE id = ? AND address = ? AND network_type = 'solana'
    ON CONFLICT(wallet_id) DO UPDATE SET attempted_at = excluded.attempted_at
    WHERE wallet_address = excluded.wallet_address AND attempted_at <= ?`)
    .run(now, wallet.id, wallet.address, now - 60_000).changes;
  if (!started) return;

  let positions: DlmmPosition[];
  try {
    positions = await read(wallet.address);
  } catch {
    const result = db.prepare(`UPDATE meteora_dlmm_snapshots SET failed = 1
      WHERE wallet_id = ? AND wallet_address = ? AND attempted_at = ? AND failed = 0`)
      .run(wallet.id, wallet.address, now);
    if (result.changes) {
      emitSyncDone(['lp']);
      logger.warn({ walletId: wallet.id }, 'RPC pemantauan Meteora DLMM gagal');
    }
    return;
  }
  if (getWallet(db, wallet.id)?.address !== wallet.address) return;
  const result = db.prepare(`UPDATE meteora_dlmm_snapshots SET positions_json = ?, synced_at = ?, failed = 0
    WHERE wallet_id = ? AND wallet_address = ? AND attempted_at = ?`)
    .run(JSON.stringify(positions), Date.now(), wallet.id, wallet.address, now);
  if (result.changes) emitSyncDone(['lp']);
}

export function listDlmmMonitor(db: Database.Database, lp: LpRow[], walletId?: number): DlmmWalletSnapshot[] {
  const rows = db.prepare(`SELECT w.id, s.positions_json, s.synced_at, s.failed
    FROM wallets w LEFT JOIN meteora_dlmm_snapshots s ON s.wallet_id = w.id AND s.wallet_address = w.address
    WHERE w.network_type = 'solana' AND (? IS NULL OR w.id = ?) ORDER BY w.id`)
    .all(walletId ?? null, walletId ?? null) as Array<{ id: number; positions_json: string | null; synced_at: number | null; failed: number | null }>;
  const pairs = new Map(lp.filter((row) => row.protocol === 'Meteora DLMM' && row.pair && row.pair !== '/')
    .map((row) => [`${row.wallet_id}:${row.pool_address}`, row.pair]));
  const now = Date.now();
  return rows.map((row) => {
    const state = row.synced_at === null ? (row.failed ? 'unavailable' : 'pending')
      : row.failed || now - row.synced_at > 180_000 ? 'stale' : 'ready';
    const positions = row.positions_json ? JSON.parse(row.positions_json) as DlmmPosition[] : [];
    return {
      wallet_id: row.id, state,
      synced_at: row.synced_at === null ? null : new Date(row.synced_at).toISOString(),
      positions: positions.map((position) => ({ ...position, pair: pairs.get(`${row.id}:${position.pool_address}`) ?? null })),
    };
  });
}
