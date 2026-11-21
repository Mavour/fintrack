import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getAccount } from './accountService.js';
import { parseQty } from './money.js';
import { restoreWithdrawnAsset, withdrawAssetUnits, type WithdrawnAsset } from './portfolioService.js';

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
      AND id NOT IN (SELECT transaction_id FROM investment_withdrawals)
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

const InvestmentPaymentSchema = CreateTxSchema.pick({
  amount_idr: true, account_id: true, note: true, occurred_at: true,
}).extend({
  symbol: z.string().trim().min(1).max(40).transform((symbol) => symbol.toUpperCase()),
});
export const InvestmentWithdrawalSchema = z.discriminatedUnion('source', [
  InvestmentPaymentSchema.extend({
    source: z.literal('manual'),
    qty: z.string().trim().min(1).max(40).refine((qty) => {
      try { return parseQty(qty).gt(0); }
      catch { return false; }
    }, 'Masukkan jumlah unit yang lebih dari 0'),
  }),
  InvestmentPaymentSchema.extend({ source: z.literal('wallet') }),
]);

export const UpdateTxSchema = z.object({
  category: z.string().min(1).max(60).optional(),
  note: z.string().max(500).optional(),
  occurred_at: z.string().optional(),
  amount_idr: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  account_id: z.number().int().positive().optional(),
  to_account_id: z.number().int().positive().nullable().optional(),
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
  investment_symbol: string | null;
}

const selectTransactions = `SELECT transactions.*, investment_withdrawals.symbol AS investment_symbol
  FROM transactions LEFT JOIN investment_withdrawals ON transaction_id = transactions.id`;

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

type TxEffect = Pick<Tx, 'kind' | 'amount_idr' | 'account_id' | 'to_account_id'>;

/** Validate the net adjustment so an edit only needs funds to cover the difference. */
function adjustBalances(
  db: Database.Database,
  before?: TxEffect,
  after?: TxEffect,
): void {
  const deltas = new Map<number, bigint>();
  const add = (id: number, amount: bigint) => deltas.set(id, (deltas.get(id) ?? 0n) + amount);
  const collect = (tx: TxEffect, sign: bigint) => {
    const amount = BigInt(tx.amount_idr) * sign;
    add(tx.account_id!, tx.kind === 'income' ? amount : -amount);
    if (tx.kind === 'transfer') add(tx.to_account_id!, amount);
  };
  if (before) collect(before, -1n);
  if (after) collect(after, 1n);
  const update = db.prepare(`UPDATE accounts SET balance_idr = ?, updated_at = datetime('now') WHERE id = ?`);
  for (const [id, delta] of deltas) {
    if (delta === 0n) continue;
    const next = Number(BigInt(getBalance(db, id)) + delta);
    validateBalance(next);
    update.run(next, id);
  }
}

function validateShape(input: Pick<Tx, 'kind' | 'account_id'> & { to_account_id?: number | null }): void {
  if (input.kind === 'transfer') {
    if (!input.to_account_id) throw Object.assign(new Error('to_account_id required'), { statusCode: 400 });
    if (input.to_account_id === input.account_id)
      throw Object.assign(new Error('Cannot transfer to same account'), { statusCode: 400 });
  } else if (input.to_account_id) {
    throw Object.assign(new Error('to_account_id only for transfer'), { statusCode: 400 });
  }
}

export function requireActiveBank(db: Database.Database, id: number): void {
  const account = getAccount(db, id);
  if (account?.type !== 'bank' || !account.is_active) {
    throw Object.assign(new Error('Pilih rekening bank yang aktif'), { statusCode: 400 });
  }
}

function requireCashWithdrawalAccount(db: Database.Database, id: number, type: 'bank' | 'cash'): void {
  const account = getAccount(db, id);
  if (account?.type !== type || !account.is_active) {
    throw Object.assign(new Error('Tarik tunai harus dari akun bank aktif ke akun tunai aktif'), { statusCode: 400 });
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
      requireCashWithdrawalAccount(db, parsed.account_id, 'bank');
      requireCashWithdrawalAccount(db, parsed.to_account_id!, 'cash');
    }
    adjustBalances(db, undefined, { ...parsed, to_account_id: parsed.to_account_id ?? null });
    return insert();
  });
  const info = atomic.immediate();
  return getTransaction(db, Number(info.lastInsertRowid))!;
}

