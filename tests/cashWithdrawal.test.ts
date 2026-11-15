import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import fs from 'node:fs';
import { createAccount } from '../src/server/services/accountService.js';
import { createTransaction, deleteTransaction, getTransaction, updateTransaction } from '../src/server/services/transactionService.js';
import { getDashboard } from '../src/server/services/dashboardService.js';
import { registerTransactionRoutes } from '../src/server/routes/transactions.js';
import { txForm, wireTxAccounts, type TxAccountRef } from '../src/web/components/modal.js';

describe('cash withdrawal', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;
  let bank: number;
  let cash: number;
  const balances = () => db.prepare('SELECT balance_idr FROM accounts ORDER BY id').all();
  const withdrawal = () => ({ kind: 'withdrawal' as const, amount_idr: 200_000, account_id: bank, to_account_id: cash, category: 'Ignored', note: '' });
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(fs.readFileSync('src/server/db/schema.sql', 'utf8'));
    bank = createAccount(db, { name: 'Bank', type: 'bank', balance_idr: 1_000_000 }).id;
    cash = createAccount(db, { name: 'Tunai', type: 'cash', balance_idr: 50_000 }).id;
    app = Fastify();
    registerTransactionRoutes(app, db);
  });
  afterEach(async () => { await app.close(); db.close(); });

  it('moves bank funds into cash atomically without inflating income or expenses', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/transactions', payload: withdrawal() });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ kind: 'transfer', category: 'Tarik Tunai', account_id: bank, to_account_id: cash });
    expect(balances()).toEqual([{ balance_idr: 800_000 }, { balance_idr: 250_000 }]);
    const summary = getDashboard(db);
    expect(summary.total_cash_idr).toBe(1_050_000);
    expect(summary.income_this_month_idr).toBe(0);
    expect(summary.expense_this_month_idr).toBe(0);
  });

  it('corrects both balances when edited and restores both when deleted', () => {
    const tx = createTransaction(db, withdrawal());
    updateTransaction(db, tx.id, { amount_idr: 300_000 });
    expect(balances()).toEqual([{ balance_idr: 700_000 }, { balance_idr: 350_000 }]);
    deleteTransaction(db, tx.id);
    expect(balances()).toEqual([{ balance_idr: 1_000_000 }, { balance_idr: 50_000 }]);
    expect(getTransaction(db, tx.id)).toBeUndefined();
  });

  it.each(['wrong source', 'wrong destination', 'inactive source', 'inactive destination', 'insufficient balance', 'missing destination'] as const)('rejects %s without changing either balance', async (scenario) => {
    if (scenario === 'wrong source') db.prepare("UPDATE accounts SET type = 'e_wallet' WHERE id = ?").run(bank);
    if (scenario === 'wrong destination') db.prepare("UPDATE accounts SET type = 'bank' WHERE id = ?").run(cash);
    if (scenario === 'inactive source') db.prepare('UPDATE accounts SET is_active = 0 WHERE id = ?').run(bank);
    if (scenario === 'inactive destination') db.prepare('UPDATE accounts SET is_active = 0 WHERE id = ?').run(cash);
    const before = balances();
    const payload = { ...withdrawal(), ...(scenario === 'insufficient balance' ? { amount_idr: 2_000_000 } : {}), ...(scenario === 'missing destination' ? { to_account_id: null } : {}) };
    expect((await app.inject({ method: 'POST', url: '/api/transactions', payload })).statusCode).toBe(400);
    expect(balances()).toEqual(before);
    expect(db.prepare('SELECT * FROM transactions').all()).toEqual([]);
  });
});

describe('withdrawal account choices', () => {
  const accounts: TxAccountRef[] = [
    { id: 1, name: 'Bank', type: 'bank', is_active: 1 },
    { id: 2, name: 'Tunai', type: 'cash', is_active: 1 },
    { id: 3, name: 'E-wallet', type: 'e_wallet', is_active: 1 },
    { id: 4, name: 'Tunai lama', type: 'cash', is_active: 0 },
  ];

  it('offers the withdrawal option and preserves the cash destination when editing', () => {
    expect(txForm(accounts)).toContain('<option value="withdrawal" >Tarik Tunai</option>');
    const edit = txForm(accounts, 'withdrawal', { account_id: 1, to_account_id: 2, category: 'Tarik Tunai', lockKind: true, lockAccounts: true });
    expect(edit).toContain('Tarik Tunai — tidak bisa diubah');
    expect(edit).toContain('Ke akun: Tunai');
    expect(edit).toContain('id="f-cat" disabled');
  });

  it.each([true, false])('filters to active bank and cash accounts and handles missing cash (available=%s)', (hasCash) => {
    const nodes: Record<string, any> = {
      '#f-kind': { value: 'withdrawal', addEventListener() {} },
      '#f-acc': { tagName: 'SELECT', value: '3', innerHTML: '' },
      '#f-to': { value: '1', innerHTML: '' },
      '#f-to-wrap': { style: {} }, '#f-withdrawal-hint': {}, '#f-save': {},
      'label[for="f-acc"]': {}, 'label[for="f-to"]': {},
    };
    wireTxAccounts({ querySelector: (s: string) => nodes[s] } as unknown as HTMLElement, hasCash ? accounts : accounts.filter((a) => a.type !== 'cash'));
    expect(nodes['#f-acc'].innerHTML).toBe('<option value="1">Bank</option>');
    expect(nodes['#f-to'].innerHTML).toBe(hasCash ? '<option value="2">Tunai</option>' : '<option value="">Belum ada akun tunai aktif</option>');
    expect(nodes['#f-save'].disabled).toBe(!hasCash);
    expect(nodes['#f-to-wrap'].style.display).toBe('block');
  });
});
