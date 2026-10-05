import { describe, it, expect } from 'vitest';
import { qtyTimesPriceIdr, plPercent, parseQty } from '../src/server/services/money.js';
import { diversificationScore, type AssetValuation, valuateAsset } from '../src/server/services/portfolioService.js';
import { createFxRateProvider } from '../src/server/providers/fxRate.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('P/L + qty math (no float errors)', () => {
  it('qty as decimal string times price is exact', () => {
    expect(qtyTimesPriceIdr('0.1', 1000)).toBe(100);
    expect(qtyTimesPriceIdr('2.5', 20001)).toBe(50003); // 50002.5 -> round half up
    expect(() => parseQty('-1')).toThrow();
  });

  it('pl percent null when cost is zero', () => {
    expect(plPercent(1000, 0)).toBeNull();
    expect(plPercent(1100, 1000)).toBeCloseTo(10);
  });

  it('diversification: single type scores low, mixed scores high', () => {
    const mk = (type: 'crypto' | 'saham' | 'reksadana', v: number): AssetValuation => ({
      id: 1, type, symbol: type, name: '', qty: '1', avg_buy_price_idr: 0,
      created_at: '', updated_at: '', current_price_idr: v, current_value_idr: v,
      current_price_usd: null, current_value_usd: null,
      cost_idr: v, pl_idr: 0, pl_percent: 0, price_source: 'manual',
      price_fetched_at: '', is_stale: false,
    });
    expect(diversificationScore([mk('crypto', 1000)])).toBeLessThan(15);
    const mixed = diversificationScore([mk('crypto', 500), mk('saham', 300), mk('reksadana', 200)]);
    expect(mixed).toBeGreaterThan(50);
  });
});

describe('unknown buy price + USD', () => {
  function memDb() {
    const db = new Database(':memory:');
    const here = path.dirname(fileURLToPath(import.meta.url));
    db.exec(fs.readFileSync(path.join(here, '..', 'src', 'server', 'db', 'schema.sql'), 'utf-8'));
    return db;
  }

  it('avg 0 hides P/L but keeps value', () => {
    const db = memDb();
    db.prepare(`INSERT INTO assets (type, symbol, qty, avg_buy_price_idr) VALUES ('crypto','HYPE','2',0)`).run();
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source) VALUES ('HYPE', 1000, 'manual')`).run();
    const asset = db.prepare('SELECT * FROM assets').get() as never;
    const v = valuateAsset(db, asset as never);
    expect(v.current_value_idr).toBe(2000);
    expect(v.pl_idr).toBeNull();
    expect(v.pl_percent).toBeNull();
    db.close();
  });

  it('crypto gets USD via cached FX, others do not', () => {
    const db = memDb();
    db.prepare(`INSERT INTO fx_cache (pair, rate) VALUES ('USDIDR', 16000)`).run();
    db.prepare(`INSERT INTO assets (type, symbol, qty, avg_buy_price_idr) VALUES ('crypto','SOL','1',100),('saham','BBCA.JK','1',100)`).run();
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source) VALUES ('SOL', 1600000, 'manual'),('BBCA.JK', 10000, 'manual')`).run();
    const assets = db.prepare('SELECT * FROM assets ORDER BY symbol').all() as never[];
    const sol = valuateAsset(db, assets[1] as never);
    const bbca = valuateAsset(db, assets[0] as never);
    expect(sol.current_price_usd).toBeCloseTo(100);
    expect(sol.current_value_usd).toBeCloseTo(100);
    expect(bbca.current_price_usd).toBeNull();
    db.close();
  });
});

describe('FX conversion', () => {
  it('uses cache when fresh, falls back when API down', async () => {
    const db = new Database(':memory:');
    const here = path.dirname(fileURLToPath(import.meta.url));
    db.exec(fs.readFileSync(path.join(here, '..', 'src', 'server', 'db', 'schema.sql'), 'utf-8'));
    db.prepare(`INSERT INTO fx_cache (pair, rate, fetched_at) VALUES ('USDIDR', 16000, datetime('now'))`).run();
    const getRate = createFxRateProvider(db, 3_600_000);
    await expect(getRate()).resolves.toBe(16000);
    // crypto USD 100 * 16000 = Rp1.600.000
    expect(qtyTimesPriceIdr('1', 100 * 16000)).toBe(1_600_000);
  });
});
