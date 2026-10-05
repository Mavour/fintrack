import type Database from 'better-sqlite3';
import { z } from 'zod';

export const AccountTypeSchema = z.enum(['bank', 'e_wallet', 'cash']);
export type AccountType = z.infer<typeof AccountTypeSchema>;

export const CreateAccountSchema = z.object({
  name: z.string().min(1).max(80),
  type: AccountTypeSchema,
  balance_idr: z.number().int().min(0),
});
export type CreateAccountInput = z.infer<typeof CreateAccountSchema>;

export const UpdateAccountSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  type: AccountTypeSchema.optional(),
  balance_idr: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
});
export type UpdateAccountInput = z.infer<typeof UpdateAccountSchema>;

export interface Account {
  id: number;
  name: string;
  type: AccountType;
  balance_idr: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export function listAccounts(db: Database.Database): Account[] {
  return db.prepare('SELECT * FROM accounts ORDER BY id').all() as Account[];
}

export function listActiveAccounts(db: Database.Database): Account[] {
  return db.prepare('SELECT * FROM accounts WHERE is_active = 1 ORDER BY id').all() as Account[];
}

export function getAccount(db: Database.Database, id: number): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account | undefined;
}

export function createAccount(db: Database.Database, input: CreateAccountInput): Account {
  const parsed = CreateAccountSchema.parse(input);
  const info = db
    .prepare(
      `INSERT INTO accounts (name, type, balance_idr) VALUES (?, ?, ?)`,
    )
    .run(parsed.name, parsed.type, parsed.balance_idr);
  return getAccount(db, Number(info.lastInsertRowid))!;
}

export function updateAccount(
  db: Database.Database,
  id: number,
  input: UpdateAccountInput,
): Account {
  const parsed = UpdateAccountSchema.parse(input);
  const existing = getAccount(db, id);
  if (!existing) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  const next = {
    name: parsed.name ?? existing.name,
    type: parsed.type ?? existing.type,
    balance_idr: parsed.balance_idr ?? existing.balance_idr,
    is_active: parsed.is_active === undefined ? existing.is_active : parsed.is_active ? 1 : 0,
  };
  db.prepare(
    `UPDATE accounts SET name = ?, type = ?, balance_idr = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(next.name, next.type, next.balance_idr, next.is_active, id);
  return getAccount(db, id)!;
}

export function deleteAccount(db: Database.Database, id: number): void {
  const txCount = db
    .prepare('SELECT COUNT(*) AS c FROM transactions WHERE account_id = ? OR to_account_id = ?')
    .get(id, id) as { c: number };
  if (txCount.c > 0) {
    throw Object.assign(new Error('Cannot delete account with transactions'), { statusCode: 400 });
  }
  const info = db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  if (info.changes === 0) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
}
