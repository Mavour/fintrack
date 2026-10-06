import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewHoldings, importHoldings } from '../src/server/services/walletService.js';

const SOL = '3keq3cRtYuoPCYBUL4s6N52ePguGivSZpNU4fzSiPXpd';

function memDb(): Database.Database {
  const db = new Database(':memory:');
  const here = path.dirname(fileURLToPath(import.meta.url));
  db.exec(fs.readFileSync(path.join(here, '..', 'src', 'server', 'db', 'schema.sql'), 'utf-8'));
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
    const imported = await importHoldings(db, 'solana', SOL);
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
    expect(sol.avg_buy_price_idr).toBe(0); // unknown -> P/L hidden
    db.close();
  });
});
