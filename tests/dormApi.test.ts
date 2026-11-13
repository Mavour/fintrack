import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readDormSnapshot } from '../src/server/services/dormSnapshot.js';
import { readDormApiOptions, openDormDatabase, startDormStatusServer, startDormApi } from '../src/server/dormApi.js';

const now = Date.parse('2026-11-12T00:30:00.000Z');
const at = new Date(now).toISOString();
const schema = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/server/db/schema.sql'), 'utf8');
const options = { dayTimeZone: 'Asia/Makassar', monthlyBudgetIdr: 3_200_000, fxMaxAgeSec: 86400, now };

function fixture(): Database.Database {
  const db = new Database(':memory:');
  db.exec(schema);
  db.prepare("INSERT INTO fx_cache (pair, rate, fetched_at) VALUES ('USDIDR',16000,?)").run(at);
  db.prepare("INSERT INTO accounts (name,type,balance_idr,is_active) VALUES ('Cash','cash',1000000,1),('Inactive','bank',9000000,0)").run();
  db.prepare("INSERT INTO assets (type,symbol,qty,avg_buy_price_idr,chain,mint) VALUES ('crypto','SOL','1',0,'solana','sol-mint'),('saham','BBCA.JK','10',0,NULL,NULL),('crypto','USDC','20',0,NULL,NULL)").run();
  for (const [symbol, price] of [['SOL', 1600000], ['BBCA.JK', 10000], ['USDC', 16000]]) {
    db.prepare('INSERT INTO price_cache (symbol,price_idr,source,fetched_at) VALUES (?,?,?,?)').run(symbol, price, 'manual', at);
  }
  db.prepare("INSERT INTO wallets (label,address,network_type) VALUES ('Wallet','private-wallet-address-not-for-api','solana')").run();
  const insert = db.prepare('INSERT INTO wallet_positions (wallet_id,chain_id,kind,protocol,symbol,amount,value_usd,meta,synced_at) VALUES (1,?,?,?,?,?,?,?,?)');
  insert.run('solana', 'token', 'rpc', 'SOL', '2', 300, JSON.stringify({ mint: 'sol-mint' }), at);
  insert.run('solana', 'defi', 'limit-order', 'USDC', '30', 30, JSON.stringify({ output_symbol: 'SOL' }), at);
  insert.run('solana', 'lp', 'Meteora', 'LP-DUPLICATE', '1', 999, '{}', at);
  db.prepare("INSERT INTO lp_positions (wallet_id,pool_address,pair,protocol,position_address,position_value_usd,unclaimed_fees_usd,synced_at) VALUES (1,'pool','SOL/USDC','Meteora','position',100,2,?)").run(at);
  db.prepare("INSERT INTO meta (key,value) VALUES ('pw_hash','private-password-hash')").run();
  return db;
}

function tx(db: Database.Database, kind: 'income' | 'expense' | 'transfer', amount: number, at: string) {
  db.prepare('INSERT INTO transactions (kind,amount_idr,account_id,to_account_id,category,note,occurred_at) VALUES (?,?,1,?,?,?,?)')
    .run(kind, amount, kind === 'transfer' ? 2 : null, 'Test', 'Fixture note', at);
}

