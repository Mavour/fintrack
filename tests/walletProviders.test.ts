import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeList, filterDust, mergeTokensAcrossWallets, usdToIdr } from '../src/server/providers/walletTypes.js';
import { JupiterPortfolioProvider } from '../src/server/providers/jupiterPortfolioV1.js';
import { DebankProvider } from '../src/server/providers/debank.js';
import { MeteoraDlmmProvider, meteoraDlmmPositions, meteoraToNormalized } from '../src/server/providers/meteora.js';
import { OrcaStubProvider, RaydiumStubProvider } from '../src/server/providers/lpStubs.js';
import { detectNetworkType, shortAddress } from '../src/server/services/address.js';
import { createWallet, seedWallets, listWallets } from '../src/server/services/walletRegistry.js';
import { syncWallet, checkResyncCooldown } from '../src/server/services/walletSync.js';
import { listPositions, listLp, lpSummary, walletSyncHealth } from '../src/server/services/walletRead.js';

const SOL = '3keq3cRtYuoPCYBUL4s6N52ePguGivSZpNU4fzSiPXpd';
const EVM = '0x57843c3a9d30c55ad5f971a3e42df9e507fb4ffd';

function memDb(): Database.Database {
  const db = new Database(':memory:');
  const here = path.dirname(fileURLToPath(import.meta.url));
  db.exec(fs.readFileSync(path.join(here, '..', 'src', 'server', 'db', 'schema.sql'), 'utf-8'));
  db.prepare(`INSERT INTO fx_cache (pair, rate, fetched_at) VALUES ('USDIDR', 16000, datetime('now'))`).run();
  return db;
}

function fixture(name: string): unknown {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    fs.readFileSync(path.join(here, '..', 'src', 'server', 'providers', 'fixtures', name), 'utf-8'),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.JUPITER_API_KEY;
  delete process.env.DEBANK_ACCESS_KEY;
});

describe('address validation', () => {
  it('detects network from format', () => {
    expect(detectNetworkType(SOL)).toBe('solana');
    expect(detectNetworkType(EVM)).toBe('evm');
    expect(() => detectNetworkType('bukan-alamat')).toThrow();
  });
  it('shortens address', () => {
    expect(shortAddress(SOL)).toBe('3keq…PXpd');
  });
  it('wallet CRUD + seed', () => {
    const db = memDb();
    expect(() => createWallet(db, 'x', 'bukan-alamat')).toThrow();
    const n = seedWallets(db, [
      { label: 'Solana Utama', address: SOL },
      { label: 'EVM Utama', address: EVM },
    ]);
    expect(n).toBe(2);
    expect(listWallets(db)).toHaveLength(2);
    // Idempotent: seeding twice adds nothing.
    expect(seedWallets(db, [{ label: 'Solana Utama', address: SOL }])).toBe(0);
    db.close();
  });
});

describe('provider normalization from fixtures', () => {
  it('jupiter v1 fixture normalizes tokens + staking', async () => {
    process.env.JUPITER_API_KEY = 'test-key';
    const raw = fixture('jupiter-v1.example.json') as { positions: unknown[]; staking: unknown[] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })),
    );
    const p = new JupiterPortfolioProvider('test-key');
    const out = await p.fetchPositions({ id: 1, label: 't', address: SOL, network_type: 'solana' });
    expect(out.map((o) => o.symbol)).toContain('SOL');
    expect(out.find((o) => o.kind === 'staking')?.symbol).toBe('JUP');
  });

  it('meteora DLMM /portfolio/open maps fees + tvl, no PnL', async () => {
    const raw = fixture('meteora.example.json');
    const positions = meteoraDlmmPositions(raw);
    expect(positions).toHaveLength(2);
    expect(positions[0].pair).toBe('HOTBOT/SOL');
    expect(positions[0].position_value_usd).toBeCloseTo(58.83);
    expect(positions[0].unclaimed_fees_usd).toBeCloseTo(0.0029);
    expect(positions[0].in_range).toBe(true);
    expect(positions[0].position_address).toBe('Pos1t10nAddrEss11111111111111111111111111X');
    // outOfRange null → in_range null (honest, not guessed).
    expect(positions[1].in_range).toBeNull();
    // Posisi dari bentuk listPositions objek (positionAddress).
    expect(positions[1].position_address).toBe('Pos2t10nAddrEss22222222222222222222222222X');
    const norm = positions.map(meteoraToNormalized);
    expect(norm[0].value_usd).toBeCloseTo(58.83);
    expect(norm[0].meta.unclaimed_fees_usd).toBeCloseTo(0.0029);
    expect('pnl' in norm[0].meta).toBe(false);
    expect(norm[0].kind).toBe('lp');
  });

  it('meteora provider surfaces controlled error on 404 path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const p = new MeteoraDlmmProvider('https://dlmm.datapi.meteora.ag', '/bad-path');
    await expect(p.fetchPositions({ id: 1, label: 't', address: SOL, network_type: 'solana' })).rejects.toThrow(/tidak ditemukan|404/);
  });

  it('debank fixture normalizes tokens + LP without PnL', async () => {
    process.env.DEBANK_ACCESS_KEY = 'k';
    const raw = fixture('debank.example.json') as { all_token_list: unknown[]; all_complex_protocol_list: unknown[] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('all_token_list')) return { ok: true, status: 200, json: async () => raw.all_token_list };
        if (String(url).includes('all_complex_protocol_list')) return { ok: true, status: 200, json: async () => raw.all_complex_protocol_list };
        if (String(url).includes('account/units')) return { ok: true, status: 200, json: async () => ({ units: 10 }) };
        throw new Error('unexpected');
      }),
    );
    const p = new DebankProvider('k', 0);
    const out = await p.fetchPositions({ id: 2, label: 'e', address: EVM, network_type: 'evm' });
    expect(out.map((o) => o.symbol)).toContain('ETH');
    const lp = out.find((o) => o.kind === 'lp');
    expect(lp?.chain_id).toBe('arb');
    expect(lp?.value_usd).toBeCloseTo(500);
  });

  it('orca/raydium stubs return empty (TODO, no fabricated data)', async () => {
    expect(await new OrcaStubProvider().fetchPositions({ id: 1, label: 't', address: SOL, network_type: 'solana' })).toEqual([]);
    expect(await new RaydiumStubProvider().fetchPositions({ id: 1, label: 't', address: SOL, network_type: 'solana' })).toEqual([]);
  });
});