export function createInvestmentWithdrawal(db: Database.Database, input: z.infer<typeof InvestmentWithdrawalSchema>): Tx {
  const payment = InvestmentWithdrawalSchema.parse(input);
  const { symbol } = payment;
  return db.transaction(() => {
    requireActiveBank(db, payment.account_id);
    // Manual holdings supply units. Wallet holdings are updated by the wallet sync.
    const withdrawn = payment.source === 'manual' ? withdrawAssetUnits(db, symbol, payment.qty) : null;
    const tx = createTransaction(db, { ...payment, kind: 'income', category: 'Pencairan Investasi' });
    db.prepare('INSERT INTO investment_withdrawals (transaction_id, symbol, asset_id, qty, cost_idr) VALUES (?, ?, ?, ?, ?)')
      .run(tx.id, symbol, withdrawn?.asset_id ?? null, withdrawn?.qty ?? null, withdrawn?.cost_idr ?? null);
    return { ...tx, investment_symbol: symbol };
  }).immediate();
}

export function getTransaction(db: Database.Database, id: number): Tx | undefined {
  return db.prepare(`${selectTransactions} WHERE transactions.id = ?`).get(id) as Tx | undefined;
}

export function listTransactions(
  db: Database.Database,
  opts: { limit?: number; offset?: number; kind?: TxKind; month?: string } = {},
): Tx[] {
  const { limit = 50, offset = 0, kind, month } = opts;
  const where: string[] = [];
  const params: unknown[] = [];
  if (kind) {
    where.push(kind === 'income' ? 'kind = ? AND transaction_id IS NULL' : 'kind = ?');
    params.push(kind);
  }
  if (month) {
    // month format YYYY-MM
    where.push(`strftime('%Y-%m', occurred_at, '+8 hours') = ?`);
    params.push(month);
  }
  const sql = `${selectTransactions} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, limit, offset) as Tx[];
}

export function updateTransaction(db: Database.Database, id: number, input: UpdateTxInput): Tx {
  const parsed = UpdateTxSchema.parse(input);
  const atomic = db.transaction(() => {
    const existing = getTransaction(db, id);
    if (!existing) throw Object.assign(new Error('Transaction not found'), { statusCode: 404 });
    const next = {
      ...existing,
      amount_idr: parsed.amount_idr ?? existing.amount_idr,
      account_id: parsed.account_id ?? existing.account_id,
      to_account_id: parsed.to_account_id === undefined ? existing.to_account_id : parsed.to_account_id,
      category: parsed.category ?? existing.category,
      note: parsed.note ?? existing.note,
      occurred_at: parsed.occurred_at ?? existing.occurred_at,
    };
    validateShape(next);
    const withdrawal = existing.kind === 'transfer' && existing.category === 'Tarik Tunai';
    if (withdrawal) {
      if (next.account_id !== existing.account_id) requireCashWithdrawalAccount(db, next.account_id!, 'bank');
      if (next.to_account_id !== existing.to_account_id) requireCashWithdrawalAccount(db, next.to_account_id!, 'cash');
    }
    if (existing.investment_symbol && next.account_id !== existing.account_id) requireActiveBank(db, next.account_id!);
    adjustBalances(db, existing, next);
    db.prepare(
      `UPDATE transactions SET amount_idr = ?, account_id = ?, to_account_id = ?, category = ?, note = ?, occurred_at = ? WHERE id = ?`,
    ).run(
      next.amount_idr, next.account_id, next.to_account_id,
      withdrawal || existing.investment_symbol ? existing.category : next.category,
      next.note, next.occurred_at,
      id,
    );
    return getTransaction(db, id)!;
  });
  return atomic.immediate();
}

export function deleteTransaction(db: Database.Database, id: number): void {
  const atomic = db.transaction(() => {
    const existing = getTransaction(db, id);
    if (!existing) throw Object.assign(new Error('Transaction not found'), { statusCode: 404 });
    adjustBalances(db, existing);
    if (existing.investment_symbol) {
      const withdrawn = db.prepare('SELECT asset_id, qty, cost_idr FROM investment_withdrawals WHERE transaction_id = ? AND asset_id IS NOT NULL')
        .get(id) as WithdrawnAsset | undefined;
      if (withdrawn) restoreWithdrawnAsset(db, withdrawn);
    }
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  });
  atomic.immediate();
}
