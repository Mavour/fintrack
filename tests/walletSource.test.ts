import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HyperliquidSpotProvider, __resetHyperliquidCache } from '../src/server/providers/hyperliquid.js';
import { dedupeHyperliquid } from '../src/server/services/walletSync.js';
import {
  setCostBasis,
  getCostBasis,
  deleteCostBasis,
  getWalletTokens,
  getUnifiedPortfolio,
  upsertAsset,
} from '../src/server/services/portfolioService.js';
import { createWallet } from '../src/server/services/walletRegistry.js';
import { commitPositions } from '../src/server/services/walletSync.js';
import { resetBreakers } from '../src/server/services/circuitBreaker.js';
import type { NormalizedPosition } from '../src/server/providers/walletTypes.js';

const EVM = '0x57843c3a9d30c55ad5f971a3e42df9e507fb4ffd';

function memDb(): Database.Database {
  const db = new Database(':memory:');
  const here = path.dirname(fileURLToPath(import.meta.url));
  db.exec(fs.readFileSync(path.join(here, '..', 'src', 'server', 'db', 'schema.sql'), 'utf-8'));
  db.prepare(`INSERT INTO fx_cache (pair, rate, fetched_at) VALUES ('USDIDR', 16000, datetime('now'))`).run();
  return db;
}

function hlFixture(): { state: unknown; meta: unknown } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(
    fs.readFileSync(path.join(here, '..', 'src', 'server', 'providers', 'fixtures', 'hyperliquid.example.json'), 'utf-8'),
  ) as { spotClearinghouseState: unknown; spotMetaAndAssetCtxs: unknown };
  return { state: raw.spotClearinghouseState, meta: raw.spotMetaAndAssetCtxs };
}

beforeEach(() => {
  resetBreakers();
  __resetHyperliquidCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetBreakers();
  __resetHyperliquidCache();
});

function stubHyperliquid(): void {
  const { state, meta } = hlFixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string };
      const payload = body.type === 'spotMetaAndAssetCtxs' ? meta : state;
      return { ok: true, status: 200, json: async () => payload, headers: { get: () => null } };
    }),
  );
}

describe('HyperCore provider (API resmi, tanpa tebakan)', () => {
  it('normalisasi saldo spot + harga midPx dari fixture', async () => {
    stubHyperliquid();
    const p = new HyperliquidSpotProvider();
    const out = await p.fetchPositions({ id: 1, label: 'EVM', address: EVM, network_type: 'evm' });
    const hype = out.find((o) => o.symbol === 'HYPE')!;
    expect(hype.chain_id).toBe('hypercore');
    expect(hype.protocol).toBe('hyperliquid-spot');
    expect(hype.amount).toBe('25.5');
    expect(hype.price_usd).toBeCloseTo(20.12);
    expect(hype.value_usd).toBeCloseTo(25.5 * 20.12);
    const usdc = out.find((o) => o.symbol === 'USDC')!;
    expect(usdc.price_usd).toBe(1);
    expect(usdc.value_usd).toBeCloseTo(140.25);
    // Saldo nol dilewati.
    expect(out.some((o) => o.symbol === 'XYZ')).toBe(false);
  });

  it('hanya untuk wallet EVM', async () => {
    stubHyperliquid();
    const p = new HyperliquidSpotProvider();
    const out = await p.fetchPositions({ id: 1, label: 'S', address: '3keq3cRtYuoPCYBUL4s6N52ePguGivSZpNU4fzSiPXpd', network_type: 'solana' });
    expect(out).toEqual([]);
  });

  it('respons tak sesuai skema → error terkontrol', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ bogus: 1 }), headers: { get: () => null } })));
    const p = new HyperliquidSpotProvider();
    await expect(p.fetchPositions({ id: 1, label: 'E', address: EVM, network_type: 'evm' })).rejects.toThrow(/skema/);
  });

  it('koin tanpa pair USDC → harga null (tidak dikarang)', async () => {
    const { state } = hlFixture();
    const st = state as { balances: Array<Record<string, unknown>> };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string };
        if (body.type === 'spotMetaAndAssetCtxs') {
          return { ok: true, status: 200, json: async () => [[{ tokens: [], universe: [] }], []], headers: { get: (): string | null => null } };
        }
        return {
          ok: true, status: 200,
          json: async () => ({ balances: [...st.balances, { coin: 'NOPAIR', token: 5, hold: '0', total: '10', entryNtl: '0' }] }),
          headers: { get: (): string | null => null },
        };
      }),
    );
    const p = new HyperliquidSpotProvider();
    const out = await p.fetchPositions({ id: 1, label: 'E', address: EVM, network_type: 'evm' });
    expect(out.find((o) => o.symbol === 'NOPAIR')?.price_usd).toBeNull();
    expect(out.find((o) => o.symbol === 'NOPAIR')?.value_usd).toBeNull();
  });
});

