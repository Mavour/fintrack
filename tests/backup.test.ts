import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { runMigrations } from '../src/server/db/database.js';
import { runBackup } from '../src/server/jobs/backup.js';
import { createAccount } from '../src/server/services/accountService.js';
import { createTransaction } from '../src/server/services/transactionService.js';

it('restores balances and transactions and preserves the last backup if verification fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fintrack-backup-'));
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const account = createAccount(db, { name: 'Bank', type: 'bank', balance_idr: 1000 });
    createTransaction(db, { kind: 'expense', amount_idr: 250, account_id: account.id, category: 'Test', note: '' });
    const backup = runBackup(db, dir, 1);
    const restore = path.join(dir, 'restored.db');
    fs.copyFileSync(backup, restore);
    const restored = new Database(restore, { readonly: true });
    try {
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(restored.prepare('SELECT balance_idr FROM accounts').pluck().get()).toBe(750);
      expect(restored.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(1);
    } finally { restored.close(); }

    const older = path.join(dir, 'app-2000-01-01.db');
    fs.copyFileSync(backup, older);
    const previous = fs.readFileSync(backup);
    const prepare = vi.spyOn(db, 'prepare').mockReturnValue({
      run: (file: string) => fs.writeFileSync(file, 'invalid snapshot'),
    } as unknown as Database.Statement);
    try { expect(() => runBackup(db, dir, 1)).toThrow(); }
    finally { prepare.mockRestore(); }
    expect(fs.readFileSync(backup)).toEqual(previous);
    expect(fs.existsSync(older)).toBe(true);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('.backup-'))).toBe(false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
