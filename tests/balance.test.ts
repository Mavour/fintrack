import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccount } from '../src/server/services/accountService.js';
import {
  createTransaction,
  deleteTransaction,
  updateTransaction,
  getTransaction,
} from '../src/server/services/transactionService.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = fs.readFileSync(path.join(here, '..', 'src', 'server', 'db', 'schema.sql'), 'utf-8');
  db.exec(schema);
  return db;
}

describe('balance logic (atomic)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('expense Rp50.000 reduces BCA by exactly Rp50.000, delete restores', () => {
    const bca = createAccount(db, { name: 'BCA', type: 'bank', balance_idr: 1_000_000 });
    const tx = createTransaction(db, {
      kind: 'expense',
      amount_idr: 50_000,
      account_id: bca.id,
      category: 'Makan',
      note: 'test',
    });
    const after = db.prepare('SELECT balance_idr FROM accounts WHERE id = ?').get(bca.id) as { balance_idr: number };
    expect(after.balance_idr).toBe(950_000);
    deleteTransaction(db, tx.id);
    const restored = db.prepare('SELECT balance_idr FROM accounts WHERE id = ?').get(bca.id) as { balance_idr: number };
    expect(restored.balance_idr).toBe(1_000_000);
    expect(getTransaction(db, tx.id)).toBeUndefined();
  });

  it('income adds, transfer moves, update corrects balance', () => {
    const a = createAccount(db, { name: 'BCA', type: 'bank', balance_idr: 500_000 });
    const b = createAccount(db, { name: 'GoPay', type: 'e_wallet', balance_idr: 100_000 });
    createTransaction(db, { kind: 'income', amount_idr: 200_000, account_id: a.id, category: 'Gaji', note: '' });
    expect((db.prepare('SELECT balance_idr FROM accounts WHERE id = ?').get(a.id) as { balance_idr: number }).balance_idr).toBe(700_000);

    const t = createTransaction(db, { kind: 'transfer', amount_idr: 150_000, account_id: a.id, to_account_id: b.id, category: 'Pindah', note: '' });
    expect((db.prepare('SELECT balance_idr FROM accounts WHERE id = ?').get(a.id) as { balance_idr: number }).balance_idr).toBe(550_000);
    expect((db.prepare('SELECT balance_idr FROM accounts WHERE id = ?').get(b.id) as { balance_idr: number }).balance_idr).toBe(250_000);

    updateTransaction(db, t.id, { amount_idr: 100_000 });
    expect((db.prepare('SELECT balance_idr FROM accounts WHERE id = ?').get(a.id) as { balance_idr: number }).balance_idr).toBe(600_000);
    expect((db.prepare('SELECT balance_idr FROM accounts WHERE id = ?').get(b.id) as { balance_idr: number }).balance_idr).toBe(200_000);
  });

  it('rejects expense exceeding balance', () => {
    const a = createAccount(db, { name: 'Tunai', type: 'cash', balance_idr: 10_000 });
    expect(() =>
      createTransaction(db, { kind: 'expense', amount_idr: 50_000, account_id: a.id, category: 'X', note: '' }),
    ).toThrow();
  });
});
