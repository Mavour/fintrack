import type Database from 'better-sqlite3';
import { z } from 'zod';

export const TxKindSchema = z.enum(['expense', 'income', 'transfer']);
export type TxKind = z.infer<typeof TxKindSchema>;

export const CreateCategorySchema = z.object({
  kind: z.enum(['expense', 'income']),
  name: z.string().trim().min(1, 'Nama kategori wajib diisi').max(60, 'Nama kategori maksimal 60 karakter'),
});

export function listTransactionCategories(db: Database.Database): Record<'expense' | 'income', string[]> {
  const rows = db.prepare(`
    SELECT kind, name FROM transaction_categories
    UNION
    SELECT kind, trim(category) AS name FROM transactions
    WHERE kind IN ('expense', 'income') AND length(trim(category)) BETWEEN 1 AND 60
    ORDER BY name COLLATE NOCASE
  `).all() as Array<{ kind: 'expense' | 'income'; name: string }>;
  const result: Record<'expense' | 'income', string[]> = { expense: [], income: [] };
  for (const row of rows) result[row.kind].push(row.name);
  return result;
}

export function createTransactionCategory(db: Database.Database, input: z.infer<typeof CreateCategorySchema>): { kind: 'expense' | 'income'; name: string } {
  const parsed = CreateCategorySchema.parse(input);
  db.prepare('INSERT INTO transaction_categories (kind, name) VALUES (?, ?) ON CONFLICT DO NOTHING')
    .run(parsed.kind, parsed.name);
  return db.prepare('SELECT kind, name FROM transaction_categories WHERE kind = ? AND name = ?')
    .get(parsed.kind, parsed.name) as { kind: 'expense' | 'income'; name: string };
}

export const CreateTxSchema = z.object({
  kind: z.enum(['expense', 'income', 'transfer', 'withdrawal']),
  amount_idr: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  account_id: z.number().int().positive(),
  to_account_id: z.number().int().positive().nullable().optional(),
  category: z.string().min(1).max(60).default('Lainnya'),
  note: z.string().max(500).default(''),
  occurred_at: z.string().optional(),
});
export type CreateTxInput = z.infer<typeof CreateTxSchema>;

