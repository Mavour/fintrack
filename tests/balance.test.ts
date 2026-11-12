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

  it('can edit spent income metadata and increase its amount', () => {
    const a = createAccount(db, { name: 'Tunai', type: 'cash', balance_idr: 0 });
    const tx = createTransaction(db, { kind: 'income', amount_idr: 100_000, account_id: a.id, category: 'Gaji', note: '' });
    createTransaction(db, { kind: 'expense', amount_idr: 100_000, account_id: a.id, category: 'Makan', note: '' });

    expect(updateTransaction(db, tx.id, { note: 'Updated' }).note).toBe('Updated');
    updateTransaction(db, tx.id, { amount_idr: 120_000 });
    expect((db.prepare('SELECT balance_idr FROM accounts WHERE id = ?').get(a.id) as { balance_idr: number }).balance_idr).toBe(20_000);
  });

  it('can reduce a transfer when the recipient can cover only the difference', () => {
    const a = createAccount(db, { name: 'Bank', type: 'bank', balance_idr: 100_000 });
    const b = createAccount(db, { name: 'Tunai', type: 'cash', balance_idr: 0 });
    const tx = createTransaction(db, { kind: 'transfer', amount_idr: 100_000, account_id: a.id, to_account_id: b.id, category: 'Pindah', note: '' });
    createTransaction(db, { kind: 'expense', amount_idr: 80_000, account_id: b.id, category: 'Makan', note: '' });

    updateTransaction(db, tx.id, { amount_idr: 90_000 });
    expect((db.prepare('SELECT balance_idr FROM accounts WHERE id = ?').get(a.id) as { balance_idr: number }).balance_idr).toBe(10_000);
    expect((db.prepare('SELECT balance_idr FROM accounts WHERE id = ?').get(b.id) as { balance_idr: number }).balance_idr).toBe(10_000);
  });

  it.each(['income', 'transfer'] as const)('rejects deleting spent %s with a controlled error and rolls back', (kind) => {
    const a = createAccount(db, { name: 'Bank', type: 'bank', balance_idr: 100_000 });
    const b = createAccount(db, { name: 'Tunai', type: 'cash', balance_idr: 0 });
    const tx = createTransaction(db, { kind, amount_idr: 100_000, account_id: kind === 'income' ? b.id : a.id, to_account_id: kind === 'transfer' ? b.id : null, category: 'Dana', note: '' });
    createTransaction(db, { kind: 'expense', amount_idr: 100_000, account_id: b.id, category: 'Makan', note: '' });
    const before = db.prepare('SELECT * FROM accounts ORDER BY id').all();

    expect(() => deleteTransaction(db, tx.id)).toThrow(expect.objectContaining({ statusCode: 400, message: 'Insufficient balance' }));
    expect(db.prepare('SELECT * FROM accounts ORDER BY id').all()).toEqual(before);
    expect(getTransaction(db, tx.id)).toEqual(tx);
  });

  it('rolls back a transfer update that would overdraw the recipient', () => {
    const a = createAccount(db, { name: 'Bank', type: 'bank', balance_idr: 100_000 });
    const b = createAccount(db, { name: 'Tunai', type: 'cash', balance_idr: 0 });
    const tx = createTransaction(db, { kind: 'transfer', amount_idr: 100_000, account_id: a.id, to_account_id: b.id, category: 'Dana', note: '' });
    createTransaction(db, { kind: 'expense', amount_idr: 80_000, account_id: b.id, category: 'Makan', note: '' });
    const before = db.prepare('SELECT * FROM accounts ORDER BY id').all();

    expect(() => updateTransaction(db, tx.id, { amount_idr: 50_000, note: 'Rejected' })).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(db.prepare('SELECT * FROM accounts ORDER BY id').all()).toEqual(before);
    expect(getTransaction(db, tx.id)).toEqual(tx);
  });

  it('rejects updates beyond the safe integer limit', () => {
    const a = createAccount(db, { name: 'Tunai', type: 'cash', balance_idr: 0 });
    const tx = createTransaction(db, { kind: 'income', amount_idr: 1, account_id: a.id, category: 'Dana', note: '' });
    expect(() => updateTransaction(db, tx.id, { amount_idr: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(getTransaction(db, tx.id)).toEqual(tx);
  });

  it.each(['income', 'transfer'] as const)('rejects %s that would overflow the resulting balance', (kind) => {
    const a = createAccount(db, { name: 'Bank', type: 'bank', balance_idr: 1 });
    const b = createAccount(db, { name: 'Tunai', type: 'cash', balance_idr: Number.MAX_SAFE_INTEGER });
    const before = db.prepare('SELECT * FROM accounts ORDER BY id').all();

    expect(() => createTransaction(db, { kind, amount_idr: 1, account_id: kind === 'income' ? b.id : a.id, to_account_id: kind === 'transfer' ? b.id : null, category: 'Dana', note: '' })).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(db.prepare('SELECT * FROM accounts ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM transactions').all()).toEqual([]);
  });
});