describe('Agent Dorm read-only portfolio snapshot', () => {
  it('matches deduplicated values with no writes, no wallet addresses and no secrets', () => {
    const db = fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('API must not fetch providers'));
    try {
      const changes = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      db.pragma('query_only = ON');
      const s = readDormSnapshot(db, options);
      expect(s.agentId).toBe('portfolio');
      expect(s.metrics.netWorthUsd).toBeCloseTo(520.75);
      expect(s.metrics.accounts.find(a => a.type === 'cash')?.valueUsd).toBe(62.5);
      expect(s.metrics.accounts.find(a => a.type === 'lp')?.valueUsd).toBe(102);
      expect(s.metrics.accounts.find(a => a.type === 'stable')?.valueUsd).toBe(20);
      expect(s.metrics.accounts.find(a => a.type === 'spot')?.valueUsd).toBeCloseTo(336.25);
      expect(s.metrics.valuationComplete).toBe(true);
      expect(s.metrics.budget.monthlyUsd).toBe(200);
      expect((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(changes);
      expect((db.prepare("SELECT superseded_by_wallet AS flag FROM assets WHERE symbol='SOL'").get() as { flag: number }).flag).toBe(0);
      expect(JSON.stringify(s)).not.toContain('private-password-hash');
      expect(JSON.stringify(s)).not.toContain('private-wallet-address');
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); db.close(); }
  });

  it('cashflow uses local calendar boundaries, excludes transfers and future entries', () => {
    const db = fixture();
    try {
      tx(db, 'income', 160000, '2026-11-11T16:30:00Z');
      tx(db, 'expense', 32000, '2026-11-12T00:00:00Z');
      tx(db, 'transfer', 90000, '2026-11-12T00:15:00Z');
      tx(db, 'income', 8000, '2026-11-05T15:59:00Z');
      tx(db, 'expense', 16000, '2026-11-05T16:01:00Z');
      tx(db, 'expense', 4000, '2026-10-31T17:00:00Z');
      tx(db, 'expense', 50000, '2026-11-12T01:00:00Z');
      const s = readDormSnapshot(db, options);
      expect(s.metrics.cashflow).toEqual({ todayIncomeUsd: 10, todayExpenseUsd: 2, last7dIncomeUsd: 10, last7dExpenseUsd: 3, last30dIncomeUsd: 10.5, last30dExpenseUsd: 3.25 });
      expect(s.metrics.budget.monthSpentUsd).toBe(3.25);
      expect(s.metrics.transactions).toHaveLength(5);
      expect(s.metrics.transactions.every(t => t.kind !== ('transfer' as string))).toBe(true);
      expect(readDormSnapshot(db, { ...options, dayTimeZone: 'UTC' }).metrics.cashflow.todayIncomeUsd).toBe(0);
    } finally { db.close(); }
  });

  it('missing/stale FX or budget stay null, never a made-up USD rate or zero budget', () => {
    const db = fixture();
    try {
      tx(db, 'expense', 16000, '2026-11-12T00:00:00Z');
      db.prepare('DELETE FROM fx_cache').run();
      const s = readDormSnapshot(db, { ...options, monthlyBudgetIdr: null });
      expect(s.status).toBe('warn');
      expect(s.metrics.fx.rate).toBeNull();
      expect(s.metrics.netWorthUsd).toBeNull();
      expect(s.metrics.cashflow.todayExpenseUsd).toBeNull();
      expect(s.metrics.transactions[0].amountUsd).toBeNull();
      expect(s.metrics.native.cashflow.todayExpenseIdr).toBe(16000);
      expect(s.metrics.budgetConfigured).toBe(false);
      expect(s.metrics.budget.monthlyUsd).toBeNull();
      db.prepare("INSERT INTO fx_cache (pair,rate,fetched_at) VALUES ('USDIDR',16000,'2026-11-09T00:00:00Z')").run();
      expect(readDormSnapshot(db, options).metrics.fx.rate).toBeNull();
    } finally { db.close(); }
  });

  it('unpriced assets produce a partial subtotal and generic provider errors stay sanitized', () => {
    const db = fixture();
    try {
      db.prepare("DELETE FROM price_cache WHERE symbol='BBCA.JK'").run();
      db.prepare("INSERT INTO sync_status (provider,wallet_id,last_error) VALUES ('fixture',1,'secret-api-key-in-provider-error')").run();
      const s = readDormSnapshot(db, options);
      expect(s.metrics.netWorthUsd).toBeNull();
      expect(s.metrics.knownNetWorthUsd).toBeCloseTo(514.5);
      expect(s.metrics.valuationComplete).toBe(false);
      expect(s.metrics.unvaluedPositions).toBe(1);
      expect(JSON.stringify(s)).not.toContain('secret-api-key-in-provider-error');
    } finally { db.close(); }
  });

  it('cashflow aggregates all entries even when the transaction list is capped at 60', () => {
    const db = fixture();
    try {
      for (let i = 0; i < 70; i++) tx(db, 'income', 16000, '2026-11-12T00:00:00Z');
      const s = readDormSnapshot(db, options);
      expect(s.metrics.transactions).toHaveLength(60);
      expect(s.metrics.transactions[0].id).toBe('tx-70');
      expect(s.metrics.cashflow.todayIncomeUsd).toBe(70);
      expect(new Set(s.metrics.transactions.map(t => t.id)).size).toBe(60);
    } finally { db.close(); }
  });

  it('detects stale data in both SQLite and ISO timestamp formats', () => {
    const db = fixture();
    try {
      db.prepare("UPDATE price_cache SET fetched_at='2026-11-11T00:30:00.000Z'").run();
      db.prepare("UPDATE wallet_positions SET synced_at='2026-11-11 00:30:00'").run();
      const s = readDormSnapshot(db, options);
      expect(s.status).toBe('warn');
      expect(s.alerts.some(a => a.id === 'manual-prices-stale')).toBe(true);
      expect(s.alerts.some(a => a.id === 'wallet-data-stale')).toBe(true);
    } finally { db.close(); }
  });

  it('requires a separate API key, validates configuration, and defaults to port 9002', () => {
    expect(readDormApiOptions({}).enabled).toBe(false);
    expect(readDormApiOptions({ STATUS_API_KEY: 'test-key' }).port).toBe(9002);
    expect(() => readDormApiOptions({ STATUS_API_ENABLED: 'true' })).toThrow(/STATUS_API_KEY/);
    expect(() => readDormApiOptions({ STATUS_API_PORT: '9.5' })).toThrow();
    expect(() => readDormApiOptions({ STATUS_API_MONTHLY_BUDGET_IDR: '-1' })).toThrow();
    expect(() => readDormApiOptions({ STATUS_API_DAY_TIMEZONE: 'Bad/Zone' })).toThrow();
  });

  it('HTTP authenticates both endpoints and blocks mutation routes', async () => {
    const db = fixture();
    const opts = { ...readDormApiOptions({ STATUS_API_KEY: 'test-key' }), port: 0 };
    let failed = false;
    const server = await startDormStatusServer(opts, () => {
      if (failed) throw new Error('secret-db-path');
      return readDormSnapshot(db, options);
    });
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('No HTTP address');
      const base = `http://127.0.0.1:${addr.port}`;
      const headers = { Authorization: 'Bearer test-key' };
      expect((await fetch(base + '/status')).status).toBe(401);
      expect((await fetch(base + '/health')).status).toBe(401);
      expect((await fetch(base + '/status', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
      const res = await fetch(base + '/status', { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect((await res.json() as { agentId: string }).agentId).toBe('portfolio');
      expect((await fetch(base + '/api/transactions', { method: 'POST', headers })).status).toBe(405);
      expect((await fetch(base + '/missing', { headers })).status).toBe(404);
      failed = true;
      const error = await fetch(base + '/status', { headers });
      expect(error.status).toBe(503);
      expect(await error.text()).not.toContain('secret-db-path');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
    }
  });

  it('opens a truly readonly database and serves the cached snapshot without changing data', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fintrack-dorm-test-'));
    const file = path.join(dir, 'fixture.db');
    const original = new Database(file);
    original.exec(schema);
    original.close();
    try {
      const read = openDormDatabase(file);
      expect(read.readonly).toBe(true);
      expect(() => read.prepare("INSERT INTO accounts (name,type) VALUES ('blocked','cash')").run()).toThrow();
      read.close();
      const api = await startDormApi(file, { ...readDormApiOptions({ STATUS_API_KEY: 'test-key' }), port: 0 });
      try {
        const addr = api.server.address();
        if (!addr || typeof addr === 'string') throw new Error('No HTTP address');
        const get = () => fetch(`http://127.0.0.1:${addr.port}/status`, { headers: { Authorization: 'Bearer test-key' } }).then(r => r.json()) as Promise<{ updatedAt: string }>;
        const a = await get();
        const b = await get();
        expect(a.updatedAt).toBe(b.updatedAt);
        const check = openDormDatabase(file);
        expect((check.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(0);
        check.close();
      } finally { await api.close(); }
    } finally {
      for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
      fs.rmdirSync(dir);
    }
  });
});
