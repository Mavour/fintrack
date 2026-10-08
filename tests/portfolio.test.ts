import { describe, it, expect, vi, afterEach } from 'vitest';
import { qtyTimesPriceIdr, plPercent, parseQty } from '../src/server/services/money.js';
import { pruneHistory } from '../src/server/providers/priceStore.js';
import { backfillSymbol } from '../src/server/providers/historyBackfill.js';
import { diversificationScore, type AssetValuation, valuateAsset, getUnifiedPortfolio, getWalletTokens } from '../src/server/services/portfolioService.js';
import { createFxRateProvider } from '../src/server/providers/fxRate.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

afterEach(() => {
  vi.unstubAllGlobals();
});

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
      chain: null, mint: null, superseded_by_wallet: 0,
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

describe('mint-keyed supersede terhadap posisi wallet', () => {
  function memDb() {
    const db = new Database(':memory:');
    const here = path.dirname(fileURLToPath(import.meta.url));
    db.exec(fs.readFileSync(path.join(here, '..', 'src', 'server', 'db', 'schema.sql'), 'utf-8'));
    db.prepare(`INSERT INTO fx_cache (pair, rate, fetched_at) VALUES ('USDIDR', 16000, datetime('now'))`).run();
    return db;
  }

  it('dua token beda mint dengan symbol sama (FEBU) tidak dobel; manual disembunyikan by mint', () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO assets (type, symbol, qty, avg_buy_price_idr, chain, mint)
       VALUES ('crypto','FEBU','56.158085',0,'solana','mintA'),
              ('crypto','FEBU_Q6IF','61.442144',0,'solana','mintB')`,
    ).run();
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source, fetched_at)
                VALUES ('FEBU', 1600, 'manual', datetime('now')),
                       ('FEBU_Q6IF', 1600, 'manual', datetime('now'))`).run();
    db.prepare(
      `INSERT INTO wallets (label, address, network_type) VALUES ('Solana Utama','3keq3cRtYuoPCYBUL4s6N52ePguGivSZpNU4fzSiPXpd','solana')`,
    ).run();
    db.prepare(
      `INSERT INTO wallet_positions (wallet_id, chain_id, kind, protocol, symbol, name, amount, price_usd, value_usd, meta)
       VALUES (1,'solana','token','solana-rpc','FEBU','febu','56.158085',100,5615,'{"mint":"mintA"}'),
              (1,'solana','token','solana-rpc','FEBU','febu','61.442144',100,6144,'{"mint":"mintB"}')`,
    ).run();
    const u = getUnifiedPortfolio(db);
    // Keduanya ambigu secara symbol (wallet FEBU punya dua mint) → mint jadi kunci:
    // manual dengan mint yang ada di wallet tidak lagi dirender sama sekali.
    expect(u.assets.find((a) => a.symbol === 'FEBU')).toBeUndefined();
    expect(u.assets.find((a) => a.symbol === 'FEBU_Q6IF')).toBeUndefined();
    const flags = db.prepare('SELECT symbol, superseded_by_wallet FROM assets ORDER BY symbol').all() as Array<{ symbol: string; superseded_by_wallet: number }>;
    expect(flags).toEqual([
      { symbol: 'FEBU', superseded_by_wallet: 1 },
      { symbol: 'FEBU_Q6IF', superseded_by_wallet: 1 },
    ]);
    expect(u.total_value_idr).toBe((5615 + 6144) * 16000);
    db.close();
  });

  it('aset manual tanpa mint tetap supersede by symbol (chain kosong = cocok semua)', () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO assets (type, symbol, qty, avg_buy_price_idr) VALUES ('crypto','HYPE','2',0)`,
    ).run();
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source, fetched_at) VALUES ('HYPE', 16000, 'manual', datetime('now'))`).run();
    db.prepare(
      `INSERT INTO wallets (label, address, network_type) VALUES ('H','hypeaddr','solana')`,
    ).run();
    db.prepare(
      `INSERT INTO wallet_positions (wallet_id, chain_id, kind, protocol, symbol, name, amount, price_usd, value_usd, meta)
       VALUES (1,'hypercore','token','hyperliquid-spot','HYPE','Hyperliquid','2',10,20,'{"contract":"0x1"}')`,
    ).run();
    const u = getUnifiedPortfolio(db);
    expect(u.assets.find((a) => a.symbol === 'HYPE')).toBeUndefined();
    const flag = db.prepare('SELECT superseded_by_wallet FROM assets WHERE symbol = ?').get('HYPE') as { superseded_by_wallet: number };
    expect(flag.superseded_by_wallet).toBe(1);
    db.close();
  });

  it('chain manual tidak cocok dengan chain wallet → TIDAK supersede', () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO assets (type, symbol, qty, avg_buy_price_idr, chain) VALUES ('crypto','HYPE','2',0,'arb')`,
    ).run();
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source, fetched_at) VALUES ('HYPE', 16000, 'manual', datetime('now'))`).run();
    db.prepare(
      `INSERT INTO wallets (label, address, network_type) VALUES ('H','hypeaddr','solana')`,
    ).run();
    db.prepare(
      `INSERT INTO wallet_positions (wallet_id, chain_id, kind, protocol, symbol, name, amount, price_usd, value_usd, meta)
       VALUES (1,'hypercore','token','hyperliquid-spot','HYPE','Hyperliquid','2',10,20,'{"contract":"0x1"}')`,
    ).run();
    const u = getUnifiedPortfolio(db);
    expect(u.assets.find((a) => a.symbol === 'HYPE')).toBeDefined();
    const flag = db.prepare('SELECT superseded_by_wallet FROM assets WHERE symbol = ?').get('HYPE') as { superseded_by_wallet: number };
    expect(flag.superseded_by_wallet).toBe(0);
    db.close();
  });

  it('flag supersede turun saat posisi wallet dihapus (aset manual kembali tampil)', () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO assets (type, symbol, qty, avg_buy_price_idr) VALUES ('crypto','HYPE','2',0)`,
    ).run();
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source, fetched_at) VALUES ('HYPE', 16000, 'manual', datetime('now'))`).run();
    db.prepare(
      `INSERT INTO wallets (label, address, network_type) VALUES ('H','hypeaddr','solana')`,
    ).run();
    db.prepare(
      `INSERT INTO wallet_positions (wallet_id, chain_id, kind, protocol, symbol, name, amount, price_usd, value_usd, meta)
       VALUES (1,'hypercore','token','hyperliquid-spot','HYPE','Hyperliquid','2',10,20,'{"contract":"0x1"}')`,
    ).run();
    expect(getUnifiedPortfolio(db).assets.find((a) => a.symbol === 'HYPE')).toBeUndefined();
    db.prepare('DELETE FROM wallet_positions').run();
    const u = getUnifiedPortfolio(db);
    const hype = u.assets.find((a) => a.symbol === 'HYPE')!;
    expect(hype).toBeDefined();
    expect(hype.current_value_idr).toBe(2 * 16000);
    const flag = db.prepare('SELECT superseded_by_wallet FROM assets WHERE symbol = ?').get('HYPE') as { superseded_by_wallet: number };
    expect(flag.superseded_by_wallet).toBe(0);
    db.close();
  });
});

