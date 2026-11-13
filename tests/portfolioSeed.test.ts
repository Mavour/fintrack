import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/server/db/database.js';
import { restorePortfolioSeed, type PortfolioSeed } from '../src/server/db/portfolioSeed.js';

const databases: Database.Database[] = [];
function memDb() { const db = new Database(':memory:'); runMigrations(db); databases.push(db); return db; }
function fixture(): PortfolioSeed {
  return { version: 1, capturedAt: '2026-11-13T00:00:00Z', tables: {
    accounts: [{ id: 1, name: 'Test Bank', type: 'bank', balance_idr: 6000 }],
    assets: [{ type: 'reksadana', symbol: 'TEST', name: 'Test fund', qty: '2.5', avg_buy_price_idr: 1333, total_cost_idr: 3333 }],
    wallets: [{ id: 1, label: 'Test', address: 'test-public-address', network_type: 'solana' }],
    wallet_positions: [{ wallet_id: 1, chain_id: 'solana', kind: 'token', symbol: 'TEST', amount: '2', price_usd: 3, value_usd: 6 }],
    lp_positions: [], wallet_links: [], cost_basis: [], asset_map: [], price_cache: [], price_history: [], fx_cache: [],
  } };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('bank and investment seed restore', () => {
  it('restores an empty database once, including wallet references and exact modal', () => {
    const db = memDb();
    expect(restorePortfolioSeed(db, false, fixture())).toBe(true);
    expect(db.prepare('SELECT balance_idr FROM accounts').get()).toEqual({ balance_idr: 6000 });
    expect(db.prepare('SELECT total_cost_idr FROM assets').get()).toEqual({ total_cost_idr: 3333 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM wallet_positions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.prepare('UPDATE accounts SET balance_idr=9000').run();
    expect(restorePortfolioSeed(db, false, fixture())).toBe(false);
    expect(db.prepare('SELECT balance_idr FROM accounts').get()).toEqual({ balance_idr: 9000 });
  });

  it('never overwrites existing user data during normal startup', () => {
    const db = memDb();
    db.prepare("INSERT INTO accounts(name,type,balance_idr) VALUES ('Existing','bank',123)").run();
    expect(restorePortfolioSeed(db, false, fixture())).toBe(false);
    expect(db.prepare('SELECT name,balance_idr FROM accounts').get()).toEqual({ name: 'Existing', balance_idr: 123 });
  });

  it('explicit replacement clears transaction history without applying balance reversals and preserves login', () => {
    const db = memDb();
    db.prepare("INSERT INTO accounts(id,name,type,balance_idr) VALUES (1,'Existing','bank',500)").run();
    db.prepare("INSERT INTO transactions(kind,amount_idr,account_id) VALUES ('expense',100,1)").run();
    db.prepare("INSERT INTO meta(key,value) VALUES ('password_hash','test-hash')").run();
    expect(restorePortfolioSeed(db, true, fixture())).toBe(true);
    expect(db.prepare('SELECT balance_idr FROM accounts').get()).toEqual({ balance_idr: 6000 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT value FROM meta WHERE key='password_hash'").get()).toEqual({ value: 'test-hash' });
  });

  it('rolls back an invalid replacement completely', () => {
    const db = memDb();
    db.prepare("INSERT INTO accounts(name,type,balance_idr) VALUES ('Existing','bank',123)").run();
    const bad = fixture(); bad.tables.assets[0]!.type = 'invalid';
    expect(() => restorePortfolioSeed(db, true, bad)).toThrow();
    expect(db.prepare('SELECT name,balance_idr FROM accounts').get()).toEqual({ name: 'Existing', balance_idr: 123 });
    expect(db.prepare("SELECT 1 FROM meta WHERE key='portfolio_seed_v1'").get()).toBeUndefined();
  });

  it('preserves total modal on releases without the total_cost_idr column', () => {
    const db = memDb(); db.exec('ALTER TABLE assets DROP COLUMN total_cost_idr');
    restorePortfolioSeed(db, false, fixture());
    const a = db.prepare('SELECT qty,avg_buy_price_idr FROM assets').get() as { qty: string; avg_buy_price_idr: number };
    expect(Math.round(Number(a.qty) * a.avg_buy_price_idr)).toBe(3333);
  });
});