export const UpdateTxSchema = z.object({
  category: z.string().min(1).max(60).optional(),
  note: z.string().max(500).optional(),
  occurred_at: z.string().optional(),
  amount_idr: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type UpdateTxInput = z.infer<typeof UpdateTxSchema>;

export interface Tx {
  id: number;
  kind: TxKind;
  amount_idr: number;
  account_id: number | null;
  to_account_id: number | null;
  category: string;
  note: string;
  occurred_at: string;
  created_at: string;
}

function getBalance(db: Database.Database, id: number): number {
  const row = db.prepare('SELECT balance_idr FROM accounts WHERE id = ?').get(id) as
    | { balance_idr: number }
    | undefined;
  if (!row) throw Object.assign(new Error(`Account ${id} not found`), { statusCode: 404 });
  return row.balance_idr;
}

function validateBalance(balance: number): void {
  if (balance < 0) throw Object.assign(new Error('Insufficient balance'), { statusCode: 400 });
  if (!Number.isSafeInteger(balance))
    throw Object.assign(new Error('Balance exceeds safe integer limit'), { statusCode: 400 });
}

/** Apply a transaction effect to balances. sign=+1 apply, sign=-1 revert. */
function applyEffect(
  db: Database.Database,
  tx: { kind: TxKind; amount_idr: number; account_id: number | null; to_account_id: number | null },
  sign: 1 | -1,
): void {
  if (tx.kind === 'expense') {
    const bal = getBalance(db, tx.account_id!);
    const next = bal - sign * tx.amount_idr;
    validateBalance(next);
    db.prepare(`UPDATE accounts SET balance_idr = ?, updated_at = datetime('now') WHERE id = ?`).run(
      next,
      tx.account_id,
    );
  } else if (tx.kind === 'income') {
    const bal = getBalance(db, tx.account_id!);
    const next = bal + sign * tx.amount_idr;
    validateBalance(next);
    db.prepare(`UPDATE accounts SET balance_idr = ?, updated_at = datetime('now') WHERE id = ?`).run(
      next,
      tx.account_id,
    );
  } else {
    const fromBal = getBalance(db, tx.account_id!);
    const toBal = getBalance(db, tx.to_account_id!);
    const nextFrom = fromBal - sign * tx.amount_idr;
    const nextTo = toBal + sign * tx.amount_idr;
    validateBalance(nextFrom);
    validateBalance(nextTo);
    db.prepare(`UPDATE accounts SET balance_idr = ?, updated_at = datetime('now') WHERE id = ?`).run(
      nextFrom,
      tx.account_id,
    );
    db.prepare(`UPDATE accounts SET balance_idr = ?, updated_at = datetime('now') WHERE id = ?`).run(
      nextTo,
      tx.to_account_id,
    );
  }
}

function validateShape(input: CreateTxInput): void {
  if (input.kind === 'transfer') {
    if (!input.to_account_id) throw Object.assign(new Error('to_account_id required'), { statusCode: 400 });
    if (input.to_account_id === input.account_id)
      throw Object.assign(new Error('Cannot transfer to same account'), { statusCode: 400 });
  } else if (input.to_account_id) {
    throw Object.assign(new Error('to_account_id only for transfer'), { statusCode: 400 });
  }
}

export function createTransaction(db: Database.Database, input: CreateTxInput): Tx {
  const request = CreateTxSchema.parse(input);
  const parsed = {
    ...request,
    kind: request.kind === 'withdrawal' ? 'transfer' as const : request.kind,
    category: request.kind === 'withdrawal' ? 'Tarik Tunai' : request.category,
  };
  validateShape(parsed);
  const occurred = parsed.occurred_at ?? new Date().toISOString();
  const insert = () =>
    db
      .prepare(
        `INSERT INTO transactions (kind, amount_idr, account_id, to_account_id, category, note, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.kind,
        parsed.amount_idr,
        parsed.account_id,
        parsed.kind === 'transfer' ? (parsed.to_account_id as number) : null,
        parsed.category,
        parsed.note,
        occurred,
      );
  const atomic = db.transaction(() => {
    if (request.kind === 'withdrawal') {
      const from = db.prepare('SELECT type, is_active FROM accounts WHERE id = ?').get(parsed.account_id) as { type: string; is_active: number } | undefined;
      const to = db.prepare('SELECT type, is_active FROM accounts WHERE id = ?').get(parsed.to_account_id) as { type: string; is_active: number } | undefined;
      if (from?.type !== 'bank' || !from.is_active || to?.type !== 'cash' || !to.is_active) {
        throw Object.assign(new Error('Tarik tunai harus dari akun bank aktif ke akun tunai aktif'), { statusCode: 400 });
      }
    }
    applyEffect(
      db,
      {
        kind: parsed.kind,
        amount_idr: parsed.amount_idr,
        account_id: parsed.account_id,
        to_account_id: parsed.kind === 'transfer' ? (parsed.to_account_id as number) : null,
      },
      1,
    );
    return insert();
  });
  const info = atomic();
  return getTransaction(db, Number(info.lastInsertRowid))!;
}

export function getTransaction(db: Database.Database, id: number): Tx | undefined {
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Tx | undefined;
}

export function listTransactions(
  db: Database.Database,
  opts: { limit?: number; offset?: number; kind?: TxKind; month?: string } = {},
): Tx[] {
  const { limit = 50, offset = 0, kind, month } = opts;
  const where: string[] = [];
  const params: unknown[] = [];
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  if (month) {
    // month format YYYY-MM
    where.push(`strftime('%Y-%m', occurred_at) = ?`);
    params.push(month);
  }
  const sql = `SELECT * FROM transactions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, limit, offset) as Tx[];
}

/**
 * Update supports changing amount/category/note/occurred_at.
 * Balance is corrected atomically by applying only the amount difference.
 * Account linkage is immutable (delete + recreate instead) to keep logic safe.
 */
export function updateTransaction(db: Database.Database, id: number, input: UpdateTxInput): Tx {
  const parsed = UpdateTxSchema.parse(input);
  const existing = getTransaction(db, id);
  if (!existing) throw Object.assign(new Error('Transaction not found'), { statusCode: 404 });
  const nextAmount = parsed.amount_idr ?? existing.amount_idr;
  const atomic = db.transaction(() => {
    if (nextAmount !== existing.amount_idr) applyEffect(
      db,
      {
        kind: existing.kind,
        amount_idr: nextAmount - existing.amount_idr,
        account_id: existing.account_id,
        to_account_id: existing.to_account_id,
      },
      1,
    );
    db.prepare(
      `UPDATE transactions SET amount_idr = ?, category = ?, note = ?, occurred_at = ? WHERE id = ?`,
    ).run(
      nextAmount,
      parsed.category ?? existing.category,
      parsed.note ?? existing.note,
      parsed.occurred_at ?? existing.occurred_at,
      id,
    );
  });
  atomic();
  return getTransaction(db, id)!;
}

export function deleteTransaction(db: Database.Database, id: number): void {
  const existing = getTransaction(db, id);
  if (!existing) throw Object.assign(new Error('Transaction not found'), { statusCode: 404 });
  const atomic = db.transaction(() => {
    applyEffect(db, existing, -1);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  });
  atomic();
}