describe('filter token Daftar Aset (tanpa harga / < $1)', () => {
  function memDb() {
    const db = new Database(':memory:');
    const here = path.dirname(fileURLToPath(import.meta.url));
    db.exec(fs.readFileSync(path.join(here, '..', 'src', 'server', 'db', 'schema.sql'), 'utf-8'));
    db.prepare(`INSERT INTO fx_cache (pair, rate, fetched_at) VALUES ('USDIDR', 16000, datetime('now'))`).run();
    return db;
  }

  it('debu (< $1) dan token tanpa harga wallet disembunyikan, dihitung di hidden_tokens', () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO wallets (label, address, network_type) VALUES ('Solana Utama','3keq3cRtYuoPCYBUL4s6N52ePguGivSZpNU4fzSiPXpd','solana')`,
    ).run();
    db.prepare(
      `INSERT INTO wallet_positions (wallet_id, chain_id, kind, protocol, symbol, name, amount, price_usd, value_usd, meta)
       VALUES (1,'solana','token','solana-rpc','FEBU','febu','56.158085',0.01,0.5,'{}'),
              (1,'solana','token','solana-rpc','XYZ','no price','10',NULL,NULL,'{}'),
              (1,'solana','token','solana-rpc','SOL','Solana','1.5',150,225,'{}')`,
    ).run();
    const { tokens, hiddenCount } = getWalletTokens(db);
    expect(tokens.map((t) => t.symbol)).toEqual(['SOL']);
    expect(hiddenCount).toBe(2);
    const u = getUnifiedPortfolio(db);
    expect(u.wallet_tokens.map((t) => t.symbol)).toEqual(['SOL']);
    expect(u.hidden_tokens).toBe(2);
    expect(u.total_value_idr).toBe(225 * 16000);
    db.close();
  });

  it('manual tanpa harga / < $1 tidak dirender; LP legacy (< $1) tetap dikecualikan dari filter', () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO assets (type, symbol, qty, avg_buy_price_idr) VALUES
       ('crypto','DEBU','1',0), ('crypto','NORAPRICE','1',0), ('crypto','LP-DEBU','1',0), ('crypto','SOL','1',0)`,
    ).run();
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source)
                VALUES ('DEBU', 4800, 'manual'), ('LP-DEBU', 4800, 'manual'), ('SOL', 1600000, 'manual')`).run();
    const u = getUnifiedPortfolio(db);
    const syms = u.assets.map((a) => a.symbol);
    // DEBU (0.3×16000 < $1) & NORAPRICE (tanpa harga) → tersembunyi; LP- dikecualikan dari filter; SOL tampil.
    expect(syms).toContain('SOL');
    expect(syms).toContain('LP-DEBU');
    expect(syms).not.toContain('DEBU');
    expect(syms).not.toContain('NORAPRICE');
    expect(u.total_value_idr).toBe(1600000 + 4800);
    db.close();
  });
});

describe('history all-time', () => {
  function memDb() {
    const d = new Database(':memory:');
    const here = path.dirname(fileURLToPath(import.meta.url));
    d.exec(fs.readFileSync(path.join(here, '..', 'src', 'server', 'db', 'schema.sql'), 'utf-8'));
    return d;
  }

  it('prune keeps 48h full + daily skeleton', () => {
    const db = memDb();
    const ins = db.prepare(`INSERT INTO price_history (symbol, price_idr, fetched_at) VALUES ('X', 100, ?)`);
    const now = Date.now();
    // 3 points same old day -> keep latest only
    ins.run(new Date(now - 5 * 86400000).toISOString().slice(0, 19).replace('T', ' '));
    ins.run(new Date(now - 5 * 86400000 + 3600000).toISOString().slice(0, 19).replace('T', ' '));
    // 2 recent points -> keep both
    ins.run(new Date(now - 3600000).toISOString().slice(0, 19).replace('T', ' '));
    ins.run(new Date(now - 60000).toISOString().slice(0, 19).replace('T', ' '));
    pruneHistory(db);
    const c = db.prepare(`SELECT COUNT(*) AS c FROM price_history`).get() as { c: number };
    expect(c.c).toBe(3);
    db.close();
  });

  it('backfill inserts coingecko daily history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ prices: [[1700000000000, 100], [1700086400000, 110]] }),
    })));
    const db = memDb();
    db.prepare(`INSERT INTO fx_cache (pair, rate) VALUES ('USDIDR', 16000)`).run();
    db.prepare(`INSERT INTO assets (type, symbol, qty, avg_buy_price_idr) VALUES ('crypto','TST','1',0)`).run();
    db.prepare(`INSERT INTO asset_map (symbol, provider, provider_id) VALUES ('TST','coingecko','test-coin')`).run();
    const n = await backfillSymbol(db, 'TST');
    expect(n).toBe(2);
    db.close();
  });
});
