import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewHoldings, importHoldings } from '../src/server/services/walletService.js';
import { JupiterPriceProvider } from '../src/server/providers/jupiterPrice.js';
import { parseLpPositions, lpSymbol } from '../src/server/providers/jupiterPositions.js';
import { __resetTokenCache } from '../src/server/providers/solana.js';

const SOL = '3keq3cRtYuoPCYBUL4s6N52ePguGivSZpNU4fzSiPXpd';

function memDb(): Database.Database {
  const db = new Database(':memory:');
  const here = path.dirname(fileURLToPath(import.meta.url));
  db.exec(fs.readFileSync(path.join(here, '..', 'src', 'server', 'db', 'schema.sql'), 'utf-8'));
  db.prepare(`INSERT INTO fx_cache (pair, rate, fetched_at) VALUES ('USDIDR', 16000, datetime('now'))`).run();
  return db;
}

function stubJupiter() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const text = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (String(url).includes('/ultra/v1/holdings/')) {
        return text({
          amount: '1000000000',
          uiAmount: 1,
          uiAmountString: '1',
          tokens: {
            EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: [
              { amount: '5000000', uiAmountString: '5', decimals: 6 },
            ],
            DeadBeefDeadBeefDeadBeefDeadBeefDeadBeef99: [
              { amount: '0', uiAmountString: '0', decimals: 9 },
            ],
          },
        });
      }
      if (String(url).includes('/tokens/v2/tag')) {
        return text([{ id: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin' }]);
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  __resetTokenCache();
});

describe('wallet sync', () => {
  it('rejects invalid addresses', async () => {
    const db = memDb();
    await expect(previewHoldings(db, 'solana', 'bukan-alamat')).rejects.toThrow();
    await expect(previewHoldings(db, 'eth', '0x123')).rejects.toThrow();
    db.close();
  });

  it('previews SOL + known tokens, skips dust', async () => {
    stubJupiter();
    const db = memDb();
    const out = await previewHoldings(db, 'solana', SOL);
    const syms = out.map((h) => h.symbol);
    expect(syms).toContain('SOL');
    expect(syms).toContain('USDC');
    expect(out.find((h) => h.symbol === 'USDC')?.qty).toBe('5');
    db.close();
  });

  it('import sets chain qty, preserves existing avg buy', async () => {
    stubJupiter();
    const db = memDb();
    db.prepare(`INSERT INTO assets (type, symbol, qty, avg_buy_price_idr) VALUES ('crypto','USDC','1',15000)`).run();
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source) VALUES ('USDC', 16000, 'manual')`).run();
    const { imported } = await importHoldings(db, 'solana', SOL);
    expect(imported.find((i) => i.symbol === 'USDC')?.qty).toBe('5');
    const row = db.prepare('SELECT qty, avg_buy_price_idr FROM assets WHERE symbol = ?').get('USDC') as {
      qty: string;
      avg_buy_price_idr: number;
    };
    expect(row.qty).toBe('5');
    expect(row.avg_buy_price_idr).toBe(15000); // preserved, P/L kept
    const sol = db.prepare('SELECT qty, avg_buy_price_idr FROM assets WHERE symbol = ?').get('SOL') as {
      qty: string;
      avg_buy_price_idr: number;
    };
    expect(sol.qty).toBe('1');
    expect(sol.avg_buy_price_idr).toBe(0); // no cached price -> P/L hidden
    db.close();
  });

  it('hoodi without API key fails with friendly message', async () => {
    const db = memDb();
    await expect(
      previewHoldings(db, 'hoodi', '0xcc66dc8c9b4e597536740c04c6a0932770e3bafe'),
    ).rejects.toThrow(/API key/i);
    db.close();
  });

  it('jupiter provider prices mints by CoinGecko-free path', async () => {
    const db = memDb();
    db.prepare(`INSERT OR IGNORE INTO fx_cache (pair, rate) VALUES ('USDIDR', 16000)`).run();
    db.prepare(`INSERT INTO asset_map (symbol, provider, provider_id) VALUES ('WIF','jupiter','EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm')`).run();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { usdPrice: 1.5 } }),
      })),
    );
    const p = new JupiterPriceProvider(db, async () => 16000);
    const out = await p.fetch(['WIF']);
    expect(out).toHaveLength(1);
    expect(out[0].priceIdr).toBe(24000);
    expect(out[0].source).toBe('jupiter');
    db.close();
  });

  it('dust below $1 is skipped on import', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const text = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
        if (String(url).includes('/ultra/v1/holdings/')) {
          return text({
            amount: '0',
            uiAmount: 0,
            uiAmountString: '0',
            tokens: {
              BIGMINT1111111111111111111111111111111111: [{ amount: '10000000', uiAmountString: '10', decimals: 6 }],
              DUSTMINT2222222222222222222222222222222222: [{ amount: '1', uiAmountString: '0.000001', decimals: 6 }],
            },
          });
        }
        if (String(url).includes('/tokens/v2/tag')) {
          return text([
            { id: 'BIGMINT1111111111111111111111111111111111', symbol: 'BIG', name: 'Big Token' },
            { id: 'DUSTMINT2222222222222222222222222222222222', symbol: 'DUST', name: 'Dust Token' },
          ]);
        }
        if (String(url).includes('/price/v3')) {
          return text({
            BIGMINT1111111111111111111111111111111111: { usdPrice: 10 },
            DUSTMINT2222222222222222222222222222222222: { usdPrice: 0.01 },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const db = memDb();
    const { imported, skipped_dust } = await importHoldings(db, 'solana', SOL);
    expect(imported.map((i) => i.symbol)).toContain('BIG'); // $100 kept
    expect(imported.map((i) => i.symbol)).not.toContain('DUST'); // ~$0 dropped
    expect(skipped_dust.map((s) => s.symbol)).toContain('DUST');
    expect(db.prepare('SELECT COUNT(*) AS c FROM assets WHERE symbol = ?').get('DUST') as { c: number }).toEqual({ c: 0 });
    db.close();
  });

  it('import auto-fills buy price from market when unknown', async () => {
    stubJupiter();
    const db = memDb();
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source) VALUES ('USDC', 16000, 'manual')`).run();
    await importHoldings(db, 'solana', SOL, ['USDC']);
    const row = db.prepare('SELECT avg_buy_price_idr FROM assets WHERE symbol = ?').get('USDC') as {
      avg_buy_price_idr: number;
    };
    expect(row.avg_buy_price_idr).toBe(16000); // first-seen market price, P/L tracks from sync
    db.close();
  });

  it('jupiter trade cost wins over estimates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const text = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
        if (String(url).includes('/ultra/v1/holdings/')) {
          return text({
            amount: '0', uiAmount: 0, uiAmountString: '0',
            tokens: { MINTAAAA1111111111111111111111111111111111: [{ amount: '2000000', uiAmountString: '2', decimals: 6 }] },
          });
        }
        if (String(url).includes('/tokens/v2/tag')) {
          return text([{ id: 'MINTAAAA1111111111111111111111111111111111', symbol: 'TKNA', name: 'Token A' }]);
        }
        if (String(url).includes('/pnl-positions')) {
          return text({ [SOL]: { tokenPositions: [{ assetId: 'MINTAAAA1111111111111111111111111111111111', averageCost: 5, unrealizedPnl: 10, unrealizedPnlPercentage: 100 }] } });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const db = memDb();
    db.prepare(`INSERT INTO price_cache (symbol, price_idr, source) VALUES ('TKNA', 160000, 'manual')`).run();
    // Existing manual estimate 100000 must be corrected by Jupiter $5 x 16000 = 80000.
    db.prepare(`INSERT INTO assets (type, symbol, qty, avg_buy_price_idr) VALUES ('crypto','TKNA','1',100000)`).run();
    await importHoldings(db, 'solana', SOL, ['TKNA']);
    const row = db.prepare('SELECT avg_buy_price_idr FROM assets WHERE symbol = ?').get('TKNA') as {
      avg_buy_price_idr: number;
    };
    expect(row.avg_buy_price_idr).toBe(80000);
    db.close();
  });

  it('parses LP positions with underlying values', () => {
    const out = parseLpPositions({
      fetcherResults: [
        {
          elements: [
            {
              id: 'meteora-dlmm-X',
              platformId: 'meteora',
              type: 'liquidity',
              label: 'LiquidityPool',
              name: 'DLMM',
              sourceRefs: [{ name: 'Pool', address: 'POOLADDR' }],
              data: {
                assets: [
                  { data: { address: 'MINT1', amount: { raw: '1000000', decimals: 6 }, price: 2 }, value: 2 },
                  { data: { address: 'MINT2', amount: { raw: '500000000', decimals: 9 }, price: 10 }, value: 5 },
                ],
                rewardAssets: [{ data: { address: 'MINT1', amount: { raw: '500000', decimals: 6 }, price: 2 }, value: 1 }],
              },
            },
            { id: 'x', platformId: 'meteora', type: 'staked', label: 'S', name: 'N', data: {} },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].totalUsd).toBeCloseTo(8);
    expect(out[0].assets[0].qty).toBe('1');
    expect(lpSymbol('meteora', 'POOLADDR')).toBe('LP-METEORA-POOL');
  });

  it('lp import sets avg to pool value so P/L tracks since sync', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/portfolio/v2/positions/')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              fetcherResults: [
                {
                  elements: [
                    {
                      id: 'meteora-dlmm-X',
                      platformId: 'meteora',
                      type: 'liquidity',
                      label: 'LiquidityPool',
                      name: 'DLMM',
                      sourceRefs: [{ name: 'Pool', address: 'POOLADDR' }],
                      data: {
                        assets: [{ data: { address: 'M', amount: { raw: '1000000', decimals: 6 }, price: 70 }, value: 70 }],
                        rewardAssets: [],
                      },
                    },
                  ],
                },
              ],
            }),
          };
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const db = memDb();
    const { importLp } = await import('../src/server/services/lpService.js');
    const { imported, removed } = await importLp(db, SOL);
    expect(imported).toHaveLength(1);
    expect(removed).toEqual([]);
    const row = db.prepare('SELECT qty, avg_buy_price_idr FROM assets WHERE symbol = ?').get(imported[0].symbol) as {
      qty: string;
      avg_buy_price_idr: number;
    };
    expect(row.qty).toBe('1');
    expect(row.avg_buy_price_idr).toBeGreaterThan(0);
    db.close();
  });
});
