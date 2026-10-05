import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { logger } from '../logger.js';

/** Daily SQLite backup, keeps last N days. Uses VACUUM INTO (no external binary needed). */
export function runBackup(db: Database.Database, backupDir: string, retentionDays: number): string {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = path.join(backupDir, `app-${stamp}.db`);
  db.prepare(`VACUUM INTO ?`).run(dest);
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith('app-') && f.endsWith('.db'))
    .sort();
  while (files.length > retentionDays) {
    const oldest = files.shift()!;
    fs.rmSync(path.join(backupDir, oldest));
  }
  logger.info({ dest }, 'backup done');
  return dest;
}
