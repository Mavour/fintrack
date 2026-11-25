import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '../logger.js';

/** Daily SQLite backup, keeps last N days. Uses VACUUM INTO (no external binary needed). */
export function runBackup(db: Database.Database, backupDir: string, retentionDays: number): string {
  const keep = Number.isFinite(retentionDays) && retentionDays >= 1 ? Math.floor(retentionDays) : 14;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = path.join(backupDir, `app-${stamp}.db`);
  const tmpDir = fs.mkdtempSync(path.join(backupDir, '.backup-'));
  const tmp = path.join(tmpDir, 'snapshot.db');
  try {
    db.prepare(`VACUUM INTO ?`).run(tmp);
    const snapshot = new Database(tmp, { readonly: true, fileMustExist: true });
    try {
      const result = snapshot.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (result.length !== 1 || result[0].integrity_check !== 'ok') {
        throw new Error('Integritas backup SQLite gagal');
      }
    } finally {
      snapshot.close();
    }
    fs.renameSync(tmp, dest);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp);
      fs.rmdirSync(tmpDir);
    } catch (err) {
      logger.warn({ err }, 'Pembersihan backup sementara gagal');
    }
  }
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  while (files.length > keep) {
    const oldest = files.shift()!;
    fs.rmSync(path.join(backupDir, oldest));
  }
  logger.info({ dest }, 'backup done');
  return dest;
}
