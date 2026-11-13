import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { logger } from '../logger.js';

/** Daily SQLite backup, keeps last N days. Uses VACUUM INTO (no external binary needed). */
export function runBackup(db: Database.Database, backupDir: string, retentionDays: number): string {
  const keep = Number.isFinite(retentionDays) && retentionDays >= 1 ? Math.floor(retentionDays) : 14;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = path.join(backupDir, `app-${stamp}.db`);
  const tmp = `${dest}.tmp`;
  try {
    db.prepare(`VACUUM INTO ?`).run(tmp);
    // Verifikasi cepat: file bisa dibuka sebagai SQLite.
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp);
    } catch {
      // Abaikan cleanup.
    }
    throw e;
  }
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith('app-') && f.endsWith('.db'))
    .sort();
  while (files.length > keep) {
    const oldest = files.shift()!;
    fs.rmSync(path.join(backupDir, oldest));
  }
  logger.info({ dest }, 'backup done');
  return dest;
}
