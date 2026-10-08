import type Database from 'better-sqlite3';
import { assertValidAddress, type NetworkType } from './address.js';
import { logger } from '../logger.js';
import { redactAddress } from './address.js';

export interface WalletRow {
  id: number;
  label: string;
  address: string;
  network_type: NetworkType;
  created_at: string;
}

export function listWallets(db: Database.Database): WalletRow[] {
  return db.prepare('SELECT * FROM wallets ORDER BY id').all() as WalletRow[];
}

export function getWallet(db: Database.Database, id: number): WalletRow | undefined {
  return db.prepare('SELECT * FROM wallets WHERE id = ?').get(id) as WalletRow | undefined;
}

export function createWallet(db: Database.Database, label: string, address: string, network?: NetworkType): WalletRow {
  const detected = assertValidAddress(address, network);
  try {
    const info = db
      .prepare('INSERT INTO wallets (label, address, network_type) VALUES (?, ?, ?)')
      .run(label.trim(), address.trim(), detected);
    return getWallet(db, Number(info.lastInsertRowid))!;
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) {
      throw Object.assign(new Error('Alamat wallet sudah terdaftar'), { statusCode: 409 });
    }
    throw e;
  }
}

export function updateWallet(
  db: Database.Database,
  id: number,
  patch: { label?: string; address?: string },
): WalletRow {
  const cur = getWallet(db, id);
  if (!cur) throw Object.assign(new Error('Wallet tidak ditemukan'), { statusCode: 404 });
  const nextLabel = patch.label !== undefined ? patch.label.trim() : cur.label;
  let nextAddr = cur.address;
  let nextNet = cur.network_type;
  if (patch.address !== undefined && patch.address.trim() !== cur.address) {
    nextNet = assertValidAddress(patch.address.trim());
    nextAddr = patch.address.trim();
  }
  try {
    db.prepare('UPDATE wallets SET label = ?, address = ?, network_type = ? WHERE id = ?').run(
      nextLabel,
      nextAddr,
      nextNet,
      id,
    );
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) {
      throw Object.assign(new Error('Alamat wallet sudah terdaftar'), { statusCode: 409 });
    }
    throw e;
  }
  return getWallet(db, id)!;
}

export function deleteWallet(db: Database.Database, id: number): void {
  const info = db.prepare('DELETE FROM wallets WHERE id = ?').run(id);
  if (info.changes === 0) throw Object.assign(new Error('Wallet tidak ditemukan'), { statusCode: 404 });
}

/** Seed wallets from SEED_WALLETS env (idempotent, address UNIQUE). No secrets involved. */
export function seedWallets(db: Database.Database, seeds: Array<{ label: string; address: string }>): number {
  let added = 0;
  for (const s of seeds) {
    try {
      const net = assertValidAddress(s.address.trim());
      const r = db
        .prepare('INSERT INTO wallets (label, address, network_type) VALUES (?, ?, ?) ON CONFLICT(address) DO NOTHING')
        .run(s.label.trim(), s.address.trim(), net);
      if (r.changes > 0) added++;
    } catch (e) {
      logger.warn({ err: e, addr: redactAddress(s.address) }, 'seed wallet skipped');
    }
  }
  return added;
}
