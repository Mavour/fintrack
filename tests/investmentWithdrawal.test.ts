import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { runMigrations } from '../src/server/db/database.js';
import { registerPortfolioRoutes } from '../src/server/routes/portfolio.js';
import { registerTransactionRoutes } from '../src/server/routes/transactions.js';
import { createAccount, getAccount } from '../src/server/services/accountService.js';
import { getDashboard } from '../src/server/services/dashboardService.js';
import { getAssetBySymbol, upsertAsset } from '../src/server/services/portfolioService.js';
import { createTransaction } from '../src/server/services/transactionService.js';

describe('investment withdrawal and account corrections', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;
  let bank: number;
  let otherBank: number;
  let cash: number;
  const balance = (id: number) => getAccount(db, id)?.balance_idr;
  const withdraw = (payload: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/api/portfolio/withdrawals', payload,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    bank = createAccount(db, { name: 'Bank A', type: 'bank', balance_idr: 50_000 }).id;
    otherBank = createAccount(db, { name: 'Bank B', type: 'bank', balance_idr: 0 }).id;
    cash = createAccount(db, { name: 'Tunai', type: 'cash', balance_idr: 0 }).id;
    app = Fastify();
    registerPortfolioRoutes(app, db);
    registerTransactionRoutes(app, db);
  });

  afterEach(async () => { await app.close(); db.close(); });

  it.each([
    { type: 'reksadana', symbol: 'RD66', qty: '125.25', sold: '25.05', remaining: '100.2', cost: 100_000, remainingCost: 80_000 },
    { type: 'crypto', symbol: 'SOL', qty: '0.34567890123456789', sold: '0.34567890123456789', remaining: '0', cost: null, remainingCost: null },
    { type: 'saham', symbol: 'BBCA.JK', qty: '500', sold: '100', remaining: '400', cost: 5_000_000, remainingCost: 4_000_000 },
  ] as const)('books a $type withdrawal, moves it to another bank, and reverses it', async (asset) => {
    upsertAsset(db, { ...asset, name: '', avg_buy_price_idr: 10_000, total_cost_idr: asset.cost });
    const response = await withdraw({
      source: 'manual', symbol: asset.symbol, qty: asset.sold, account_id: bank, amount_idr: 30_000,
    });
    expect(response.statusCode).toBe(201);
    const tx = response.json();
    expect(tx).toMatchObject({ investment_symbol: asset.symbol, category: 'Pencairan Investasi', account_id: bank });
    expect(getAssetBySymbol(db, asset.symbol)).toMatchObject({ qty: asset.remaining, total_cost_idr: asset.remainingCost });
    expect(balance(bank)).toBe(80_000);
    expect(getDashboard(db).income_this_month_idr).toBe(0);
    const history = await app.inject({ method: 'GET', url: '/api/transactions' });
    expect(history.json()).toEqual([tx]);

    const url = `/api/transactions/${tx.id}`;
    expect((await app.inject({ method: 'PATCH', url, payload: { account_id: cash } })).statusCode).toBe(400);
    const edit = await app.inject({ method: 'PATCH', url, payload: { account_id: otherBank, amount_idr: 31_000 } });
    expect(edit.statusCode).toBe(200);
    expect(balance(bank)).toBe(50_000);
    expect(balance(otherBank)).toBe(31_000);
    expect((await app.inject({ method: 'DELETE', url: `/api/portfolio/${asset.symbol}` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(200);
    expect(balance(otherBank)).toBe(0);
    expect(getAssetBySymbol(db, asset.symbol)).toMatchObject({ qty: asset.qty, total_cost_idr: asset.cost });
  });

  it('offers held assets by type even without manual prices and groups synced crypto as wallet', async () => {
    upsertAsset(db, { type: 'saham', symbol: 'BBCA.JK', name: 'BCA', qty: '500', avg_buy_price_idr: 10_000 });
    upsertAsset(db, { type: 'reksadana', symbol: 'RD66', name: 'Reksadana uji', qty: '120', avg_buy_price_idr: 0 });
    upsertAsset(db, { type: 'crypto', symbol: 'BTC', name: 'Bitcoin', qty: '0.01', avg_buy_price_idr: 0 });
    upsertAsset(db, { type: 'crypto', symbol: 'SOL', name: 'Solana', qty: '1', avg_buy_price_idr: 0 });
    upsertAsset(db, { type: 'saham', symbol: 'TLKM.JK', name: 'Telkom', qty: '0', avg_buy_price_idr: 0 });
    const wallet = db.prepare("INSERT INTO wallets (label, address, network_type) VALUES ('Wallet uji', 'fixture', 'solana')").run();
    db.prepare(`INSERT INTO wallet_positions (wallet_id, chain_id, kind, symbol, name, amount, value_usd)
      VALUES (?, 'solana', 'token', 'SOL', 'Solana', '1', 100)`).run(wallet.lastInsertRowid);

    const choices = await app.inject({ method: 'GET', url: '/api/portfolio/withdrawal-assets' });
    expect(choices.statusCode).toBe(200);
    expect(choices.json()).toEqual([
      { type: 'crypto', source: 'manual', key: 'BTC', symbol: 'BTC', name: 'Bitcoin', qty: '0.01' },
      { type: 'reksadana', source: 'manual', key: 'RD66', symbol: 'RD66', name: 'Reksadana uji', qty: '120' },
      { type: 'saham', source: 'manual', key: 'BBCA.JK', symbol: 'BBCA.JK', name: 'BCA', qty: '500' },
      { type: 'crypto', source: 'wallet', key: 'SOL:solana', symbol: 'SOL', name: 'Solana', chains: ['solana'] },
    ]);
    expect((await withdraw({ source: 'manual', symbol: 'SOL', qty: '1', amount_idr: 10_000, account_id: bank })).statusCode).toBe(400);
    expect(balance(bank)).toBe(50_000);
  });

  it('rolls back a failed withdrawal and records wallet proceeds without reducing manual units', async () => {
    upsertAsset(db, { type: 'crypto', symbol: 'SOL', name: '', qty: '2', avg_buy_price_idr: 10_000 });
    const manual = { source: 'manual', symbol: 'SOL', qty: '1', account_id: bank, amount_idr: 10_000 };
    expect((await withdraw({ ...manual, qty: '3' })).statusCode).toBe(400);
    expect((await withdraw({ ...manual, account_id: cash })).statusCode).toBe(400);
    expect((await withdraw({ ...manual, amount_idr: Number.MAX_SAFE_INTEGER })).statusCode).toBe(400);
    expect(getAssetBySymbol(db, 'SOL')?.qty).toBe('2');
    expect(balance(bank)).toBe(50_000);
    expect((await app.inject({ method: 'GET', url: '/api/transactions' })).json()).toEqual([]);
    db.prepare("INSERT INTO wallets (id, address, network_type) VALUES (1, 'test-wallet', 'solana')").run();
    db.prepare("INSERT INTO wallet_positions (wallet_id, chain_id, kind, symbol, amount) VALUES (1, 'solana', 'token', 'SOL', '1')").run();
    const wallet = await withdraw({ source: 'wallet', symbol: 'sol', account_id: bank, amount_idr: 10_000 });
    expect(wallet.statusCode).toBe(201);
    expect(wallet.json().investment_symbol).toBe('SOL');
    expect(getAssetBySymbol(db, 'SOL')?.qty).toBe('2');
    expect(balance(bank)).toBe(60_000);
  });

  it('records distinct wallet contracts and rejects ambiguous or forged keys', async () => {
    db.prepare("INSERT INTO wallets (id, address, network_type) VALUES (1, 'test-wallet', 'solana')").run();
    const position = db.prepare("INSERT INTO wallet_positions (wallet_id, chain_id, kind, symbol, amount, meta) VALUES (1, 'solana', 'token', 'SAME', '1', ?)");
    for (const mint of ['MintA', 'MintB']) position.run(JSON.stringify({ mint }));
    const data = { source: 'wallet', symbol: 'SAME', account_id: bank, amount_idr: 10 };
    expect((await withdraw(data)).statusCode).toBe(400);
    expect((await withdraw({ ...data, asset_key: 'SAME:solana:MintC' })).statusCode).toBe(400);
    expect(balance(bank)).toBe(50_000);
    for (const mint of ['MintA', 'MintB']) {
      const key = `SAME:solana:${mint}`;
      const response = await withdraw({ ...data, asset_key: key });
      expect(response.statusCode).toBe(201);
      expect(response.json().investment_asset_key).toBe(key);
    }
    const history = (await app.inject('/api/transactions')).json();
    expect(history.map((tx: { investment_asset_key: string }) => tx.investment_asset_key)).toEqual(['SAME:solana:MintB', 'SAME:solana:MintA']);
  });

  it('rejects an invalid date before subtracting investment units', async () => {
    upsertAsset(db, { type: 'reksadana', symbol: 'RD66', name: 'Reksadana uji', qty: '2', avg_buy_price_idr: 1000 });
    const response = await withdraw({ source: 'manual', symbol: 'RD66', qty: '1', account_id: bank, amount_idr: 1000, occurred_at: '2026-02-30' });
    expect(response.statusCode).toBe(400);
    expect(getAssetBySymbol(db, 'RD66')?.qty).toBe('2');
    expect(balance(bank)).toBe(50_000);
  });

  it('corrects the source and destination of existing transactions atomically', async () => {
    const transfer = createTransaction(db, { kind: 'transfer', account_id: bank, to_account_id: otherBank, amount_idr: 30_000, category: 'Pindah Dana', note: '' });
    const expense = createTransaction(db, { kind: 'expense', account_id: otherBank, amount_idr: 28_000, category: 'Makan', note: '' });
    const patch = (id: number, payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, payload });
    expect((await patch(transfer.id, { account_id: cash, to_account_id: bank })).statusCode).toBe(400);
    expect([balance(bank), balance(otherBank), balance(cash)]).toEqual([20_000, 2_000, 0]);
    expect((await patch(expense.id, { account_id: bank })).statusCode).toBe(400);
    expect((await patch(transfer.id, { amount_idr: 5_000, to_account_id: cash })).statusCode).toBe(400);
    expect((await patch(transfer.id, { amount_idr: 29_000 })).statusCode).toBe(200);
    expect([balance(bank), balance(otherBank), balance(cash)]).toEqual([21_000, 1_000, 0]);
    expect((await patch(expense.id, { amount_idr: 20_000, account_id: bank })).statusCode).toBe(200);
    expect((await patch(transfer.id, { account_id: otherBank, to_account_id: cash, amount_idr: 500 })).statusCode).toBe(400);
    expect((await patch(transfer.id, { to_account_id: cash })).statusCode).toBe(200);
    expect([balance(bank), balance(otherBank), balance(cash)]).toEqual([1_000, 0, 29_000]);
  });
});