describe('dedupe Hyperliquid vs DeBank', () => {
  const row = (symbol: string, chain: string, protocol: string, value = 10): NormalizedPosition => ({
    chain_id: chain, kind: 'token', protocol, symbol, name: symbol, amount: '1',
    price_usd: value, value_usd: value, meta: {},
  });

  it('baris DeBank hyperliquid untuk koin yang sama dibuang', () => {
    const { kept, dropped } = dedupeHyperliquid([
      row('HYPE', 'hypercore', 'hyperliquid-spot', 500),
      row('HYPE', 'arb', 'hyperliquid', 500), // DeBank Main-Account Spot → dobel
      row('USDC', 'eth', 'debank', 100),
    ]);
    expect(dropped).toBe(1);
    expect(kept.map((k) => `${k.symbol}@${k.chain_id}`).sort()).toEqual(['HYPE@hypercore', 'USDC@eth']);
  });

  it('tanpa HyperCore → DeBank dipertahankan semua', () => {
    const { kept, dropped } = dedupeHyperliquid([row('HYPE', 'arb', 'hyperliquid'), row('ETH', 'eth', 'debank')]);
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(2);
  });

  it('koin berbeda tidak ikut terbuang', () => {
    const { kept } = dedupeHyperliquid([
      row('HYPE', 'hypercore', 'hyperliquid-spot'),
      row('PURR', 'arb', 'hyperliquid'),
    ]);
    expect(kept).toHaveLength(2);
  });
});

describe('cost_basis + P/L wallet', () => {
  function seedWallet(db: Database.Database): void {
    const w = createWallet(db, 'EVM Utama', EVM);
    commitPositions(db, w.id, [{
      chain_id: 'hypercore', kind: 'token', protocol: 'hyperliquid-spot', symbol: 'HYPE', name: 'Hyperliquid HYPE',
      amount: '25.5', price_usd: 20, value_usd: 510, meta: {},
    }], 'all');
  }

  it('tanpa cost basis → P/L null (UI "-")', () => {
    const db = memDb();
    seedWallet(db);
    const toks = getWalletTokens(db).tokens;
    expect(toks).toHaveLength(1);
    expect(toks[0].has_cost).toBe(false);
    expect(toks[0].cost_idr).toBeNull();
    expect(toks[0].pl_idr).toBeNull();
    expect(toks[0].pl_percent).toBeNull();
    expect(toks[0].value_idr).toBe(510 * 16000);
    db.close();
  });

  it('dengan cost basis → P/L dihitung dari input user', () => {
    const db = memDb();
    seedWallet(db);
    setCostBasis(db, 'hype', 400_000);
    expect(getCostBasis(db, 'HYPE')).toBe(400_000);
    const toks = getWalletTokens(db).tokens;
    expect(toks[0].has_cost).toBe(true);
    expect(toks[0].cost_idr).toBe(Math.round(400_000 * 25.5));
    expect(toks[0].pl_idr).toBe(toks[0].value_idr! - toks[0].cost_idr!);
    deleteCostBasis(db, 'HYPE');
    expect(getCostBasis(db, 'HYPE')).toBeNull();
    db.close();
  });
});

describe('duplikat manual vs wallet', () => {
  function seed(db: Database.Database): void {
    const w = createWallet(db, 'EVM Utama', EVM);
    commitPositions(db, w.id, [{
      chain_id: 'hypercore', kind: 'token', protocol: 'hyperliquid-spot', symbol: 'HYPE', name: 'Hyperliquid HYPE',
      amount: '25.5', price_usd: 20, value_usd: 510, meta: {},
    }], 'all');
    // Manual duplikat (qty bulat seperti di screenshot) + cost sendiri.
    upsertAsset(db, { type: 'crypto', symbol: 'HYPE', name: 'Hyperliquid', qty: '25', avg_buy_price_idr: 400_000 });
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source) VALUES ('HYPE', 320000, 'manual')`).run();
    // Saham tidak terpengaruh.
    upsertAsset(db, { type: 'saham', symbol: 'BBCA.JK', name: 'BCA', qty: '100', avg_buy_price_idr: 9800 });
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source) VALUES ('BBCA.JK', 10250, 'manual')`).run();
  }

  it('manual duplikat disembunyikan dari daftar, wallet tetap dihitung', () => {
    const db = memDb();
    seed(db);
    const u = getUnifiedPortfolio(db);
    // Manual HYPE (chain kosong) sama dengan wallet → tidak dirender sama sekali.
    expect(u.assets.find((a) => a.symbol === 'HYPE')).toBeUndefined();
    const flag = db.prepare('SELECT superseded_by_wallet FROM assets WHERE symbol = ?').get('HYPE') as { superseded_by_wallet: number };
    expect(flag.superseded_by_wallet).toBe(1);
    const bbca = u.assets.find((a) => a.symbol === 'BBCA.JK')!;
    expect(bbca).toBeDefined();
    // Total = BBCA manual + HYPE wallet (510×16000), BUKAN + HYPE manual (25×320000).
    const bbcaVal = 100 * 10250;
    const walletVal = 510 * 16000;
    expect(u.total_value_idr).toBe(bbcaVal + walletVal);
    expect(u.wallet_tokens.map((w) => w.symbol)).toContain('HYPE');
    db.close();
  });
});