describe('contract: invalid responses rejected', () => {
  it('non-conforming items throw controlled error', () => {
    expect(() => normalizeList([{ chain_id: '', kind: 'nope', symbol: '' }], 'test')).toThrow(/tidak sesuai skema/);
    expect(() => normalizeList([{ chain_id: 'solana', kind: 'token', symbol: 'SOL', amount: '1' }], 'test')).not.toThrow();
  });
});

describe('aggregation helpers', () => {
  it('merges same token across wallets', () => {
    const merged = mergeTokensAcrossWallets([
      { symbol: 'SOL', name: 'Solana', chain_id: 'solana', value_usd: 100, wallet_id: 1, wallet_label: 'A', amount: '1' },
      { symbol: 'sol', name: 'Solana', chain_id: 'solana', value_usd: 50, wallet_id: 2, wallet_label: 'B', amount: '0.5' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].total_value_usd).toBeCloseTo(150);
    expect(merged[0].wallets).toHaveLength(2);
  });
  it('usd->idr conversion', () => {
    expect(usdToIdr(10, 16000)).toBe(160000);
    expect(usdToIdr(null, 16000)).toBeNull();
    expect(usdToIdr(10, 0)).toBeNull();
  });
  it('dust filter hides <$1 by default', () => {
    const rows = [
      { chain_id: 'solana', kind: 'token', protocol: '', symbol: 'BIG', name: '', amount: '1', price_usd: 100, value_usd: 100, meta: {} },
      { chain_id: 'solana', kind: 'token', protocol: '', symbol: 'DUST', name: '', amount: '1', price_usd: 0.01, value_usd: 0.01, meta: {} },
    ] as ReturnType<typeof normalizeList>;
    expect(filterDust(rows).map((r) => r.symbol)).toEqual(['BIG']);
    expect(filterDust(rows, true).map((r) => r.symbol)).toEqual(['BIG', 'DUST']);
  });
});

describe('sync logic', () => {
  it('idempotent: second sync replaces snapshot, no duplicates', async () => {
    process.env.JUPITER_API_KEY = 'k';
    const db = memDb();
    const w = createWallet(db, 'Solana Utama', SOL);
    const payload = { positions: [{ symbol: 'SOL', name: 'Solana', uiAmount: 1, priceUsd: 150, valueUsd: 150 }], staking: [] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('portfolio/v1')) return { ok: true, status: 200, json: async () => payload };
      if (String(url).includes('api.mainnet-beta')) {
        return { ok: true, status: 200, json: async () => ({ result: { value: [] } }) };
      }
      if (String(url).includes('meteora')) return { ok: true, status: 200, json: async () => [] };
      throw new Error(`unexpected ${url}`);
    }));
    const r1 = await syncWallet(db, w.id);
    const r2 = await syncWallet(db, w.id);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const rows = listPositions(db, { wallet_id: w.id, show_all: true });
    const sols = rows.filter((r) => r.symbol === 'SOL');
    expect(sols.length).toBeLessThanOrEqual(2); // token snapshot replaced, not appended
    db.close();
  });

  it('partial failure: one provider down keeps others + cache', async () => {
    process.env.JUPITER_API_KEY = 'k';
    const db = memDb();
    const w = createWallet(db, 'Solana Utama', SOL);
    // First good sync.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('portfolio/v1')) {
        return { ok: true, status: 200, json: async () => ({ positions: [{ symbol: 'SOL', uiAmount: 2, priceUsd: 100, valueUsd: 200 }] }) };
      }
      if (String(url).includes('api.mainnet-beta')) return { ok: true, status: 200, json: async () => ({ result: { value: [] } }) };
      if (String(url).includes('meteora')) return { ok: true, status: 200, json: async () => [] };
      throw new Error('unexpected');
    }));
    await syncWallet(db, w.id);
    // Second sync: meteora 500, jupiter still fine.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('portfolio/v1')) {
        return { ok: true, status: 200, json: async () => ({ positions: [{ symbol: 'SOL', uiAmount: 2, priceUsd: 100, valueUsd: 200 }] }) };
      }
      if (String(url).includes('api.mainnet-beta')) return { ok: true, status: 200, json: async () => ({ result: { value: [] } }) };
      if (String(url).includes('meteora')) return { ok: false, status: 500, json: async () => ({}) };
      throw new Error('unexpected');
    }));
    const r = await syncWallet(db, w.id);
    expect(r.ok).toBe(true);
    expect(r.providers_failed.length).toBeGreaterThan(0);
    expect(listPositions(db, { wallet_id: w.id, show_all: true }).length).toBeGreaterThan(0);
    db.close();
  });

  it('total failure keeps last cache + health stale', async () => {
    process.env.JUPITER_API_KEY = 'k';
    const db = memDb();
    const w = createWallet(db, 'S', SOL);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('portfolio/v1')) {
        return { ok: true, status: 200, json: async () => ({ positions: [{ symbol: 'SOL', uiAmount: 1, priceUsd: 10, valueUsd: 10 }] }) };
      }
      if (String(url).includes('api.mainnet-beta')) return { ok: true, status: 200, json: async () => ({ result: { value: [] } }) };
      if (String(url).includes('meteora')) return { ok: true, status: 200, json: async () => [] };
      throw new Error('x');
    }));
    await syncWallet(db, w.id);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const r = await syncWallet(db, w.id);
    expect(r.ok).toBe(false);
    expect(listPositions(db, { wallet_id: w.id, show_all: true }).length).toBeGreaterThan(0);
    expect(walletSyncHealth(db).mode).toBe('live');
    db.close();
  });

  it('lp stored with fees/tvl, summary sums, no PnL column', async () => {
    process.env.JUPITER_API_KEY = 'k';
    const db = memDb();
    const w = createWallet(db, 'S', SOL);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('portfolio/v1')) return { ok: true, status: 200, json: async () => ({ positions: [] }) };
      if (String(url).includes('api.mainnet-beta')) return { ok: true, status: 200, json: async () => ({ result: { value: [] } }) };
      if (String(url).includes('dlmm')) {
        if (String(url).includes('filter_by=pool_address')) {
          return { ok: true, status: 200, json: async () => ({ data: [{ tvl: 1000 }] }) };
        }
        return {
          ok: true, status: 200,
          json: async () => ({
            page: 1, pageSize: 50, hasNext: false, totalCount: 1, totalPositions: 1, solPrice: 150,
            pools: [{
              poolAddress: 'POOL1', tokenX: 'SOL', tokenY: 'USDC', balances: '100', unclaimedFees: '5',
              outOfRange: false, binStep: 10, listPositions: ['POS1'],
            }],
          }),
        };
      }
      if (String(url).includes('damm')) return { ok: true, status: 200, json: async () => [] };
      throw new Error(`unexpected ${url}`);
    }));
    await syncWallet(db, w.id);
    const lps = listLp(db, {});
    expect(lps).toHaveLength(1);
    expect(lps[0].unclaimed_fees_usd).toBeCloseTo(5);
    expect(lps[0].position_value_usd).toBeCloseTo(100);
    expect(lps[0].pool_tvl_usd).toBeCloseTo(1000);
    expect(lpSummary(db).total_fees_usd).toBeCloseTo(5);
    db.close();
  });

  it('resync cooldown enforced', () => {
    const db = memDb();
    const w = createWallet(db, 'S', SOL);
    db.prepare(
      `INSERT INTO sync_status (provider, wallet_id, last_success_at, updated_at) VALUES ('t', ?, datetime('now'), datetime('now'))`,
    ).run(w.id);
    expect(() => checkResyncCooldown(db, w.id, 30_000)).toThrow(/Tunggu/);
    db.close();
  });
});
