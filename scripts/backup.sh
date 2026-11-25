#!/usr/bin/env bash
# Backup ad hoc atau cron eksternal untuk deployment tanpa jadwal bawaan.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
node --input-type=module <<'NODE'
import 'dotenv/config';
import Database from 'better-sqlite3';
import { runBackup } from './dist/server/jobs/backup.js';

const db = new Database(process.env.DATABASE_PATH ?? './data/app.db', { readonly: true, fileMustExist: true });
try {
  runBackup(db, process.env.BACKUP_DIR ?? './backups', Number(process.env.BACKUP_RETENTION_DAYS ?? 14));
} finally {
  db.close();
}
NODE
